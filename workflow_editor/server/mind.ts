// The mind repository of this installation (summoner p1, docs/mind.md).
//
// `<area>/mind.json` names it: the Gitea repository (by id, owner/name as
// recorded), its branch and the summonplan that describes this installation.
// The service keeps a service-owned clone at `<area>/.local/mind/` that it
// reads, and writes through: every change is one commit, authored by the
// person or agent that made it, pushed to Gitea before it counts. The clone is
// a cache: it is reset to Gitea before every write and never holds work of its
// own. Gitea credentials are the service's own (gitea.json), as for any other
// repository it pushes to.
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Issue } from '../shared/model.ts'
import {
  braindumpExcerpt, braindumpPath, braindumpTitle, BRAINDUMP_DIR, CATALOG_PATH, MIND_FILE, MIND_REPOSITORY, MIND_SCHEMA, PLAN_NAME_PATTERN,
  PROJECT_CATALOG_SCHEMA, SLUG_PATTERN, summonplanPath, SUMMONPLAN_DIR, validateCatalog, validateMind, validateSummonplan,
  type MindDoc, type ProjectCatalog, type SummonEntry, type Summonplan,
} from '../shared/mind.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git, gitOk } from './git.ts'
import { Gitea, GiteaError } from './gitea.ts'
import { withLock } from './lock.ts'
import { loadRegistry, registerRepository } from './registry.ts'
import { RequestError } from './workspace.ts'
import { parseMind, parseProjectCatalog, parseSummonplan } from './yamlDoc.ts'

export const MIND_SETTING = 'mind.json'
export interface MindSetting { repository: { id: number; owner: string; name: string }; branch: string; plan: string }
export interface MindContext { area: string; registryFile: string; gitea?: Gitea; giteaProblem?: string }

const settingFile = (area: string) => join(area, MIND_SETTING)
const checkoutDir = (area: string) => join(area, '.local', 'mind')
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function loadMindSetting(area: string): Promise<MindSetting | null> {
  const text = await readTextOrNull(settingFile(area))
  if (text === null) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) { throw new RequestError(500, `${settingFile(area)} is not valid JSON (${(e as Error).message}); fix it`) }
  const r = isObj(raw) && isObj(raw.repository) ? raw.repository : null
  if (!isObj(raw) || !r || typeof r.id !== 'number' || typeof r.owner !== 'string' || typeof r.name !== 'string') throw new RequestError(500, `${settingFile(area)} needs {"repository": {"id", "owner", "name"}, "branch", "plan"}`)
  return { repository: { id: r.id, owner: r.owner, name: r.name }, branch: typeof raw.branch === 'string' && raw.branch ? raw.branch : 'main', plan: typeof raw.plan === 'string' ? raw.plan : '' }
}

const needGitea = (ctx: MindContext): Gitea => {
  if (!ctx.gitea) throw new RequestError(503, `Gitea is not available: ${ctx.giteaProblem ?? 'no Gitea setting'}`)
  return ctx.gitea
}
const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f() } catch (e) {
    if (e instanceof GiteaError) throw new RequestError(502, e.message)
    throw e
  }
}
async function needSetting(ctx: MindContext): Promise<MindSetting> {
  const s = await loadMindSetting(ctx.area)
  if (!s) throw new RequestError(404, `this installation has no mind repository yet (no ${settingFile(ctx.area)}); create or attach it with: wfe mind init`)
  return s
}
const exists = (p: string) => stat(p).then(() => true, () => false)

// ---- the service-owned clone -------------------------------------------------------

