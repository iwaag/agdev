// Summoning (summoner p2, docs/summon.md): a summonplan's projects arrive in
// this installation. Acquisition copies a project (and its submodules) from
// any Git URL into the local Gitea at the plan's commit, fast-forward only,
// with its history; registration and a workspace follow; the roles the plan
// assigns are recorded in <area>/roles.json and the keys they own in the area
// configuration are derived from it. Every step looks at what is there, so a
// repeated or interrupted apply continues.
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { CATALOG_PATH, COMMIT_PATTERN, GITHUB_USER_PATTERN, MIND_REPOSITORY, ROLES, styleCatalogOf, validateCatalog, validateSummonplan, type RoleName, type Summonplan } from '../shared/mind.ts'
import { gitmodules, obtainWorkspace } from './agdev.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git } from './git.ts'
import { Gitea, GiteaError, tokenOf, type GiteaRepo } from './gitea.ts'
import { withLock } from './lock.ts'
import { loadMindSetting, mindSnapshot, type MindContext } from './mind.ts'
import { loadRegistry, recordUpstream, registerRepository, repoKey, RegistryError, type Registry, type RepoCategory } from './registry.ts'
import { sourceRootOf } from './layout.ts'
import { categoryOf, RequestError } from './workspace.ts'
import { parseProject, parseProjectCatalog } from './yamlDoc.ts'
import { registerGiteaProject } from './agdev.ts'

export type SummonContext = MindContext
export interface SummonStep { name: string; status: 'done' | 'kept' | 'would' | 'refused' | 'failed'; detail: string }

const exists = (p: string) => stat(p).then(() => true, () => false)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const short = (c?: string | null) => (c ? c.slice(0, 10) : '—')
const needGitea = (ctx: SummonContext): Gitea => {
  if (!ctx.gitea) throw new RequestError(503, `Gitea is not available: ${ctx.giteaProblem ?? 'no Gitea setting'}`)
  return ctx.gitea
}
const summonDir = (area: string) => join(area, '.local', 'summon')
export const ROLES_FILE = 'roles.json'
export const ROLES_SCHEMA = 'ag.roles.v1'
// The dialogue-renderer contract (docs/summon.md): where the deployment leaves the renderer, relative to the area.
export const DEPLOY_DIR = 'hangout'
export const RENDERER_PATH = `${DEPLOY_DIR}/renderer-current/renderer/render.ts`

// A refusal of one entry: apply goes on with the others.
export class Refusal extends Error {}

// ---- credentials and Git environments ------------------------------------------------

const originOf = (url: string): string | null => { try { const u = new URL(url); return `${u.protocol}//${u.host}` } catch { return null } }

// GIT_CONFIG_* entries of several environments, renumbered into one.
function mergeEnv(...envs: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {}
  let n = 0
  for (const e of envs) {
    const count = Number(e.GIT_CONFIG_COUNT ?? 0)
    for (let i = 0; i < count; i++) { out[`GIT_CONFIG_KEY_${n}`] = e[`GIT_CONFIG_KEY_${i}`]; out[`GIT_CONFIG_VALUE_${n}`] = e[`GIT_CONFIG_VALUE_${i}`]; n++ }
    for (const [k, v] of Object.entries(e)) if (!k.startsWith('GIT_CONFIG_')) out[k] = v
  }
  out.GIT_CONFIG_COUNT = String(n)
  out.GIT_TERMINAL_PROMPT = '0'
  return out
}

const installationRoot = (area: string) => process.env.AGDEV_ROOT || resolve(area, '..', '..')