const fetchedAt = new Map<string, number>()
// Brings the clone to Gitea's branch: cloned when absent, fetched when older
// than maxAgeMs (0: always), reset and cleaned. Returns the head commit.
async function sync(ctx: MindContext, s: MindSetting, maxAgeMs: number): Promise<string> {
  const g = needGitea(ctx)
  const dir = checkoutDir(ctx.area)
  const env = await wrap(() => g.gitEnv())
  const url = g.cloneUrl(s.repository.owner, s.repository.name)
  if (!await exists(join(dir, '.git'))) {
    await mkdir(dirname(dir), { recursive: true })
    await rm(dir, { recursive: true, force: true })
    const c = await git(dirname(dir), ['clone', '-q', '--branch', s.branch, '--', url, basename(dir)], { env, timeoutMs: 120_000 })
    if (c.code !== 0) throw new RequestError(502, `cloning the mind repository ${s.repository.owner}/${s.repository.name} failed: ${c.stderr.trim()}`)
    fetchedAt.set(dir, Date.now())
  } else if (Date.now() - (fetchedAt.get(dir) ?? 0) >= maxAgeMs) {
    const f = await git(dir, ['fetch', '-q', '--', url, `+refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`], { env, timeoutMs: 120_000 })
    if (f.code !== 0) throw new RequestError(502, `fetching the mind repository failed: ${f.stderr.trim()}`)
    fetchedAt.set(dir, Date.now())
  }
  await gitOk(dir, ['reset', '-q', '--hard', `origin/${s.branch}`])
  await gitOk(dir, ['clean', '-qfd'])
  return (await gitOk(dir, ['rev-parse', 'HEAD'])).trim()
}

const authorLine = (author: string) => `${author} <${author.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'someone'}@agdev.invalid>`

export interface MindChange { path: string; text: string | null } // null: remove
// Applies changes as one commit authored by `author` and pushes it. A push
// that loses a race is tried once more on Gitea's new head; `check` runs on
// the fresh clone before each try and may refuse.
async function commitChanges(ctx: MindContext, s: MindSetting, changes: MindChange[], author: string, message: string, check?: (dir: string) => Promise<void>): Promise<{ commit: string; changed: boolean }> {
  if (!author.trim()) throw new RequestError(400, 'a change to the mind repository needs its author: the person or agent whose words it holds (--author)')
  const g = needGitea(ctx)
  const dir = checkoutDir(ctx.area)
  return withLock(settingFile(ctx.area), async () => {
    for (let attempt = 0; ; attempt++) {
      await sync(ctx, s, 0)
      if (check) await check(dir)
      for (const c of changes) {
        const file = join(dir, c.path)
        if (c.text === null) await rm(file, { force: true })
        else { await mkdir(dirname(file), { recursive: true }); await writeFile(file, c.text) }
      }
      await gitOk(dir, ['add', '-A'])
      if ((await git(dir, ['diff', '--cached', '--quiet'])).code === 0) return { commit: (await gitOk(dir, ['rev-parse', 'HEAD'])).trim(), changed: false }
      await gitOk(dir, ['commit', '-q', '--author', authorLine(author.trim()), '-m', message], { config: { 'user.name': 'agdev', 'user.email': 'agdev@agdev.invalid' } })
      const p = await git(dir, ['push', '-q', '--', g.cloneUrl(s.repository.owner, s.repository.name), `HEAD:refs/heads/${s.branch}`], { env: await wrap(() => g.gitEnv()), timeoutMs: 120_000 })
      if (p.code === 0) {
        await gitOk(dir, ['update-ref', `refs/remotes/origin/${s.branch}`, 'HEAD'])
        return { commit: (await gitOk(dir, ['rev-parse', 'HEAD'])).trim(), changed: true }
      }
      if (attempt >= 1) throw new RequestError(409, `pushing to the mind repository failed: ${p.stderr.trim()}`)
    }
  }, { what: 'the mind repository' })
}

// ---- reading ---------------------------------------------------------------------

export interface BraindumpInfo {
  slug: string; path: string; title: string; excerpt: string; text?: string
  updated: { commit: string; at: string; author: string } | null
}
export interface PlanInfo { name: string; path: string; plan: Summonplan | null; problem?: string; issues: Issue[] }
export interface MindSnapshot {
  setting: MindSetting
  web: string
  head: string
  mind: { doc: MindDoc | null; problem?: string; issues: Issue[] }
  braindumps: BraindumpInfo[]
  plans: PlanInfo[]
  catalog: { doc: ProjectCatalog | null; problem?: string; issues: Issue[] }
}

async function lastChange(dir: string, path: string): Promise<BraindumpInfo['updated']> {
  const r = await git(dir, ['log', '-1', '--format=%H%x09%aI%x09%an', '--', path])
  const [commit, at, author] = r.stdout.trim().split('\t')
  return commit ? { commit, at, author } : null
}

async function readSnapshot(ctx: MindContext, s: MindSetting, head: string, withText: boolean): Promise<MindSnapshot> {
  const dir = checkoutDir(ctx.area)
  const g = needGitea(ctx)
  const mt = await readTextOrNull(join(dir, MIND_FILE))
  const mp = mt === null ? null : parseMind(mt)
  const mind = mt === null ? { doc: null, problem: `${MIND_FILE} is missing`, issues: [] } : mp!.ok ? { doc: mp!.model, issues: validateMind(mp!.model) } : { doc: null, problem: mp!.problem.message, issues: [] }
  const names = async (sub: string, ext: string) => (await readdir(join(dir, sub)).catch(() => [] as string[])).filter(f => f.endsWith(ext)).sort()
  const braindumps: BraindumpInfo[] = []
  for (const f of await names(BRAINDUMP_DIR, '.md')) {
    const slug = f.slice(0, -3)
    if (!SLUG_PATTERN.test(slug)) continue
    const path = braindumpPath(slug)
    const text = (await readTextOrNull(join(dir, path))) ?? ''
    braindumps.push({ slug, path, title: braindumpTitle(slug, text), excerpt: braindumpExcerpt(text), ...(withText ? { text } : {}), updated: await lastChange(dir, path) })
  }
  const known = braindumps.map(b => b.path)
  const plans: PlanInfo[] = []
  for (const f of await names(SUMMONPLAN_DIR, '.yaml')) {
    const name = f.slice(0, -5)
    const path = summonplanPath(name)
    const r = parseSummonplan((await readTextOrNull(join(dir, path))) ?? '')
    plans.push(r.ok ? { name, path, plan: r.model, issues: validateSummonplan(r.model, { braindumps: known }, name) } : { name, path, plan: null, problem: r.problem.message, issues: [] })
  }
  const ct = await readTextOrNull(join(dir, CATALOG_PATH))
  const cp = ct === null ? null : parseProjectCatalog(ct)
  const catalog = ct === null ? { doc: null, problem: `${CATALOG_PATH} is missing`, issues: [] } : cp!.ok ? { doc: cp!.model, issues: validateCatalog(cp!.model, { braindumps: known }) } : { doc: null, problem: cp!.problem.message, issues: [] }
  return { setting: s, web: g.webUrl(s.repository.owner, s.repository.name), head, mind, braindumps, plans, catalog }
}

// What the mind repository holds now (read from Gitea at most every maxAgeMs).
export async function mindSnapshot(ctx: MindContext, o: { maxAgeMs?: number; withText?: boolean } = {}): Promise<MindSnapshot> {
  const s = await needSetting(ctx)
  return withLock(settingFile(ctx.area), async () => readSnapshot(ctx, s, await sync(ctx, s, o.maxAgeMs ?? 10_000), !!o.withText), { what: 'the mind repository' })
}

// ---- relations: braindumps ↔ projects --------------------------------------------

export interface ProjectGround {
  project: string
  registered: boolean
  workspace?: string // a registered workspace of the project on this host
  entry: SummonEntry | null // in this installation's plan
  braindumps: { slug: string; title: string; excerpt: string; missing?: boolean }[]
}
export interface MindView {
  configured: true
  repository: string; web: string; head: string; plan: string
  title: string
  person: string | null
  braindumps: (BraindumpInfo & { projects: string[] })[]
  projects: ProjectGround[]
  plans: { name: string; intent: string; entries: number; problem?: string; errors: number; warnings: number }[]
  issues: { where: string; issue: Issue }[]
  problems: string[]
}

async function personOf(area: string): Promise<string | null> {
  try { const c = JSON.parse((await readTextOrNull(join(area, 'conversations.json'))) ?? '{}') as { person?: unknown }; return typeof c.person === 'string' ? c.person : null } catch { return null }
}