// The credential that reads `url`: this Gitea's own token for its own URLs,
// else an active inventory entry (gitea-token / token, stored as a file)
// whose target has the same origin; none for anything else.
export async function sourceEnv(ctx: SummonContext, url: string): Promise<{ env: Record<string, string>; credential: string }> {
  const g = needGitea(ctx)
  const origin = originOf(url)
  if (!origin) return { env: {}, credential: 'none' }
  if (origin === originOf(g.url)) return { env: await g.gitEnv(), credential: 'this Gitea\'s own' }
  const file = join(installationRoot(ctx.area), 'config', 'credentials.json')
  const text = await readTextOrNull(file).catch(() => null)
  if (text) {
    let inv: unknown
    try { inv = JSON.parse(text) } catch { inv = null }
    const creds = isObj(inv) && isObj(inv.credentials) ? inv.credentials : {}
    for (const [id, c] of Object.entries(creds)) {
      if (!isObj(c) || !['gitea-token', 'token'].includes(String(c.type)) || (c.status ?? 'active') !== 'active' || typeof c.target !== 'string' || originOf(c.target) !== origin) continue
      const s = isObj(c.storage) ? c.storage : {}
      const path = typeof s.path === 'string' ? s.path : typeof s.file === 'string' ? s.file : null
      if (s.kind !== 'file' || !path) continue
      const raw = await readFile(path, 'utf8').catch(() => null)
      if (raw === null) throw new Refusal(`the credential ${id} for ${origin} names ${path}, which cannot be read`)
      const token = tokenOf(raw, path)
      return { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: token ${token}` }, credential: id }
    }
  }
  return { env: {}, credential: 'none' }
}

// ---- mirrors -----------------------------------------------------------------------

export function mirrorPath(area: string, url: string): string {
  let host = 'local', path = url
  const m = /^[a-z+]+:\/\/([^/]+)(\/.*)$/.exec(url)
  if (m) { host = m[1].replace(/^[^@]*@/, ''); path = m[2] }
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_')
  const parts = path.split('/').filter(Boolean).map(safe)
  const last = (parts.pop() ?? 'repo').replace(/\.git$/, '')
  return join(summonDir(area), 'mirrors', safe(host), ...parts, `${last}.git`)
}
export const repositoryName = (url: string): string => {
  const last = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? ''
  return last.replace(/\.git$/, '')
}

// Fetches every branch of `url` into its mirror, at most once per apply.
async function fetchMirror(ctx: SummonContext, url: string, fetched: Set<string>): Promise<string> {
  const dir = mirrorPath(ctx.area, url)
  if (fetched.has(dir)) return dir
  await mkdir(dirname(dir), { recursive: true })
  if (!await exists(join(dir, 'HEAD'))) {
    const r = await git(tmpdir(), ['init', '--bare', '-q', dir])
    if (r.code !== 0) throw new Error(`cannot create the mirror ${dir}: ${r.stderr.trim()}`)
  }
  const { env } = await sourceEnv(ctx, url)
  const f = await git(dir, ['fetch', '--prune', '-q', '--', url, '+refs/heads/*:refs/heads/*'], { env: mergeEnv(env), timeoutMs: 900_000 })
  if (f.code !== 0) throw new Refusal(`fetching ${url} failed: ${f.stderr.trim().split('\n').slice(-2).join(' ')}`)
  fetched.add(dir)
  return dir
}

// ---- acquisition --------------------------------------------------------------------

export interface AcquireOptions { dry: boolean; name?: string; fetched: Set<string>; seen: Map<string, AcquiredRepo> }
export interface AcquiredRepo {
  url: string; commit: string; name: string; path: string; category: RepoCategory
  repo: GiteaRepo | null // null: a dry run of an absent repository
  action: 'create' | 'move' | 'kept' | 'ahead'
  submodules: AcquiredRepo[]
}

async function localHead(ctx: SummonContext, owner: string, name: string): Promise<string | null> {
  const g = needGitea(ctx)
  const r = await git(tmpdir(), ['ls-remote', '--', g.cloneUrl(owner, name), 'refs/heads/main'], { env: await g.gitEnv(), timeoutMs: 60_000 })
  if (r.code !== 0) throw new Error(`reading ${owner}/${name} on ${g.url} failed: ${r.stderr.trim()}`)
  return r.stdout.trim().split(/\s/)[0] || null
}

const isAncestor = async (dir: string, a: string, b: string) => (await git(dir, ['merge-base', '--is-ancestor', a, b])).code === 0

// Where `head` stands relative to `commit` in the mirror (local objects fetched when needed).
async function relation(ctx: SummonContext, mirror: string, owner: string, name: string, head: string, commit: string): Promise<'equal' | 'behind' | 'ahead' | { diverged: string } | 'unrelated'> {
  if (head === commit) return 'equal'
  if ((await git(mirror, ['cat-file', '-e', `${head}^{commit}`])).code !== 0) {
    const g = needGitea(ctx)
    const f = await git(mirror, ['fetch', '-q', '--', g.cloneUrl(owner, name), `+refs/heads/main:refs/summon-local/${owner}/${name}`], { env: await g.gitEnv(), timeoutMs: 600_000 })
    if (f.code !== 0) throw new Error(`fetching the local ${owner}/${name} failed: ${f.stderr.trim()}`)
  }
  if (await isAncestor(mirror, head, commit)) return 'behind'
  if (await isAncestor(mirror, commit, head)) return 'ahead'
  const base = await git(mirror, ['merge-base', head, commit])
  return base.code === 0 && base.stdout.trim() ? { diverged: base.stdout.trim() } : 'unrelated'
}

// A submodule URL relative to its superproject's source, as Git resolves it.
// Only ../<name>.git (same owner) is accepted: under the local owner it must resolve again.
function submoduleSource(source: string, url: string, path: string): string {
  if (!/^\.\.\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(url)) throw new Refusal(`submodule ${path} has URL "${url}", which would not resolve after acquisition (only ../<name>.git, beside its superproject, is acquired)`)
  if (/^[a-z+]+:\/\//.test(source)) return new URL(url, source.replace(/\/*$/, '/')).toString()
  if (source.startsWith('/')) return posix.join(source, url)
  throw new Refusal(`cannot resolve submodule ${path} (${url}) against ${source}`)
}

// Acquires `url` at `commit` into <owner>/<name> on this Gitea, then its
// submodules at the commits it pins. Fast-forward only.
export async function acquire(ctx: SummonContext, src: { url: string; commit: string; path?: string; project?: string }, o: AcquireOptions, steps: SummonStep[]): Promise<AcquiredRepo> {
  const g = needGitea(ctx)
  if (!COMMIT_PATTERN.test(src.commit)) throw new Refusal(`"${src.commit}" is not a full commit id (40 hex)`)
  const name = o.name ?? repositoryName(src.url)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new Refusal(`"${name}" (from ${src.url}) is not a repository name`)
  const key = `${name}@${src.commit}`
  const known = o.seen.get(key)
  if (known) return known
  const path = src.path ?? '.'
  const mirror = await fetchMirror(ctx, src.url, o.fetched)
  if ((await git(mirror, ['cat-file', '-e', `${src.commit}^{commit}`])).code !== 0) throw new Refusal(`${src.url} has no commit ${src.commit} (on any branch)`)
  if (src.project) {
    const pt = await git(mirror, ['show', `${src.commit}:project.yaml`])
    const parsed = pt.code === 0 ? parseProject(pt.stdout) : null
    if (!parsed?.ok) throw new Refusal(`${src.url} at ${short(src.commit)} has no readable project.yaml; it is not a project root`)
    if (parsed.model.id !== src.project) throw new Refusal(`${src.url} at ${short(src.commit)} is project "${parsed.model.id}", not "${src.project}"`)
  }
  const label = `${g.owner}/${name}`
  let repo = await g.repo(g.owner, name)
  const head = repo ? await localHead(ctx, g.owner, name) : null
  let action: AcquiredRepo['action']
  if (!head) {
    action = 'create'
    if (o.dry) steps.push({ name: `acquire ${label}`, status: 'would', detail: `${repo ? 'push to the empty' : 'create'} ${label} at ${short(src.commit)} from ${src.url}` })
    else {
      repo ??= await g.createRepo(name, `acquired from ${src.url}`)
      const p = await git(mirror, ['push', '-q', '--', g.cloneUrl(g.owner, name), `${src.commit}:refs/heads/main`], { env: await g.gitEnv(), timeoutMs: 900_000 })
      if (p.code !== 0) throw new Error(`pushing ${short(src.commit)} to ${label} failed: ${p.stderr.trim()}`)
      steps.push({ name: `acquire ${label}`, status: 'done', detail: `main at ${short(src.commit)} with its history, from ${src.url}` })
    }
  } else {
    const rel = await relation(ctx, mirror, g.owner, name, head, src.commit)
    if (rel === 'equal') { action = 'kept'; steps.push({ name: `acquire ${label}`, status: 'kept', detail: `main is ${short(src.commit)}` }) }
    else if (rel === 'ahead') { action = 'ahead'; steps.push({ name: `acquire ${label}`, status: 'kept', detail: `main ${short(head)} already contains ${short(src.commit)} (local work after it)` }) }
    else if (rel === 'behind') {
      action = 'move'
      if (o.dry) steps.push({ name: `move ${label}`, status: 'would', detail: `fast-forward main ${short(head)} → ${short(src.commit)}` })
      else {
        const p = await git(mirror, ['push', '-q', '--', g.cloneUrl(g.owner, name), `${src.commit}:refs/heads/main`], { env: await g.gitEnv(), timeoutMs: 900_000 })
        if (p.code !== 0) throw new Error(`fast-forwarding ${label} to ${short(src.commit)} failed: ${p.stderr.trim()}`)
        steps.push({ name: `move ${label}`, status: 'done', detail: `main ${short(head)} → ${short(src.commit)} (fast-forward)` })
      }
    } else if (rel === 'unrelated') throw new Refusal(`${label} exists here with history unrelated to ${src.url}; nothing was changed. Another name, or removing it, is a person's decision`)
    else throw new Refusal(`${label} main ${short(head)} and the plan's ${short(src.commit)} diverged from ${short(rel.diverged)}; apply only fast-forwards. Merge them (a person's or an agent's work), then name the merged commit in the plan`)
  }
  const out: AcquiredRepo = { url: src.url, commit: src.commit, name, path, category: path === '.' ? 'root' : categoryOf(path), repo, action, submodules: [] }
  o.seen.set(key, out)
  // Submodules, at the commits this one pins.
  const gm = await git(mirror, ['show', `${src.commit}:.gitmodules`])
  if (gm.code === 0) {
    for (const m of gitmodules(gm.stdout)) {
      const t = await git(mirror, ['ls-tree', src.commit, '--', m.path])
      const pin = /^160000 commit ([0-9a-f]{40})\t/.exec(t.stdout)
      if (!pin) { steps.push({ name: `submodule ${m.path}`, status: 'kept', detail: 'no gitlink at this commit; not acquired' }); continue }
      out.submodules.push(await acquire(ctx, { url: submoduleSource(src.url, m.url, m.path), commit: pin[1], path: m.path }, { ...o, name: undefined }, steps))
    }
  }
  return out
}

// Registers what acquire() put on Gitea and records each repository's upstream.
async function registerAcquired(ctx: SummonContext, a: AcquiredRepo, steps: SummonStep[], project?: string): Promise<void> {
  const g = needGitea(ctx)
  for (const s of a.submodules) await registerAcquired(ctx, s, steps)
  const repo = a.repo ?? await g.repo(g.owner, a.name)
  if (!repo) throw new Error(`${g.owner}/${a.name} is not on Gitea after acquisition`)
  if (a.category === 'root') {
    if (!project) throw new Error('a root repository is registered with its project')
    const reg = await loadRegistry(ctx.registryFile)
    const has = reg.projects.find(p => p.id === project)
    if (has && has.root !== repoKey(repo.id)) throw new Refusal(`project "${project}" is already registered with another root repository (${has.root}); nothing was registered`)
    if (!has) {
      const r = await registerGiteaProject(ctx, repo.owner, repo.name)
      steps.push({ name: `register ${project}`, status: 'done', detail: r.message })
    } else steps.push({ name: `register ${project}`, status: 'kept', detail: 'registered' })
  } else {
    try {
      const r = await registerRepository(ctx.registryFile, repo, a.category)
      if (r.status === 'registered') steps.push({ name: `register ${repo.fullName}`, status: 'done', detail: a.category })
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e
      steps.push({ name: `register ${repo.fullName}`, status: 'kept', detail: e.message })
    }
  }
  if (await recordUpstream(ctx.registryFile, repoKey(repo.id), { url: a.url, commit: a.commit })) steps.push({ name: `upstream ${repo.fullName}`, status: 'done', detail: `${a.url} @ ${short(a.commit)}` })
}

// One repository acquired on its own (`wfe summon acquire`): no plan, no roles.
export async function acquireOne(ctx: SummonContext, o: { url: string; commit: string; name?: string; register?: boolean; project?: string; dry?: boolean }) {
  const steps: SummonStep[] = []
  try {
    const a = await acquire(ctx, { url: o.url, commit: o.commit, project: o.project }, { dry: !!o.dry, name: o.name, fetched: new Set(), seen: new Map() }, steps)
    if (o.register && !o.dry) await registerAcquired(ctx, a, steps, o.project)
    return { ok: true, message: `${needGitea(ctx).owner}/${a.name}: ${a.action}`, steps, acquired: a }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, message: `refused: ${e.message}`, steps }
    throw e
  }
}

// ---- the plan ------------------------------------------------------------------------

async function loadPlan(ctx: SummonContext, name?: string): Promise<{ plan: Summonplan; head: string; owner: string }> {
  const snap = await mindSnapshot(ctx, { maxAgeMs: 0 })
  const want = name || snap.setting.plan
  if (!want) throw new RequestError(400, 'no plan named, and mind.json names none (wfe mind plan use <name>)')
  const p = snap.plans.find(x => x.name === want)
  if (!p) throw new RequestError(404, `no summonplan "${want}" in the mind repository (${snap.plans.map(x => x.name).join(', ') || 'none yet'})`)
  if (!p.plan) throw new RequestError(400, `summonplan ${want} cannot be read: ${p.problem}`)
  const errors = validateSummonplan(p.plan, { braindumps: snap.braindumps.map(b => b.path) }, want).filter(i => i.severity === 'error')
  if (errors.length) throw new RequestError(400, `summonplan ${want} has errors; nothing was applied:\n${errors.map(i => `  ${i.code}: ${i.message}`).join('\n')}`)
  return { plan: p.plan, head: snap.head, owner: snap.mind.doc?.owner || needGitea(ctx).owner }
}

const workspaceOf = (reg: Registry, project: string) => reg.workspaces.find(w => w.project === project && w.id === project) ?? reg.workspaces.find(w => w.project === project)

// ---- roles ---------------------------------------------------------------------------

export interface RoleHolder { project: string; workspace: string; workflow?: string }
export interface RolesDoc { schema: string; plan: string; mind: string; applied: string; roles: Partial<Record<RoleName, RoleHolder>> }

export async function loadRoles(area: string): Promise<RolesDoc | null> {
  const t = await readTextOrNull(join(area, ROLES_FILE))
  if (t === null) return null
  try { const o = JSON.parse(t) as RolesDoc; return isObj(o) && isObj(o.roles) ? o : null } catch { return null }
}

// Who fills what, from the plan and the workspaces (present, or about to be obtained).
function resolveRoles(plan: Summonplan, reg: Registry, willObtain: Set<string>): { roles: RolesDoc['roles']; problems: string[] } {
  const roles: RolesDoc['roles'] = {}
  const problems: string[] = []
  for (const e of plan.entries) {
    for (const [role, v] of Object.entries(e.roles) as [RoleName, string | true][]) {
      const ws = workspaceOf(reg, e.project)?.id ?? (willObtain.has(e.project) ? e.project : null)
      if (!ws) { problems.push(`role ${role}: ${e.project} has no workspace here; the role stays unfilled`); continue }
      roles[role] = { project: e.project, workspace: ws, ...(ROLES[role].kind === 'workflow' ? { workflow: v as string } : {}) }
    }
  }
  return { roles, problems }
}

interface FileChange { file: string; before: unknown; after: unknown; changed: boolean; keys: string[] }
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const t = await readTextOrNull(file)
  if (t === null) return null
  try { const o = JSON.parse(t); return isObj(o) ? o : null } catch (e) { throw new RequestError(500, `${file} is not valid JSON (${(e as Error).message}); fix it first`) }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function setKey(o: Record<string, unknown>, k: string, v: unknown, keys: string[]) {
  if (v === undefined) { if (k in o) { delete o[k]; keys.push(`-${k}`) } return }
  if (!same(o[k], v)) { o[k] = v; keys.push(k) }
}

// The keys the roles own in the area's configuration, derived from `roles`;
// every other key is kept. `participants`: summoned projects to add to
// conversations.json projects.
async function deriveFiles(area: string, roles: RolesDoc['roles'], person: string, participants: { workspace: string; converse: string | null; discuss: string | null }[]): Promise<FileChange[]> {
  const out: FileChange[] = []
  // workers.json coordination
  {
    const file = join(area, 'workers.json')
    const before = await readJson(file)
    if (before) {
      const after = structuredClone(before)
      const keys: string[] = []
      const c = roles.coordination
      const cur = isObj(before.coordination) ? before.coordination : {}
      setKey(after, 'coordination', c ? { worker: typeof cur.worker === 'string' ? cur.worker : before.default, lane: typeof cur.lane === 'string' ? cur.lane : 'coordination', workspace: c.workspace, workflow: c.workflow } : undefined, keys)
      out.push({ file, before, after, changed: keys.length > 0, keys })
    } else if (roles.coordination) out.push({ file, before: null, after: null, changed: false, keys: ['(workers.json is missing: coordination is not wired)'] })
  }
  // conversations.json facilitator, archive, dialogue.renderer, projects (additions)
  {
    const file = join(area, 'conversations.json')
    const before = await readJson(file)
    const needed = roles.facilitation || roles['conversation-archive'] || roles['dialogue-renderer'] || participants.length
    if (before || needed) {
      const after: Record<string, unknown> = before ? structuredClone(before) : { person, projects: [] }
      const keys: string[] = before ? [] : ['(created)']
      const f = roles.facilitation, a = roles['conversation-archive'], d = roles['dialogue-renderer']
      setKey(after, 'facilitator', f ? { workspace: f.workspace, workflow: f.workflow } : undefined, keys)
      setKey(after, 'archive', a ? { workspace: a.workspace } : undefined, keys)
      const dialogue = isObj(after.dialogue) ? { ...after.dialogue } : {}
      if (d) dialogue.renderer = RENDERER_PATH
      else delete dialogue.renderer
      setKey(after, 'dialogue', Object.keys(dialogue).length ? dialogue : undefined, keys)
      const projects = Array.isArray(after.projects) ? [...after.projects as Record<string, unknown>[]] : []
      for (const p of participants) {
        if (projects.some(x => x?.workspace === p.workspace)) continue
        projects.push({ workspace: p.workspace, ...(p.converse ? { converse: p.converse } : {}), ...(p.discuss ? { discuss: p.discuss } : {}) })
        keys.push(`projects+${p.workspace}`)
      }
      after.projects = projects
      out.push({ file, before, after, changed: keys.length > 0, keys })
    }
  }
  // submitters.json: the Observer's recovery workflow
  {
    const file = join(area, 'submitters.json')
    const before = await readJson(file)
    const r = roles.recovery
    if (before || r) {
      const after: Record<string, unknown> = before ? structuredClone(before) : { version: 1, submitters: [] }
      const keys: string[] = []
      const list = (Array.isArray(after.submitters) ? after.submitters : []) as Record<string, unknown>[]
      const i = list.findIndex(s => s?.name === 'Observer')
      const want = r ? { name: 'Observer', workflows: [`${r.project}/${r.workflow}`] } : null
      if (want && i < 0) { list.push(want); keys.push('Observer') }
      else if (want && !same(list[i].workflows, want.workflows)) { list[i] = { ...list[i], workflows: want.workflows }; keys.push('Observer') }
      else if (!want && i >= 0) { list.splice(i, 1); keys.push('-Observer') }
      after.submitters = list
      out.push({ file, before, after, changed: keys.length > 0, keys })
    }
  }
  return out
}

// ---- role deployments (conversation-page, dialogue-renderer) -------------------------

function runDeploy(cwd: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise(res => {
    const child = spawn('sh', ['scripts/deploy.sh'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), 1_200_000)
    child.on('close', code => { clearTimeout(timer); res({ code: code ?? 1, out }) })
  })
}

// ---- apply ---------------------------------------------------------------------------

export interface EntryReport { project: string; state: string; commit: string; status: 'done' | 'nothing' | 'pending' | 'refused' | 'failed'; actions: string[]; steps: SummonStep[]; problem?: string }
export interface ApplyReport {
  ok: boolean; dryRun: boolean; plan: string; mind: string; continued?: string
  entries: EntryReport[]
  roles: { roles: RolesDoc['roles']; changed: boolean; problems: string[] }
  files: { file: string; changed: boolean; keys: string[] }[]
  deployments: SummonStep[]
  observer: string | null // what the observer does about a changed recovery role (it follows roles.json itself)
  message: string
}

const journalFile = (area: string) => join(summonDir(area), 'journal.json')
interface Journal { schema: 'ag.summon-journal.v1'; plan: string; mind: string; started: string; finished?: string; entries: Record<string, { status: EntryReport['status']; at: string; steps: SummonStep[]; problem?: string }> }

async function fastForwardWorkspace(ctx: SummonContext, path: string, steps: SummonStep[], label: string) {
  const g = needGitea(ctx)
  const src = sourceRootOf(path)
  const branch = (await git(src, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
  const dirty = (await git(src, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()
  if (branch !== 'main' || dirty) { steps.push({ name: `workspace ${label}`, status: 'kept', detail: `not moved: ${branch !== 'main' ? `on ${branch || 'a detached HEAD'}` : 'local changes'}; update it by hand` }); return }
  const env = await g.gitEnv()
  const f = await git(src, ['pull', '-q', '--ff-only', 'origin', 'main'], { env, timeoutMs: 600_000 })
  if (f.code !== 0) { steps.push({ name: `workspace ${label}`, status: 'failed', detail: `fast-forward failed: ${f.stderr.trim().slice(0, 300)}` }); return }
  await git(src, ['submodule', 'update', '--init', '--recursive'], { env, timeoutMs: 600_000 })
  steps.push({ name: `workspace ${label}`, status: 'done', detail: `fast-forwarded to ${short((await git(src, ['rev-parse', 'HEAD'])).stdout.trim())}` })
}

const hasWorkflow = (root: string, id: string) => exists(join(root, 'devdocs', 'workflows', `${id}.yaml`))

export async function apply(ctx: SummonContext, o: { plan?: string; dryRun?: boolean } = {}): Promise<ApplyReport> {
  const dry = !!o.dryRun
  const { plan, head, owner } = await loadPlan(ctx, o.plan)
  return withLock(journalFile(ctx.area), async () => {
    await mkdir(summonDir(ctx.area), { recursive: true })
    let journal: Journal | null = null
    let continued: string | undefined
    if (!dry) {
      const prev = await readJson(journalFile(ctx.area)) as Journal | null
      if (prev && !prev.finished && prev.plan === plan.name) { journal = prev; continued = prev.started; journal.mind = head }
      else journal = { schema: 'ag.summon-journal.v1', plan: plan.name, mind: head, started: new Date().toISOString(), entries: {} }
      await atomicWrite(journalFile(ctx.area), `${JSON.stringify(journal, null, 1)}\n`)
    }
    const fetched = new Set<string>(), seen = new Map<string, AcquiredRepo>()
    const entries: EntryReport[] = []
    const touched = new Set<string>() // projects obtained or moved in this apply
    const participants: { workspace: string; converse: string | null; discuss: string | null }[] = []
    const willObtain = new Set<string>()
    for (const e of plan.entries) {
      const steps: SummonStep[] = []
      const r: EntryReport = { project: e.project, state: e.state, commit: e.commit, status: 'nothing', actions: [], steps }
      try {
        let reg = await loadRegistry(ctx.registryFile)
        if (e.state === 'summoned') {
          const a = await acquire(ctx, { url: e.source, commit: e.commit, project: e.project }, { dry, fetched, seen }, steps)
          const all = (x: AcquiredRepo): AcquiredRepo[] => [x, ...x.submodules.flatMap(all)]
          if (all(a).some(x => x.action === 'create')) r.actions.push('acquire')
          if (all(a).some(x => x.action === 'move')) r.actions.push('move')
          const registered = reg.projects.some(p => p.id === e.project)
          if (!registered) r.actions.push('register')
          if (!dry) await registerAcquired(ctx, a, steps, e.project)
          else if (!registered) steps.push({ name: `register ${e.project}`, status: 'would', detail: `project ${e.project} and its repositories, with upstream ${short(e.commit)}` })
          reg = await loadRegistry(ctx.registryFile)
          const ws = workspaceOf(reg, e.project)
          if (!ws) {
            r.actions.push('obtain')
            willObtain.add(e.project)
            if (dry) steps.push({ name: `obtain ${e.project}`, status: 'would', detail: 'a workspace cloned from this Gitea' })
            else {
              const ob = await obtainWorkspace(ctx, e.project)
              steps.push({ name: `obtain ${e.project}`, status: 'done', detail: ob.message })
              touched.add(e.project)
            }
          } else if (a.action === 'move') {
            if (dry) { steps.push({ name: `workspace ${ws.id}`, status: 'would', detail: 'fast-forward its checkout if it is clean and on main' }); willObtain.add(e.project) }
            else { await fastForwardWorkspace(ctx, ws.path, steps, ws.id); touched.add(e.project) }
          }
          // Conversation participation follows the workflows a summoned project has.
          const now = workspaceOf(await loadRegistry(ctx.registryFile), e.project)
          if (now || dry) {
            const root = now ? sourceRootOf(now.path) : ''
            const converse = now ? (await hasWorkflow(root, 'converse') ? 'converse' : null) : null
            const discuss = now ? (await hasWorkflow(root, 'discuss') ? 'discuss' : null) : null
            if (converse || discuss) participants.push({ workspace: now!.id, converse, discuss })
          }
        } else {
          // adopted: never fetched; its registered project and workspace serve the roles.
          if (!reg.projects.some(p => p.id === e.project)) steps.push({ name: e.project, status: 'kept', detail: 'adopted, but not registered here' })
          else if (!workspaceOf(reg, e.project) && Object.keys(e.roles).length) steps.push({ name: e.project, status: 'kept', detail: 'adopted, but no workspace here: its roles stay unfilled' })
        }
        r.status = r.actions.length ? (dry ? 'pending' : 'done') : 'nothing'
      } catch (err) {
        if (err instanceof Refusal || err instanceof RequestError || err instanceof GiteaError) { r.status = 'refused'; r.problem = err.message; steps.push({ name: e.project, status: 'refused', detail: err.message }) }
        else { r.status = 'failed'; r.problem = (err as Error).message; steps.push({ name: e.project, status: 'failed', detail: (err as Error).message }) }
      }
      entries.push(r)
      if (journal) {
        // A continued apply keeps what the interrupted one did: an entry it finished stays done when nothing was left.
        const before = journal.entries[e.project]
        journal.entries[e.project] = before?.status === 'done' && r.status === 'nothing' ? { ...before, checked: new Date().toISOString() } as never : { status: r.status, at: new Date().toISOString(), steps, ...(r.problem ? { problem: r.problem } : {}) }
        await atomicWrite(journalFile(ctx.area), `${JSON.stringify(journal, null, 1)}\n`)
      }
    }
    // Roles, from the plan and the workspaces now present.
    const reg = await loadRegistry(ctx.registryFile)
    const { roles, problems } = resolveRoles(plan, reg, dry ? willObtain : new Set())
    const prevRoles = await loadRoles(ctx.area)
    const rolesChanged = !same(prevRoles?.roles ?? null, roles) || prevRoles?.plan !== plan.name
    const files = await deriveFiles(ctx.area, roles, owner, participants)
    for (const e of entries) {
      const mine = Object.entries(roles).filter(([, h]) => h?.project === e.project).map(([k]) => k)
      const before = Object.entries(prevRoles?.roles ?? {}).filter(([, h]) => h?.project === e.project).map(([k]) => k)
      if (!same(mine.sort(), before.sort()) || (mine.length && rolesChanged && !prevRoles)) e.actions.push('role')
    }
    // Role deployments: once per project filling conversation-page or dialogue-renderer.
    const deployments: SummonStep[] = []
    const deployers = new Set([roles['conversation-page']?.project, roles['dialogue-renderer']?.project].filter((x): x is string => !!x))
    const deployDir = join(ctx.area, DEPLOY_DIR)
    for (const project of deployers) {
      const ws = workspaceOf(reg, project) ?? (dry && willObtain.has(project) ? { id: project, path: '' } : undefined)
      if (!ws) continue
      const needed = touched.has(project) || willObtain.has(project) || !await exists(join(deployDir, 'current'))
      if (!needed) continue
      entries.find(e => e.project === project)?.actions.push('deploy')
      if (dry) { deployments.push({ name: `deploy ${project}`, status: 'would', detail: `scripts/deploy.sh with AGDEV_DEPLOY_DIR=${deployDir}` }); continue }
      const src = sourceRootOf(ws.path)
      if (!await exists(join(src, 'scripts', 'deploy.sh'))) { deployments.push({ name: `deploy ${project}`, status: 'failed', detail: `${project} fills ${[...Object.entries(roles)].filter(([, h]) => h?.project === project).map(([k]) => k).join(', ')} but has no scripts/deploy.sh (docs/summon.md, role contract)` }); continue }
      await mkdir(deployDir, { recursive: true })
      const d = await runDeploy(src, { AGDEV_DEPLOY_DIR: deployDir })
      const last = d.out.trim().split('\n').slice(-2).join(' | ').slice(0, 300)
      deployments.push({ name: `deploy ${project}`, status: d.code === 0 ? 'done' : 'failed', detail: d.code === 0 ? last : `exit ${d.code}: ${last}` })
    }
    if (!dry) {
      if (rolesChanged || !prevRoles) {
        const doc: RolesDoc = { schema: ROLES_SCHEMA, plan: plan.name, mind: head, applied: new Date().toISOString(), roles }
        await atomicWrite(join(ctx.area, ROLES_FILE), `${JSON.stringify(doc, null, 1)}\n`)
      }
      for (const f of files) if (f.changed && f.after) await atomicWrite(f.file, `${JSON.stringify(f.after, null, 1)}\n`)
    }
    for (const e of entries) if (e.status === 'nothing' && e.actions.length) e.status = dry ? 'pending' : 'done'
    const recoveryChanged = !same(prevRoles?.roles?.recovery ?? null, roles.recovery ?? null) || !same(prevRoles?.roles?.coordination ?? null, roles.coordination ?? null) || !prevRoles
    const observer = recoveryChanged ? `the observer takes the recovery role from ${ROLES_FILE} at its next look (no restart)` : null
    const bad = entries.filter(e => e.status === 'refused' || e.status === 'failed').length + deployments.filter(d => d.status === 'failed').length
    if (journal && !dry) {
      journal.finished = new Date().toISOString()
      await atomicWrite(journalFile(ctx.area), `${JSON.stringify(journal, null, 1)}\n`)
      await rename(journalFile(ctx.area), join(summonDir(ctx.area), 'last.json'))
    }
    const changing = entries.filter(e => e.actions.length).length
    return {
      ok: bad === 0, dryRun: dry, plan: plan.name, mind: head, ...(continued ? { continued } : {}),
      entries, roles: { roles, changed: rolesChanged, problems }, files: files.map(f => ({ file: f.file, changed: f.changed, keys: f.keys })), deployments, observer,
      message: `${dry ? 'Would apply' : 'Applied'} summonplan ${plan.name} (mind ${short(head)}): ${changing} of ${entries.length} entries ${dry ? 'would change' : 'changed'}${bad ? `, ${bad} refused or failed` : ''}; roles ${rolesChanged ? (dry ? 'would change' : 'written') : 'unchanged'}; ${files.filter(f => f.changed).length} configuration file(s) ${dry ? 'would change' : 'changed'}.`,
    }
  }, { what: 'a summon apply', timeoutMs: 2_000 })
}

// ---- status --------------------------------------------------------------------------

export type Applied = 'applied' | 'adopted' | 'ahead' | 'differs' | 'absent' | 'unwired'
export interface EntryStatus {
  project: string; state: string; commit: string; present: string | null; repository: string | null
  upstream: { url: string; commit: string; at?: string } | null
  workspace: string | null; roles: { planned: string[]; inEffect: string[] }
  applied: Applied; detail: string
}

export async function status(ctx: SummonContext, o: { plan?: string } = {}) {
  const g = needGitea(ctx)
  const roles = await loadRoles(ctx.area)
  const filled = Object.fromEntries((Object.keys(ROLES) as RoleName[]).map(r => [r, roles?.roles?.[r] ?? null]))
  const rolesFile = roles ? { plan: roles.plan, mind: roles.mind, applied: roles.applied } : null
  // An installation with no mind repository or no plan yet: nothing is summoned, and no role is filled unless roles.json says so.
  if (!o.plan && !(await loadMindSetting(ctx.area))?.plan) return { plan: null, mind: null, rolesFile, roles: filled, entries: [] as EntryStatus[], journal: null, note: 'no summonplan is applied here yet (agdevctl bootstrap-projects --plan <file>, or wfe mind init and wfe summon apply)' }
  const { plan, head } = await loadPlan(ctx, o.plan)
  const reg = await loadRegistry(ctx.registryFile)
  const entries: EntryStatus[] = await Promise.all(plan.entries.map(async (e): Promise<EntryStatus> => {
    const project = reg.projects.find(p => p.id === e.project)
    const root = project ? reg.repositories.find(r => r.key === project.root) : undefined
    const owner = root?.gitea.owner ?? g.owner, name = root?.gitea.name ?? repositoryName(e.source)
    const present = await localHead(ctx, owner, name).catch(() => null)
    const ws = workspaceOf(reg, e.project)
    const planned = Object.keys(e.roles).sort()
    const inEffect = Object.entries(roles?.roles ?? {}).filter(([, h]) => h?.project === e.project).map(([k]) => k).sort()
    let applied: Applied, detail: string
    if (!project || !present) { applied = 'absent'; detail = !present ? `${owner}/${name} is not on this Gitea` : 'not registered' }
    else if (!ws) { applied = 'absent'; detail = 'no workspace here' }
    else if (!same(planned, inEffect)) { applied = 'unwired'; detail = `roles planned ${planned.join(', ') || 'none'}, in effect ${inEffect.join(', ') || 'none'}` }
    else if (e.state === 'adopted') { applied = 'adopted'; detail = present === e.commit ? 'at the described commit' : `main ${short(present)} (described at ${short(e.commit)})` }
    else if (present === e.commit) { applied = 'applied'; detail = `main is ${short(e.commit)}` }
    else {
      // The local main is fetched into the mirror (never the source) to compare it with the plan's commit.
      const mirror = mirrorPath(ctx.area, e.source)
      const rel = await exists(mirror) && (await git(mirror, ['cat-file', '-e', `${e.commit}^{commit}`])).code === 0 ? await relation(ctx, mirror, owner, name, present, e.commit).catch(() => null) : null
      applied = rel === 'ahead' ? 'ahead' : 'differs'
      detail = rel === 'ahead' ? `main ${short(present)} contains ${short(e.commit)} (local work after it)`
        : rel === 'behind' ? `main ${short(present)} is behind the plan's ${short(e.commit)}: apply moves it`
          : rel === 'unrelated' ? `main ${short(present)} is unrelated to the plan's ${short(e.commit)}`
            : rel && typeof rel === 'object' ? `main ${short(present)} and the plan's ${short(e.commit)} diverged from ${short(rel.diverged)}: apply refuses`
              : `main ${short(present)}, plan ${short(e.commit)} (not compared: the source is not mirrored here)`
    }
    return { project: e.project, state: e.state, commit: e.commit, present, repository: `${owner}/${name}`, upstream: root?.upstream ?? null, workspace: ws?.id ?? null, roles: { planned, inEffect }, applied, detail }
  }))
  return { plan: plan.name as string | null, mind: head as string | null, rolesFile, roles: filled, entries, journal: await readJson(journalFile(ctx.area)).catch(() => null), note: '' }
}

// ---- importing a development style (summoner p5 ex1) ------------------------------

// The project and workflow that turn a wish into a proposal: the summoner the
// core's bootstrap reference brings (install/bootstrap/summonplan.yaml).
export const SUMMONER = { project: 'summoner', workflow: 'propose' } as const

// What `wfe summon style <github user>` hands the summoner: the user's public
// catalog <STYLE_HOST>/<user>/mycatalog, read at its main now and pinned to
// that commit, and a wish to reproduce that user's development style. Only a
// proposal follows; nothing is acquired before a person agrees in the run.
export async function styleRequest(ctx: SummonContext, o: { user: string }) {
  const user = o.user.trim().replace(/^@/, '')
  if (!GITHUB_USER_PATTERN.test(user)) throw new RequestError(400, `"${o.user}" is not a GitHub user name`)
  const repo = styleCatalogOf(user)
  const r = await git(tmpdir(), ['ls-remote', '--', `${repo}.git`, 'refs/heads/main'], { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 60_000 })
  const commit = r.code === 0 ? r.stdout.split(/\s/)[0] : ''
  if (!COMMIT_PATTERN.test(commit)) throw new RequestError(404, `${user} has no public ${MIND_REPOSITORY} on GitHub (${repo}, branch main): there is no style to import`)
  const raw = `https://raw.githubusercontent.com/${user}/${MIND_REPOSITORY}/${commit}/${CATALOG_PATH}`
  const res = await fetch(raw).catch(e => { throw new RequestError(502, `reading ${raw} failed: ${(e as Error).message}`) })
  if (!res.ok) throw new RequestError(res.status === 404 ? 404 : 502, `${repo} has no ${CATALOG_PATH} at ${commit.slice(0, 10)} (${res.status})`)
  const parsed = parseProjectCatalog(await res.text())
  if (!parsed.ok) throw new RequestError(422, `${repo} ${CATALOG_PATH} cannot be read: ${parsed.problem.message}`)
  const errors = validateCatalog(parsed.model).filter(i => i.severity === 'error')
  if (errors.length) throw new RequestError(422, `${repo} ${CATALOG_PATH} has errors:\n${errors.map(i => `  ${i.code}: ${i.message}`).join('\n')}`)
  if (!parsed.model.projects.length) throw new RequestError(422, `${repo} lists no projects`)
  const reg = await loadRegistry(ctx.registryFile)
  const ws = reg.workspaces.find(w => w.id === SUMMONER.project || w.project === SUMMONER.project)
  if (!ws) throw new RequestError(409, `no ${SUMMONER.project} here to propose a plan: run agdevctl bootstrap-projects first (it brings the summoner by the core's reference)`)
  const projects = parsed.model.projects.map(p => ({ project: p.project, description: p.description, roles: Object.keys(p.roles ?? {}) }))
  const text = `# Import ${user}'s development style

Reproduce ${user}'s development style here and start developing: summon the projects of ${user}'s catalog ${repo} (${CATALOG_PATH} at ${commit}) that are not present here yet.

The catalog lists: ${projects.map(p => p.project).join(', ')}.

(Requested with wfe summon style ${user}.)
`
  return { ok: true, user, catalog: repo, commit, projects, workspace: ws.id, workflow: SUMMONER.workflow, text }
}