type Known = { projects: { id: string }[]; workspaces: { id: string; project?: string }[] }
export function relate(snap: MindSnapshot, reg: Known): Pick<MindView, 'braindumps' | 'projects'> {
  const registered = reg.projects.map(p => p.id)
  const plan = snap.plans.find(p => p.name === snap.setting.plan)?.plan ?? null
  const bySlug = new Map(snap.braindumps.map(b => [b.path, b]))
  const braindumps = snap.braindumps.map(b => ({ ...b, projects: (plan?.entries ?? []).filter(e => e.because.includes(b.path)).map(e => e.project) }))
  const ids = [...new Set([...registered, ...(plan?.entries ?? []).map(e => e.project)])].sort()
  const projects = ids.map((id): ProjectGround => {
    const entry = plan?.entries.find(e => e.project === id) ?? null
    return {
      project: id, registered: registered.includes(id), entry,
      ...(reg.workspaces.find(w => w.project === id || w.id === id) ? { workspace: (reg.workspaces.find(w => w.project === id) ?? reg.workspaces.find(w => w.id === id))!.id } : {}),
      braindumps: (entry?.because ?? []).map(p => { const b = bySlug.get(p); return b ? { slug: b.slug, title: b.title, excerpt: b.excerpt } : { slug: p, title: p, excerpt: '', missing: true } }),
    }
  })
  return { braindumps, projects }
}

export async function mindView(ctx: MindContext, o: { maxAgeMs?: number } = {}): Promise<MindView | { configured: false; reason: string }> {
  if (!await loadMindSetting(ctx.area)) return { configured: false, reason: `no mind repository is attached (no ${MIND_SETTING}); run wfe mind init` }
  const snap = await mindSnapshot(ctx, o)
  const reg = await loadRegistry(ctx.registryFile)
  const problems: string[] = []
  if (snap.mind.problem) problems.push(`${MIND_FILE}: ${snap.mind.problem}`)
  if (snap.catalog.problem) problems.push(`${CATALOG_PATH}: ${snap.catalog.problem}`)
  if (snap.setting.plan && !snap.plans.some(p => p.name === snap.setting.plan)) problems.push(`this installation's plan ${summonplanPath(snap.setting.plan)} does not exist yet`)
  for (const p of snap.plans) if (p.problem) problems.push(`${p.path}: ${p.problem}`)
  const issues = [
    ...snap.mind.issues.map(issue => ({ where: MIND_FILE, issue })),
    ...snap.catalog.issues.map(issue => ({ where: CATALOG_PATH, issue })),
    ...snap.plans.flatMap(p => p.issues.map(issue => ({ where: p.path, issue }))),
  ]
  return {
    configured: true,
    repository: `${snap.setting.repository.owner}/${snap.setting.repository.name}`, web: snap.web, head: snap.head, plan: snap.setting.plan,
    title: snap.mind.doc?.title ?? '', person: await personOf(ctx.area),
    ...relate(snap, reg),
    plans: snap.plans.map(p => ({ name: p.name, intent: p.plan?.intent ?? '', entries: p.plan?.entries.length ?? 0, ...(p.problem ? { problem: p.problem } : {}), errors: p.issues.filter(i => i.severity === 'error').length, warnings: p.issues.filter(i => i.severity === 'warning').length })),
    issues, problems,
  }
}

// Why a project is here: its entry in this installation's plan, the braindumps
// behind it, and every other plan of this mind that lists it.
export async function why(ctx: MindContext, project: string) {
  const snap = await mindSnapshot(ctx)
  const reg = await loadRegistry(ctx.registryFile)
  const r = relate(snap, reg)
  const ground = r.projects.find(p => p.project === project) ?? { project, registered: false, entry: null, braindumps: [] }
  const elsewhere = snap.plans.filter(p => p.name !== snap.setting.plan && p.plan?.entries.some(e => e.project === project)).map(p => ({ plan: p.name, entry: p.plan!.entries.find(e => e.project === project)! }))
  return { plan: snap.setting.plan, head: snap.head, web: snap.web, ...ground, elsewhere }
}

export async function braindump(ctx: MindContext, slug: string) {
  const snap = await mindSnapshot(ctx, { withText: true })
  const b = snap.braindumps.find(x => x.slug === slug)
  if (!b) throw new RequestError(404, `no braindump "${slug}" in the mind repository`)
  const dir = checkoutDir(ctx.area)
  const log = (await git(dir, ['log', '-20', '--format=%H%x09%aI%x09%an%x09%s', '--', b.path])).stdout.trim().split('\n').filter(Boolean).map(l => { const [commit, at, author, subject] = l.split('\t'); return { commit, at, author, subject } })
  const reg = await loadRegistry(ctx.registryFile)
  const projects = relate(snap, reg).braindumps.find(x => x.slug === slug)?.projects ?? []
  const plans = snap.plans.filter(p => p.plan?.entries.some(e => e.because.includes(b.path))).map(p => p.name)
  return { ...b, head: snap.head, web: `${snap.web}/src/branch/${snap.setting.branch}/${b.path}`, history: log, projects, plans }
}

export async function plan(ctx: MindContext, name: string) {
  const snap = await mindSnapshot(ctx, {})
  const p = snap.plans.find(x => x.name === name)
  if (!p) throw new RequestError(404, `no summonplan "${name}" in the mind repository (${snap.plans.map(x => x.name).join(', ') || 'none yet'})`)
  const text = (await readTextOrNull(join(checkoutDir(ctx.area), p.path))) ?? ''
  return { ...p, text, head: snap.head, current: name === snap.setting.plan }
}

// ---- changes -------------------------------------------------------------------

export type BraindumpOp = 'add' | 'edit' | 'remove'
export async function changeBraindump(ctx: MindContext, o: { op: BraindumpOp; slug: string; text?: string; author: string; base?: string; message?: string; force?: boolean }) {
  const s = await needSetting(ctx)
  if (!SLUG_PATTERN.test(o.slug)) throw new RequestError(400, `"${o.slug}" is not a braindump name: lower-case letters, digits and "-" (${SLUG_PATTERN.source})`)
  const path = braindumpPath(o.slug)
  if (o.op !== 'remove' && (typeof o.text !== 'string' || !o.text.trim())) throw new RequestError(400, 'a braindump needs its text')
  const text = o.op === 'remove' ? null : o.text!.endsWith('\n') ? o.text! : `${o.text}\n`
  const r = await commitChanges(ctx, s, [{ path, text }], o.author, o.message?.trim() || `${o.op === 'add' ? 'Add' : o.op === 'edit' ? 'Edit' : 'Remove'} braindump ${o.slug}`, async dir => {
    const present = await exists(join(dir, path))
    if (o.op === 'add' && present) throw new RequestError(409, `braindump "${o.slug}" already exists; edit it instead`)
    if (o.op !== 'add' && !present) throw new RequestError(404, `no braindump "${o.slug}"`)
    if (o.base && o.op !== 'add') {
      const last = await lastChange(dir, path)
      // base: the commit the change was made against (the file's last change or any later head).
      if (last && last.commit !== o.base && (await git(dir, ['merge-base', '--is-ancestor', last.commit, o.base])).code !== 0) {
        throw new RequestError(409, `braindump "${o.slug}" was changed since ${o.base.slice(0, 7)} (by ${last.author} at ${last.at}, ${last.commit.slice(0, 7)}); read it again and redo the change`)
      }
    }
    if (o.op === 'remove' && !o.force) {
      const users: string[] = []
      for (const f of (await readdir(join(dir, SUMMONPLAN_DIR)).catch(() => [] as string[])).filter(f => f.endsWith('.yaml'))) {
        const p = parseSummonplan((await readTextOrNull(join(dir, SUMMONPLAN_DIR, f))) ?? '')
        if (p.ok && p.model.entries.some(e => e.because.includes(path))) users.push(f.slice(0, -5))
      }
      if (users.length) throw new RequestError(409, `braindump "${o.slug}" grounds entries of ${users.join(', ')}; remove it from their because lists first, or remove it anyway (--force; the plans then name a braindump that only their grounds commit holds)`)
    }
  })
  return { ok: true, message: r.changed ? `${o.op === 'add' ? 'Added' : o.op === 'edit' ? 'Changed' : 'Removed'} braindump ${o.slug} (${r.commit.slice(0, 7)}).` : `Braindump ${o.slug} is unchanged.`, commit: r.commit, changed: r.changed, path }
}

// Writes a summonplan whole, after checking it against the repository it is
// written to. Errors refuse; warnings are reported.
export async function putPlan(ctx: MindContext, o: { text: string; author: string; message?: string }) {
  const s = await needSetting(ctx)
  const parsed = parseSummonplan(o.text)
  if (!parsed.ok) throw new RequestError(400, `the summonplan cannot be read: ${parsed.problem.message}`)
  const name = parsed.model.name
  if (!PLAN_NAME_PATTERN.test(name)) throw new RequestError(400, `summonplan name "${name}" must match ${PLAN_NAME_PATTERN.source}`)
  let issues: Issue[] = []
  const r = await commitChanges(ctx, s, [{ path: summonplanPath(name), text: o.text.endsWith('\n') ? o.text : `${o.text}\n` }], o.author, o.message?.trim() || `Write summonplan ${name}`, async dir => {
    const known = (await readdir(join(dir, BRAINDUMP_DIR)).catch(() => [] as string[])).filter(f => f.endsWith('.md')).map(f => `${BRAINDUMP_DIR}/${f}`)
    issues = validateSummonplan(parsed.model, { braindumps: known }, name)
    const errors = issues.filter(i => i.severity === 'error')
    if (errors.length) throw new RequestError(400, `summonplan ${name} has errors; nothing was written:\n${errors.map(i => `  ${i.code}: ${i.message}`).join('\n')}`)
  })
  return { ok: true, message: r.changed ? `Wrote summonplan ${name} (${r.commit.slice(0, 7)}).` : `Summonplan ${name} is unchanged.`, commit: r.commit, changed: r.changed, issues }
}

// ---- creation and attachment ---------------------------------------------------

const README = (owner: string) => `# ${MIND_REPOSITORY}

${owner}'s mind repository for agdev (docs/mind.md in agdev's workflow_editor).

- \`braindumps/<slug>.md\`: free text: what was wanted and why. The grounds of projects and of the resources they use.
- \`summonplans/<name>.yaml\` (ag.summonplan.v1): which projects make those braindumps concrete in one installation or style, from where, at which commit, filling which roles.
- \`catalog.yaml\` (ag.catalog.v1): the projects ${owner} shares with others.
- \`mind.yaml\` (ag.mind.v1): whose mind this is.

Braindumps may be rewritten freely; a summonplan records the commit of this repository it was written against (\`grounds\`).
`

// Creates the mind repository on Gitea (or attaches an existing one that is a
// mind repository) and records it in <area>/mind.json. A same-named repository
// that is not a mind repository is a collision: refused, nothing changed.
export async function initMind(ctx: MindContext, o: { title?: string; plan?: string; author: string }) {
  const g = needGitea(ctx)
  const current = await loadMindSetting(ctx.area)
  if (current) return { ok: true, message: `This installation's mind repository is ${current.repository.owner}/${current.repository.name} (${MIND_SETTING}); nothing was changed.`, setting: current, steps: [] }
  if (!o.author.trim()) throw new RequestError(400, 'creating the mind repository needs its author (--author)')
  const plan = o.plan ?? ''
  if (plan && !PLAN_NAME_PATTERN.test(plan)) throw new RequestError(400, `plan name "${plan}" must match ${PLAN_NAME_PATTERN.source}`)
  const steps: { name: string; status: string; detail: string }[] = []
  const owner = g.owner
  let repo = await wrap(() => g.repo(owner, MIND_REPOSITORY))
  if (repo && await wrap(() => g.hasContent(repo!.owner, repo!.name))) {
    const read = await wrap(() => g.readFiles(repo!.owner, repo!.name, repo!.defaultBranch, [MIND_FILE], join(ctx.area, '.local', 'gitea-cache')))
    const m = read.files[MIND_FILE] === null ? null : parseMind(read.files[MIND_FILE]!)
    if (!m?.ok || m.model.schema !== MIND_SCHEMA) throw new RequestError(409, `${repo.fullName} already exists and is not a mind repository (no ${MIND_FILE} with ${MIND_SCHEMA}); nothing was changed. Ask the owner what it is before using the name.`)
    steps.push({ name: 'gitea', status: 'kept', detail: `${repo.fullName} is a mind repository (owner ${m.model.owner}); attaching it` })
  } else {
    repo ??= await wrap(() => g.createRepo(MIND_REPOSITORY, `${owner}'s braindumps and summonplans (agdev mind repository)`))
    steps.push({ name: 'gitea', status: 'done', detail: `created ${repo.fullName}` })
    const work = join(ctx.area, '.local', `new-mind-${process.pid}`)
    const env = await wrap(() => g.gitEnv())
    const run = (args: string[]) => gitOk(work, args, { env, config: { 'init.defaultBranch': 'main', 'user.name': 'agdev', 'user.email': 'agdev@agdev.invalid' }, timeoutMs: 120_000 })
    try {
      await rm(work, { recursive: true, force: true })
      await mkdir(join(work, BRAINDUMP_DIR), { recursive: true })
      await mkdir(join(work, SUMMONPLAN_DIR), { recursive: true })
      await run(['init', '-q', '--initial-branch=main'])
      await writeFile(join(work, MIND_FILE), `schema: ${MIND_SCHEMA}\nowner: ${owner}\ntitle: ${JSON.stringify(o.title || `${owner}'s mind`)}\n`)
      await writeFile(join(work, CATALOG_PATH), `schema: ${PROJECT_CATALOG_SCHEMA}\nowner: ${owner}\nprojects: []\n`)
      await writeFile(join(work, BRAINDUMP_DIR, '.gitkeep'), '')
      await writeFile(join(work, SUMMONPLAN_DIR, '.gitkeep'), '')
      await writeFile(join(work, 'README.md'), README(owner))
      await run(['add', '-A'])
      await run(['commit', '-q', '--author', authorLine(o.author.trim()), '-m', 'Initialize the mind repository'])
      await run(['push', '-q', g.cloneUrl(repo.owner, repo.name), 'HEAD:refs/heads/main'])
      steps.push({ name: 'initial commit', status: 'done', detail: `${MIND_FILE}, ${CATALOG_PATH}, ${BRAINDUMP_DIR}/, ${SUMMONPLAN_DIR}/ pushed` })
    } finally { await rm(work, { recursive: true, force: true }) }
  }
  const r = await registerRepository(ctx.registryFile, repo, 'mind')
  steps.push({ name: 'registration', status: r.status === 'registered' ? 'done' : 'kept', detail: `${repo.fullName} as mind` })
  const setting: MindSetting = { repository: { id: repo.id, owner: repo.owner, name: repo.name }, branch: repo.defaultBranch || 'main', plan }
  await atomicWrite(settingFile(ctx.area), `${JSON.stringify(setting, null, 2)}\n`)
  steps.push({ name: MIND_SETTING, status: 'done', detail: `${resolve(settingFile(ctx.area))}${plan ? ` (this installation's plan: ${plan})` : ''}` })
  return { ok: true, message: `This installation's mind repository is ${repo.fullName}.`, setting, steps }
}

// Changes which summonplan describes this installation.
export async function setInstallationPlan(ctx: MindContext, plan: string) {
  const s = await needSetting(ctx)
  if (!PLAN_NAME_PATTERN.test(plan)) throw new RequestError(400, `plan name "${plan}" must match ${PLAN_NAME_PATTERN.source}`)
  const next = { ...s, plan }
  await atomicWrite(settingFile(ctx.area), `${JSON.stringify(next, null, 2)}\n`)
  return { ok: true, message: `This installation's plan is now ${plan}.`, setting: next }
}
