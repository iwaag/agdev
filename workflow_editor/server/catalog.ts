// The catalog of this installation's user (user_catalog p1, docs/mycatalog.md).
//
// `<area>/catalog.json` names it: the Gitea repository (by id, owner/name as
// recorded), its branch and the summonplan that describes this installation.
// The service keeps a service-owned clone at `<area>/.local/catalog/` that it
// reads, and writes through: every change is one commit, authored by the
// person or agent that made it, pushed to Gitea before it counts. The clone is
// a cache: it is reset to Gitea before every write and never holds work of its
// own. Gitea credentials are the service's own (gitea.json), as for any other
// repository it pushes to.
//
// user_catalog p2: the owner's challenges live in the same repository
// (challenges/<id>/…, written by server/challenges.ts through its own journal
// and clone), challenges.md at the root is the index of what is not yet real
// (written by an agent, stored and shown here, never parsed), and
// publication/github.toml says which braindumps and challenges are in the
// published part.
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Issue } from '../shared/model.ts'
import {
  braindumpExcerpt, braindumpPath, braindumpTitle, BRAINDUMP_DIR, BRAINDUMP_FILE, CATALOG_FILE, CATALOG_REPOSITORY, CHALLENGES_DIR, EPISODES_DIR, INDEX_PATH, isBraindumpId,
  MAX_BRAINDUMP_DEPTH, MYCATALOG_SCHEMA, OLD_LAYOUT, OLD_LAYOUT_PROBLEM, PLAN_NAME_PATTERN, PROJECTS_PATH, PROJECTS_SCHEMA, PUBLICATION_CONTRACT, publishedPaths, readPublicationContract, reviewPath,
  SEGMENT_PATTERN, summonplanPath, SUMMONPLAN_DIR, validateMycatalog, validateProjects, validateSummonplan,
  type CatalogDoc, type ProjectsDoc, type SummonEntry, type Summonplan,
} from '../shared/catalog.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git, gitOk } from './git.ts'
import { Gitea, GiteaError } from './gitea.ts'
import { loadChallengeConfig, type ChallengeStore } from './challenges.ts'
import { withLock } from './lock.ts'
import { loadRegistry, registerRepository } from './registry.ts'
import { RequestError } from './workspace.ts'
import { parseMycatalog, parseProjects, parseSummonplan } from './yamlDoc.ts'

export const CATALOG_SETTING = 'catalog.json'
// publicationWorkspace: where the owner publishes the catalog from (the folder
// agdev-external-publish works in); only its journal is read, for the last public commit.
export interface CatalogSetting { repository: { id: number; owner: string; name: string }; branch: string; plan: string; publicationWorkspace?: string }
// challenges: the service's own challenge store; without it one is opened for the read.
export interface CatalogContext { area: string; registryFile: string; gitea?: Gitea; giteaProblem?: string; challenges?: ChallengeStore }

const settingFile = (area: string) => join(area, CATALOG_SETTING)
const checkoutDir = (area: string) => join(area, '.local', 'catalog')
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const exists = (p: string) => stat(p).then(() => true, () => false)

// An area written before user_catalog p1 has mind.json and .local/mind/. They
// are renamed once, when only the old names exist: peers are updated by
// release activation and nobody edits their area by hand. (The registry's
// category "mind" is read as "catalog": server/registry.ts.)
export async function adoptOldArea(area: string, log: (line: string) => void = line => console.error(line)): Promise<void> {
  for (const [from, to] of [[join(area, 'mind.json'), settingFile(area)], [join(area, '.local', 'mind'), checkoutDir(area)]]) {
    if (await exists(to) || !await exists(from)) continue
    await rename(from, to).then(() => log(`catalog: renamed ${from} to ${to}`), e => log(`catalog: ${from} could not be renamed to ${to}: ${(e as Error).message}`))
  }
}

export async function loadCatalogSetting(area: string): Promise<CatalogSetting | null> {
  await adoptOldArea(area)
  const text = await readTextOrNull(settingFile(area))
  if (text === null) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) { throw new RequestError(500, `${settingFile(area)} is not valid JSON (${(e as Error).message}); fix it`) }
  const r = isObj(raw) && isObj(raw.repository) ? raw.repository : null
  if (!isObj(raw) || !r || typeof r.id !== 'number' || typeof r.owner !== 'string' || typeof r.name !== 'string') throw new RequestError(500, `${settingFile(area)} needs {"repository": {"id", "owner", "name"}, "branch", "plan"}`)
  return { repository: { id: r.id, owner: r.owner, name: r.name }, branch: typeof raw.branch === 'string' && raw.branch ? raw.branch : 'main', plan: typeof raw.plan === 'string' ? raw.plan : '',
    ...(typeof raw.publicationWorkspace === 'string' && raw.publicationWorkspace ? { publicationWorkspace: raw.publicationWorkspace } : {}) }
}

const needGitea = (ctx: CatalogContext): Gitea => {
  if (!ctx.gitea) throw new RequestError(503, `Gitea is not available: ${ctx.giteaProblem ?? 'no Gitea setting'}`)
  return ctx.gitea
}
const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f() } catch (e) {
    if (e instanceof GiteaError) throw new RequestError(502, e.message)
    throw e
  }
}
async function needSetting(ctx: CatalogContext): Promise<CatalogSetting> {
  const s = await loadCatalogSetting(ctx.area)
  if (!s) throw new RequestError(404, `this installation has no catalog yet (no ${settingFile(ctx.area)}); create or attach it with: wfe catalog init`)
  return s
}

// ---- the service-owned clone -------------------------------------------------------

const fetchedAt = new Map<string, number>()
// Brings the clone to Gitea's branch: cloned when absent, fetched when older
// than maxAgeMs (0: always), reset and cleaned. Returns the head commit.
async function sync(ctx: CatalogContext, s: CatalogSetting, maxAgeMs: number): Promise<string> {
  const g = needGitea(ctx)
  const dir = checkoutDir(ctx.area)
  const env = await wrap(() => g.gitEnv())
  const url = g.cloneUrl(s.repository.owner, s.repository.name)
  if (!await exists(join(dir, '.git'))) {
    await mkdir(dirname(dir), { recursive: true })
    await rm(dir, { recursive: true, force: true })
    const c = await git(dirname(dir), ['clone', '-q', '--branch', s.branch, '--', url, basename(dir)], { env, timeoutMs: 120_000 })
    if (c.code !== 0) throw new RequestError(502, `cloning the catalog ${s.repository.owner}/${s.repository.name} failed: ${c.stderr.trim()}`)
    fetchedAt.set(dir, Date.now())
  } else if (Date.now() - (fetchedAt.get(dir) ?? 0) >= maxAgeMs) {
    const f = await git(dir, ['fetch', '-q', '--', url, `+refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`], { env, timeoutMs: 120_000 })
    if (f.code !== 0) throw new RequestError(502, `fetching the catalog failed: ${f.stderr.trim()}`)
    fetchedAt.set(dir, Date.now())
  }
  await gitOk(dir, ['reset', '-q', '--hard', `origin/${s.branch}`])
  await gitOk(dir, ['clean', '-qfd'])
  return (await gitOk(dir, ['rev-parse', 'HEAD'])).trim()
}

const authorLine = (author: string) => `${author} <${author.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'someone'}@agdev.invalid>`

export interface CatalogChange { path: string; text: string | null } // null: remove
// Applies changes as one commit authored by `author` and pushes it. A push
// that loses a race is tried once more on Gitea's new head; `check` runs on
// the fresh clone before each try and may refuse. Changes may be computed from
// the fresh clone.
async function commitChanges(ctx: CatalogContext, s: CatalogSetting, changes: CatalogChange[] | ((dir: string) => Promise<CatalogChange[]>), author: string, message: string, check?: (dir: string) => Promise<void>): Promise<{ commit: string; changed: boolean }> {
  if (!author.trim()) throw new RequestError(400, 'a change to the catalog needs its author: the person or agent whose words it holds (--author)')
  const g = needGitea(ctx)
  const dir = checkoutDir(ctx.area)
  return withLock(settingFile(ctx.area), async () => {
    for (let attempt = 0; ; attempt++) {
      await sync(ctx, s, 0)
      if (check) await check(dir)
      for (const c of typeof changes === 'function' ? await changes(dir) : changes) {
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
        void pushMirrors(ctx, s, (await gitOk(dir, ['rev-parse', 'HEAD'])).trim())
        return { commit: (await gitOk(dir, ['rev-parse', 'HEAD'])).trim(), changed: true }
      }
      if (attempt >= 1) throw new RequestError(409, `pushing to the catalog failed: ${p.stderr.trim()}`)
    }
  }, { what: 'the catalog' })
}

// Whether <area>/challenges.json names this catalog as the challenge repository.
const sameRepository = (a: string, b: string) => a.replace(/\/\/[^@/]+@/, '//').replace(/\/+$/, '').replace(/\.git$/, '') === b.replace(/\/+$/, '').replace(/\.git$/, '')
function challengesHere(ctx: CatalogContext, s: CatalogSetting) {
  const c = loadChallengeConfig(ctx.area)
  if ('disabled' in c) return { config: null, inCatalog: false, reason: c.disabled }
  const inCatalog = !!ctx.gitea && sameRepository(c.destination, ctx.gitea.cloneUrl(s.repository.owner, s.repository.name))
  return { config: c, inCatalog, reason: inCatalog ? '' : `challenges.json names ${c.destination}, not this catalog` }
}

// The catalog's backup: when the challenges are in the catalog, the mirrors
// challenges.json names hold the whole repository, so a catalog commit goes
// there too. Best effort, as for a challenge publication; never read.
async function pushMirrors(ctx: CatalogContext, s: CatalogSetting, commit: string): Promise<void> {
  try {
    const { config, inCatalog } = challengesHere(ctx, s)
    if (!config || !inCatalog) return
    for (const m of config.mirrors) {
      const r = await git(checkoutDir(ctx.area), ['push', '-q', '--', m, `${commit}:refs/heads/${s.branch}`], { env: { GIT_TERMINAL_PROMPT: '0', ...(config.sshCommand ? { GIT_SSH_COMMAND: config.sshCommand } : {}) }, timeoutMs: 60_000 })
      if (r.code !== 0) console.error(`catalog: mirror ${m} was not updated: ${r.stderr.trim()}`)
    }
  } catch (e) { console.error(`catalog: mirrors: ${(e as Error).message}`) }
}

// ---- reading ---------------------------------------------------------------------

export interface Change { commit: string; at: string; author: string }
export interface ReviewInfo { path: string; text?: string; updated: Change | null; published: boolean }
export interface BraindumpInfo {
  id: string; path: string; title: string; excerpt: string; text?: string
  updated: Change | null
  published: boolean // in the published part (publication/github.toml selects it)
  review: ReviewInfo | null
  // Derived from Git: the braindump's newest change is newer than its review's.
  changedAfterReview: boolean
}
export interface PlanInfo { name: string; path: string; plan: Summonplan | null; problem?: string; issues: Issue[] }
export interface CatalogSnapshot {
  setting: CatalogSetting
  web: string
  head: string
  catalog: { doc: CatalogDoc | null; problem?: string; issues: Issue[] }
  braindumps: BraindumpInfo[]
  plans: PlanInfo[]
  projects: { doc: ProjectsDoc | null; problem?: string; issues: Issue[] }
  index: IndexInfo
  published: Map<string, string> // source path → public path
}
// challenges.md: the index of what is not yet real. `stale` lists what
// changed under braindumps/ or challenges/ after the index's last change
// (derived from Git; a commit that only moves files does not count).
export interface IndexInfo { path: string; text: string | null; updated: Change | null; stale: (Change & { under: string })[]; note: string }

// The last change of a file's content. A commit that only moved it (a
// migration, a renamed folder's history) is not a change of what it says.
async function lastChange(dir: string, path: string): Promise<Change | null> {
  const r = await git(dir, ['log', '-1', '--follow', '-M100%', '--diff-filter=AM', '--format=%H%x09%aI%x09%an', '--', path])
  const [commit, at, author] = r.stdout.trim().split('\n')[0].split('\t')
  return commit ? { commit, at, author } : null
}

// The newest commit that changed what a directory says (not one that only moved files).
async function lastChangeUnder(dir: string, under: string): Promise<Change | null> {
  const r = await git(dir, ['log', '-1', '-M100%', '--diff-filter=AMD', '--format=%H%x09%aI%x09%an', '--', under])
  const [commit, at, author] = r.stdout.trim().split('\n')[0].split('\t')
  return commit ? { commit, at, author } : null
}
const isAfter = async (dir: string, later: string, earlier: string) => later !== earlier && (await git(dir, ['merge-base', '--is-ancestor', earlier, later])).code === 0

async function readIndex(dir: string): Promise<IndexInfo> {
  const text = await readTextOrNull(join(dir, INDEX_PATH))
  if (text === null) return { path: INDEX_PATH, text: null, updated: null, stale: [], note: `No index yet (${INDEX_PATH}).` }
  const updated = await lastChange(dir, INDEX_PATH)
  const stale: IndexInfo['stale'] = []
  if (updated) for (const under of [BRAINDUMP_DIR, CHALLENGES_DIR]) {
    const c = await lastChangeUnder(dir, under)
    if (c && await isAfter(dir, c.commit, updated.commit)) stale.push({ ...c, under })
  }
  return { path: INDEX_PATH, text, updated, stale, note: stale.length ? `Changed since the index was written: ${stale.map(c => `${c.under}/ (${c.author}, ${c.at.slice(0, 10)}, ${c.commit.slice(0, 7)})`).join('; ')}.` : '' }
}

// What publication/github.toml selects of the repository's files (source path → public path).
async function readPublished(dir: string): Promise<{ contract: boolean; destination: string; paths: Map<string, string> }> {
  const text = await readTextOrNull(join(dir, PUBLICATION_CONTRACT))
  if (text === null) return { contract: false, destination: '', paths: new Map() }
  const sel = readPublicationContract(text)
  const files = (await gitOk(dir, ['-c', 'core.quotePath=false', 'ls-files', '-z'])).split('\0').filter(Boolean)
  return { contract: true, destination: sel.destination, paths: publishedPaths(sel, files) }
}

// The one rule: every braindump.md under braindumps/episodes/, at any depth.
// Returns identities (folder paths below braindumps/episodes/), sorted.
async function braindumpIds(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string[]) => {
    const entries = await readdir(join(dir, EPISODES_DIR, ...rel), { withFileTypes: true }).catch(() => [])
    if (rel.length && entries.some(e => e.isFile() && e.name === BRAINDUMP_FILE)) out.push(rel.join('/'))
    if (rel.length >= MAX_BRAINDUMP_DEPTH) return
    for (const e of entries) if (e.isDirectory() && SEGMENT_PATTERN.test(e.name)) await walk([...rel, e.name])
  }
  await walk([])
  return out.sort()
}
const knownBraindumps = async (dir: string) => (await braindumpIds(dir)).map(braindumpPath)

async function readBraindump(dir: string, id: string, withText: boolean, published: Map<string, string>): Promise<BraindumpInfo> {
  const path = braindumpPath(id)
  const text = (await readTextOrNull(join(dir, path))) ?? ''
  const updated = await lastChange(dir, path)
  const rt = await readTextOrNull(join(dir, reviewPath(id)))
  const review: ReviewInfo | null = rt === null ? null : { path: reviewPath(id), ...(withText ? { text: rt } : {}), updated: await lastChange(dir, reviewPath(id)), published: published.has(reviewPath(id)) }
  const changedAfterReview = !!(updated && review?.updated && updated.commit !== review.updated.commit
    && (await git(dir, ['merge-base', '--is-ancestor', review.updated.commit, updated.commit])).code === 0)
  return { id, path, title: braindumpTitle(id, text), excerpt: braindumpExcerpt(text), ...(withText ? { text } : {}), updated, published: published.has(path), review, changedAfterReview }
}

async function readSnapshot(ctx: CatalogContext, s: CatalogSetting, head: string, withText: boolean): Promise<CatalogSnapshot> {
  const dir = checkoutDir(ctx.area)
  const g = needGitea(ctx)
  const mt = await readTextOrNull(join(dir, CATALOG_FILE))
  const mp = mt === null ? null : parseMycatalog(mt)
  const old = mt === null && await exists(join(dir, OLD_LAYOUT.marker))
  const catalog = mt === null ? { doc: null, problem: old ? OLD_LAYOUT_PROBLEM : `${CATALOG_FILE} is missing`, issues: [] } : mp!.ok ? { doc: mp!.model, issues: validateMycatalog(mp!.model) } : { doc: null, problem: mp!.problem.message, issues: [] }
  const published = (await readPublished(dir)).paths
  const braindumps: BraindumpInfo[] = []
  for (const id of await braindumpIds(dir)) braindumps.push(await readBraindump(dir, id, withText, published))
  const known = braindumps.map(b => b.path)
  const plans: PlanInfo[] = []
  for (const f of (await readdir(join(dir, SUMMONPLAN_DIR)).catch(() => [] as string[])).filter(f => f.endsWith('.yaml')).sort()) {
    const name = f.slice(0, -5)
    const path = summonplanPath(name)
    const r = parseSummonplan((await readTextOrNull(join(dir, path))) ?? '')
    plans.push(r.ok ? { name, path, plan: r.model, issues: validateSummonplan(r.model, { braindumps: known }, name) } : { name, path, plan: null, problem: r.problem.message, issues: [] })
  }
  const ct = await readTextOrNull(join(dir, PROJECTS_PATH))
  const cp = ct === null ? null : parseProjects(ct)
  const projects = ct === null ? { doc: null, problem: `${PROJECTS_PATH} is missing`, issues: [] } : cp!.ok ? { doc: cp!.model, issues: validateProjects(cp!.model, { braindumps: known }) } : { doc: null, problem: cp!.problem.message, issues: [] }
  return { setting: s, web: g.webUrl(s.repository.owner, s.repository.name), head, catalog, braindumps, plans, projects, index: await readIndex(dir), published }
}

// What the catalog holds now (read from Gitea at most every maxAgeMs).
export async function catalogSnapshot(ctx: CatalogContext, o: { maxAgeMs?: number; withText?: boolean } = {}): Promise<CatalogSnapshot> {
  const s = await needSetting(ctx)
  return withLock(settingFile(ctx.area), async () => readSnapshot(ctx, s, await sync(ctx, s, o.maxAgeMs ?? 10_000), !!o.withText), { what: 'the catalog' })
}

// ---- relations: braindumps ↔ projects --------------------------------------------

export interface ProjectGround {
  project: string
  registered: boolean
  workspace?: string // a registered workspace of the project on this host
  entry: SummonEntry | null // in this installation's plan
  braindumps: { id: string; title: string; excerpt: string; missing?: boolean }[]
}
export interface CatalogView {
  configured: true
  repository: string; web: string; branch: string; head: string; plan: string
  title: string
  person: string | null
  braindumps: (BraindumpInfo & { projects: string[] })[]
  projects: ProjectGround[]
  plans: { name: string; intent: string; entries: number; problem?: string; errors: number; warnings: number }[]
  index: IndexInfo
  challenges: ChallengesBrief
  issues: { where: string; issue: Issue }[]
  problems: string[]
}

// The owner's challenges as the Catalog page lists them; the challenge pages
// and api/challenges are where a challenge is read and written.
export interface ChallengeBrief { id: string; title: string; state: string | null; stateKind: string; projects: string[]; trials: number; updated: { at: string; by: string }; published: boolean }
export interface ChallengesBrief { available: boolean; inCatalog: boolean; reason: string; counts: Record<string, number>; items: ChallengeBrief[] }
async function challengesBrief(ctx: CatalogContext, s: CatalogSetting, published: Map<string, string>): Promise<ChallengesBrief> {
  const here = challengesHere(ctx, s)
  const none = { open: 0, resolved: 0, withdrawn: 0, custom: 0, unspecified: 0 }
  if (!here.config) return { available: false, inCatalog: false, reason: here.reason, counts: none, items: [] }
  let store = ctx.challenges, own = false
  try {
    if (!store) { const { ChallengeStore } = await import('./challenges.ts'); store = new ChallengeStore({ area: ctx.area, env: async () => ctx.gitea ? ctx.gitea.gitEnv() : {} }); own = true }
    await store.sync()
    const l = store.list({ limit: 500 })
    const isPublished = (id: string) => [...published.keys()].some(p => p.startsWith(`${CHALLENGES_DIR}/${id}/`))
    return { available: true, inCatalog: here.inCatalog, reason: here.reason, counts: l.counts,
      items: l.challenges.map(c => ({ id: c.id, title: c.title, state: c.state, stateKind: c.stateKind, projects: c.projects, trials: c.trials.length, updated: { at: c.updated.at, by: c.updated.by }, published: here.inCatalog && isPublished(c.id) })) }
  } catch (e) { return { available: false, inCatalog: here.inCatalog, reason: (e as Error).message, counts: none, items: [] } } finally { if (own) store?.close() }
}

async function personOf(area: string): Promise<string | null> {
  try { const c = JSON.parse((await readTextOrNull(join(area, 'conversations.json'))) ?? '{}') as { person?: unknown }; return typeof c.person === 'string' ? c.person : null } catch { return null }
}

type Known = { projects: { id: string }[]; workspaces: { id: string; project?: string }[] }
export function relate(snap: CatalogSnapshot, reg: Known): Pick<CatalogView, 'braindumps' | 'projects'> {
  const registered = reg.projects.map(p => p.id)
  const plan = snap.plans.find(p => p.name === snap.setting.plan)?.plan ?? null
  const byPath = new Map(snap.braindumps.map(b => [b.path, b]))
  const braindumps = snap.braindumps.map(b => ({ ...b, projects: (plan?.entries ?? []).filter(e => e.because.includes(b.path)).map(e => e.project) }))
  const ids = [...new Set([...registered, ...(plan?.entries ?? []).map(e => e.project)])].sort()
  const projects = ids.map((id): ProjectGround => {
    const entry = plan?.entries.find(e => e.project === id) ?? null
    return {
      project: id, registered: registered.includes(id), entry,
      ...(reg.workspaces.find(w => w.project === id || w.id === id) ? { workspace: (reg.workspaces.find(w => w.project === id) ?? reg.workspaces.find(w => w.id === id))!.id } : {}),
      braindumps: (entry?.because ?? []).map(p => { const b = byPath.get(p); return b ? { id: b.id, title: b.title, excerpt: b.excerpt } : { id: p, title: p, excerpt: '', missing: true } }),
    }
  })
  return { braindumps, projects }
}

export async function catalogView(ctx: CatalogContext, o: { maxAgeMs?: number } = {}): Promise<CatalogView | { configured: false; reason: string }> {
  if (!await loadCatalogSetting(ctx.area)) return { configured: false, reason: `no catalog is attached (no ${CATALOG_SETTING}); run wfe catalog init` }
  // Excerpts only: a braindump's text and review are read when it is opened (braindump()).
  const snap = await catalogSnapshot(ctx, o)
  const reg = await loadRegistry(ctx.registryFile)
  const problems: string[] = []
  if (snap.catalog.problem) problems.push(`${CATALOG_FILE}: ${snap.catalog.problem}`)
  if (snap.projects.problem && snap.catalog.problem !== OLD_LAYOUT_PROBLEM) problems.push(`${PROJECTS_PATH}: ${snap.projects.problem}`)
  if (snap.setting.plan && !snap.plans.some(p => p.name === snap.setting.plan)) problems.push(`this installation's plan ${summonplanPath(snap.setting.plan)} does not exist yet`)
  for (const p of snap.plans) if (p.problem) problems.push(`${p.path}: ${p.problem}`)
  const issues = [
    ...snap.catalog.issues.map(issue => ({ where: CATALOG_FILE, issue })),
    ...snap.projects.issues.map(issue => ({ where: PROJECTS_PATH, issue })),
    ...snap.plans.flatMap(p => p.issues.map(issue => ({ where: p.path, issue }))),
  ]
  return {
    configured: true,
    repository: `${snap.setting.repository.owner}/${snap.setting.repository.name}`, web: snap.web, branch: snap.setting.branch, head: snap.head, plan: snap.setting.plan,
    title: snap.catalog.doc?.title ?? '', person: await personOf(ctx.area),
    ...relate(snap, reg),
    plans: snap.plans.map(p => ({ name: p.name, intent: p.plan?.intent ?? '', entries: p.plan?.entries.length ?? 0, ...(p.problem ? { problem: p.problem } : {}), errors: p.issues.filter(i => i.severity === 'error').length, warnings: p.issues.filter(i => i.severity === 'warning').length })),
    index: snap.index, challenges: await challengesBrief(ctx, snap.setting, snap.published),
    issues, problems,
  }
}

// Why a project is here: its entry in this installation's plan, the braindumps
// behind it, and every other plan of this catalog that lists it.
export async function why(ctx: CatalogContext, project: string) {
  const snap = await catalogSnapshot(ctx)
  const reg = await loadRegistry(ctx.registryFile)
  const r = relate(snap, reg)
  const ground = r.projects.find(p => p.project === project) ?? { project, registered: false, entry: null, braindumps: [] }
  const elsewhere = snap.plans.filter(p => p.name !== snap.setting.plan && p.plan?.entries.some(e => e.project === project)).map(p => ({ plan: p.name, entry: p.plan!.entries.find(e => e.project === project)! }))
  return { plan: snap.setting.plan, head: snap.head, web: snap.web, ...ground, elsewhere }
}

const historyOf = async (dir: string, path: string) => (await git(dir, ['log', '-20', '--follow', '--format=%H%x09%aI%x09%an%x09%s', '--', path])).stdout.trim().split('\n').filter(Boolean).map(l => { const [commit, at, author, subject] = l.split('\t'); return { commit, at, author, subject } })

export async function braindump(ctx: CatalogContext, id: string) {
  const snap = await catalogSnapshot(ctx, { withText: true })
  const b = snap.braindumps.find(x => x.id === id)
  if (!b) throw new RequestError(404, `no braindump "${id}" in the catalog (${EPISODES_DIR}/${id}/${BRAINDUMP_FILE})`)
  const reg = await loadRegistry(ctx.registryFile)
  const projects = relate(snap, reg).braindumps.find(x => x.id === id)?.projects ?? []
  const plans = snap.plans.filter(p => p.plan?.entries.some(e => e.because.includes(b.path))).map(p => p.name)
  return { ...b, head: snap.head, web: `${snap.web}/src/branch/${snap.setting.branch}/${b.path}`, history: await historyOf(checkoutDir(ctx.area), b.path), projects, plans }
}

export async function plan(ctx: CatalogContext, name: string) {
  const snap = await catalogSnapshot(ctx, {})
  const p = snap.plans.find(x => x.name === name)
  if (!p) throw new RequestError(404, `no summonplan "${name}" in the catalog (${snap.plans.map(x => x.name).join(', ') || 'none yet'})`)
  const text = (await readTextOrNull(join(checkoutDir(ctx.area), p.path))) ?? ''
  return { ...p, text, head: snap.head, current: name === snap.setting.plan }
}

// ---- changes -------------------------------------------------------------------

const needId = (id: string) => {
  if (!isBraindumpId(id)) throw new RequestError(400, `"${id}" is not a braindump path: folder names below ${EPISODES_DIR}/, each of lower-case letters, digits, "-", "_" and "." (${SEGMENT_PATTERN.source}), at most ${MAX_BRAINDUMP_DEPTH} deep`)
}
// base: the commit the change was made against (the file's last change or any later head).
async function refuseIfChangedSince(dir: string, path: string, base: string | undefined, what: string) {
  if (!base) return
  const last = await lastChange(dir, path)
  if (last && last.commit !== base && (await git(dir, ['merge-base', '--is-ancestor', last.commit, base])).code !== 0) {
    throw new RequestError(409, `${what} was changed since ${base.slice(0, 7)} (by ${last.author} at ${last.at}, ${last.commit.slice(0, 7)}); read it again and redo the change`)
  }
}

export type BraindumpOp = 'add' | 'edit' | 'remove'
export async function changeBraindump(ctx: CatalogContext, o: { op: BraindumpOp; id: string; text?: string; author: string; base?: string; message?: string; force?: boolean }) {
  const s = await needSetting(ctx)
  needId(o.id)
  const path = braindumpPath(o.id)
  if (o.op !== 'remove' && (typeof o.text !== 'string' || !o.text.trim())) throw new RequestError(400, 'a braindump needs its text')
  const text = o.op === 'remove' ? null : o.text!.endsWith('\n') ? o.text! : `${o.text}\n`
  // Removing a braindump removes its review with it; other files of the folder are the owner's and stay.
  const changes: CatalogChange[] = [{ path, text }, ...(o.op === 'remove' ? [{ path: reviewPath(o.id), text: null }] : [])]
  const r = await commitChanges(ctx, s, changes, o.author, o.message?.trim() || `${o.op === 'add' ? 'Add' : o.op === 'edit' ? 'Edit' : 'Remove'} braindump ${o.id}`, async dir => {
    const present = await exists(join(dir, path))
    if (o.op === 'add' && present) throw new RequestError(409, `braindump "${o.id}" already exists; edit it instead`)
    if (o.op !== 'add' && !present) throw new RequestError(404, `no braindump "${o.id}"`)
    if (o.op !== 'add') await refuseIfChangedSince(dir, path, o.base, `braindump "${o.id}"`)
    if (o.op === 'remove' && !o.force) {
      const users: string[] = []
      for (const f of (await readdir(join(dir, SUMMONPLAN_DIR)).catch(() => [] as string[])).filter(f => f.endsWith('.yaml'))) {
        const p = parseSummonplan((await readTextOrNull(join(dir, SUMMONPLAN_DIR, f))) ?? '')
        if (p.ok && p.model.entries.some(e => e.because.includes(path))) users.push(f.slice(0, -5))
      }
      if (users.length) throw new RequestError(409, `braindump "${o.id}" grounds entries of ${users.join(', ')}; remove it from their because lists first, or remove it anyway (--force; the plans then name a braindump that only their grounds commit holds)`)
    }
  })
  return { ok: true, message: r.changed ? `${o.op === 'add' ? 'Added' : o.op === 'edit' ? 'Changed' : 'Removed'} braindump ${o.id} (${r.commit.slice(0, 7)}).` : `Braindump ${o.id} is unchanged.`, commit: r.commit, changed: r.changed, path }
}

// A review: free text about a braindump (how far it became real, where, what
// did not), in review.md beside it. No score, no state, no required structure.
// The Git author is the writer; an agent signs by being the author.
export async function review(ctx: CatalogContext, id: string) {
  const b = await braindump(ctx, id)
  return { id: b.id, title: b.title, braindump: { path: b.path, updated: b.updated }, review: b.review, changedAfterReview: b.changedAfterReview, head: b.head,
    history: b.review ? await historyOf(checkoutDir(ctx.area), b.review.path) : [] }
}
export async function putReview(ctx: CatalogContext, o: { id: string; text: string; author: string; base?: string; message?: string }) {
  const s = await needSetting(ctx)
  needId(o.id)
  if (typeof o.text !== 'string' || !o.text.trim()) throw new RequestError(400, 'a review needs its text')
  const path = reviewPath(o.id)
  const r = await commitChanges(ctx, s, [{ path, text: o.text.endsWith('\n') ? o.text : `${o.text}\n` }], o.author, o.message?.trim() || `Review braindump ${o.id}`, async dir => {
    if (!await exists(join(dir, braindumpPath(o.id)))) throw new RequestError(404, `no braindump "${o.id}" to review`)
    await refuseIfChangedSince(dir, path, o.base, `the review of "${o.id}"`)
  })
  return { ok: true, message: r.changed ? `Wrote the review of ${o.id} (${r.commit.slice(0, 7)}).` : `The review of ${o.id} is unchanged.`, commit: r.commit, changed: r.changed, path }
}

// Writes a summonplan whole, after checking it against the repository it is
// written to. Errors refuse; warnings are reported.
export async function putPlan(ctx: CatalogContext, o: { text: string; author: string; message?: string }) {
  const s = await needSetting(ctx)
  const parsed = parseSummonplan(o.text)
  if (!parsed.ok) throw new RequestError(400, `the summonplan cannot be read: ${parsed.problem.message}`)
  const name = parsed.model.name
  if (!PLAN_NAME_PATTERN.test(name)) throw new RequestError(400, `summonplan name "${name}" must match ${PLAN_NAME_PATTERN.source}`)
  let issues: Issue[] = []
  const r = await commitChanges(ctx, s, [{ path: summonplanPath(name), text: o.text.endsWith('\n') ? o.text : `${o.text}\n` }], o.author, o.message?.trim() || `Write summonplan ${name}`, async dir => {
    issues = validateSummonplan(parsed.model, { braindumps: await knownBraindumps(dir) }, name)
    const errors = issues.filter(i => i.severity === 'error')
    if (errors.length) throw new RequestError(400, `summonplan ${name} has errors; nothing was written:\n${errors.map(i => `  ${i.code}: ${i.message}`).join('\n')}`)
  })
  return { ok: true, message: r.changed ? `Wrote summonplan ${name} (${r.commit.slice(0, 7)}).` : `Summonplan ${name} is unchanged.`, commit: r.commit, changed: r.changed, issues }
}

// The index (challenges.md): what is not yet real, braindumps and challenges
// alike, with a line or two each. An agent writes it whole (the summoner's
// workflow `index`); nothing here reads meaning from it.
export async function index(ctx: CatalogContext, o: { maxAgeMs?: number } = {}) {
  const snap = await catalogSnapshot(ctx, o)
  return { ...snap.index, head: snap.head, history: snap.index.text === null ? [] : await historyOf(checkoutDir(ctx.area), INDEX_PATH) }
}
export async function putIndex(ctx: CatalogContext, o: { text: string; author: string; base?: string; message?: string }) {
  const s = await needSetting(ctx)
  if (typeof o.text !== 'string' || !o.text.trim()) throw new RequestError(400, 'the index needs its text')
  const r = await commitChanges(ctx, s, [{ path: INDEX_PATH, text: o.text.endsWith('\n') ? o.text : `${o.text}\n` }], o.author, o.message?.trim() || 'Write the index of what is not yet real', dir => refuseIfChangedSince(dir, INDEX_PATH, o.base, 'the index'))
  return { ok: true, message: r.changed ? `Wrote the index ${INDEX_PATH} (${r.commit.slice(0, 7)}).` : 'The index is unchanged.', commit: r.commit, changed: r.changed, path: INDEX_PATH }
}

// Catalog upkeep is the summoner's (the one project every installation has):
// its workflows `review` and `index` write through wfe catalog as their own
// author. What a request for one of them says; the caller queues it.
export const UPKEEP = { project: 'summoner', review: 'review', index: 'index' } as const
export async function upkeepRequest(ctx: CatalogContext, o: { kind: 'review' | 'index'; id?: string }) {
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  if (o.kind === 'review' && o.id) { needId(o.id); if (!snap.braindumps.some(b => b.id === o.id)) throw new RequestError(404, `no braindump "${o.id}" to review`) }
  const reg = await loadRegistry(ctx.registryFile)
  const ws = reg.workspaces.find(w => w.id === UPKEEP.project || w.project === UPKEEP.project)
  if (!ws) throw new RequestError(409, `no ${UPKEEP.project} here to ${o.kind === 'review' ? 'write reviews' : 'write the index'}: run agdevctl bootstrap-projects first (it brings the summoner by the core's reference)`)
  const repo = `${snap.setting.repository.owner}/${snap.setting.repository.name}`
  const due = snap.braindumps.filter(b => !b.review || b.changedAfterReview).map(b => b.id)
  const text = o.kind === 'index'
    ? `# Rewrite the catalog's index\n\nRewrite ${INDEX_PATH} of the catalog ${repo} (head ${snap.head}): everything that is not yet real, braindumps and challenges, each with its kind, a link and one or two lines on what is missing.\n\n(Requested with wfe catalog index request.)\n`
    : o.id
      ? `# Review braindump ${o.id}\n\nWrite or refresh the review of the braindump \`${o.id}\` (${braindumpPath(o.id)}) of the catalog ${repo} (head ${snap.head}).\n\n(Requested with wfe catalog review request ${o.id}.)\n`
      : `# Review the braindumps that need it\n\nWrite or refresh the review of every braindump of the catalog ${repo} (head ${snap.head}) that has no review or changed after its review.${due.length ? ` At this head: ${due.join(', ')}.` : ' At this head there is none.'}\n\n(Requested with wfe catalog review request.)\n`
  return { ok: true, kind: o.kind, ...(o.id ? { id: o.id } : {}), head: snap.head, workspace: ws.id, workflow: UPKEEP[o.kind], text, receipt: `catalog-${o.kind}-${(o.id ?? 'all').replace(/[^A-Za-z0-9._-]+/g, '.')}-${snap.head.slice(0, 12)}-${Date.now()}` }
}

// The published part: the public paths publication/github.toml selects,
// grouped, and the last public commit the publication journal records. A
// path not selected is internal.
export async function publicationStatus(ctx: CatalogContext, o: { maxAgeMs?: number } = {}) {
  const snap = await catalogSnapshot(ctx, o)
  const dir = checkoutDir(ctx.area)
  const p = await withLock(settingFile(ctx.area), () => readPublished(dir), { what: 'the catalog' })
  const entries = [...p.paths.entries()].map(([from, to]) => ({ from, public: to })).sort((a, b) => a.from.localeCompare(b.from))
  const braindumps = snap.braindumps.filter(b => b.published).map(b => ({ id: b.id, public: p.paths.get(b.path)! }))
  const reviews = snap.braindumps.filter(b => b.review?.published).map(b => ({ id: b.id, public: p.paths.get(b.review!.path)! }))
  const byChallenge = new Map<string, number>()
  for (const e of entries) { const m = new RegExp(`^${CHALLENGES_DIR}/([^/]+)/`).exec(e.from); if (m) byChallenge.set(m[1], (byChallenge.get(m[1]) ?? 0) + 1) }
  const grouped = new Set([...snap.braindumps.flatMap(b => [b.path, b.review?.path ?? '']), ...entries.filter(e => e.from.startsWith(`${CHALLENGES_DIR}/`)).map(e => e.from)])
  const ws = snap.setting.publicationWorkspace ?? null
  let last: { publicCommit: string; sourceRev: string; at: string } | null = null, journalNote = ws ? '' : `no publication workspace is recorded (wfe catalog publication use <folder>): the last public commit is not known here`
  if (ws) try {
    const j = JSON.parse((await readTextOrNull(join(ws, '.agdev', 'publication', 'github.json'))) ?? 'null') as { repositories?: Record<string, { publications?: { status?: string; public_commit?: string; source_rev?: string; published_at?: string }[] }> } | null
    const pubs = Object.values(j?.repositories ?? {}).flatMap(r => r.publications ?? []).filter(x => x.status === 'published' && x.public_commit)
    const l = pubs.sort((a, b) => (a.published_at ?? '').localeCompare(b.published_at ?? '')).at(-1)
    if (l) last = { publicCommit: l.public_commit!, sourceRev: l.source_rev ?? '', at: l.published_at ?? '' }
    else journalNote = `the journal in ${ws} records no publication`
  } catch (e) { journalNote = `the journal in ${ws} cannot be read: ${(e as Error).message}` }
  return { contract: p.contract, destination: p.destination, head: snap.head, braindumps, reviews,
    challenges: [...byChallenge.entries()].map(([id, files]) => ({ id, files })), rest: entries.filter(e => !grouped.has(e.from)),
    internal: { braindumps: snap.braindumps.filter(b => !b.published).map(b => b.id) },
    workspace: ws, last, note: journalNote }
}
export async function setPublicationWorkspace(ctx: CatalogContext, folder: string) {
  const s = await needSetting(ctx)
  const ws = resolve(folder)
  if (!await exists(join(ws, '.agdev', 'publication'))) throw new RequestError(400, `${ws} has no .agdev/publication/: it is not a folder agdev-external-publish has worked in`)
  const next = { ...s, publicationWorkspace: ws }
  await atomicWrite(settingFile(ctx.area), `${JSON.stringify(next, null, 2)}\n`)
  return { ok: true, message: `The catalog is published from ${ws}.`, setting: next }
}

// ---- creation and attachment ---------------------------------------------------

// What a new user sees first: what a catalog is, the recommended layout, and
// that the layout is advice (agdev_philosophy p3, user_catalog p1).
const README = (owner: string) => `# ${CATALOG_REPOSITORY}

${owner}'s catalog for agdev.

A catalog is the record of what drives one's development: the motives, wishes, thoughts, problems
and ideas (braindumps), and where the results of that development are found. It also holds what
lowers the cost for others to use those results or learn from them, and an assessment of how far
each braindump has become real (reviews).

## Recommended layout

- \`braindumps/episodes/<path>/braindump.md\`: free text: what is wanted and why. Written by the person, or by an agent the person asked, who signs as the Git author.
- \`braindumps/episodes/<path>/review.md\` (optional): free text about that braindump: what became real, where, what did not.
- \`challenges/<id>/\`: a problem found during work, with its trials and evidence. Written through agdev (\`wfe challenge\`), by people and agents.
- \`challenges.md\`: the index of what is not yet real: braindumps that were not carried out and challenges that are not resolved, one or two lines each. An agent writes it (\`wfe catalog index request\`).
- \`summonplans/<name>.yaml\` (ag.summonplan.v1): which projects make braindumps concrete in one installation, from where, at which commit, filling which roles, and because of which braindumps.
- \`projects.yaml\` (ag.projects.v1): the projects ${owner} shares with others.
- \`mycatalog.yaml\` (ag.mycatalog.v1): whose catalog this is.

\`<path>\` is any folder path you like: one folder per thought, or groups with phases below them.
agdev reads one rule only: a \`braindump.md\` anywhere under \`braindumps/episodes/\` is a braindump,
its folder path is its name, and a \`review.md\` beside it is its review. Other files there are yours.

What is not yet real comes from two sides and stays two kinds: a braindump is a wish from above, a
challenge is a problem met from below. Neither is turned into the other; the index lists both.

## What this copy holds, and what is published

This repository, on the cluster's Git service, is the catalog of everything this cluster is meant
to make real: every braindump, review, challenge and plan. A copy published elsewhere (GitHub,
\`<user>/mycatalog\`) is the published part of the same catalog: the problems and ideas ${owner}
judges should be worked on in the open, and the results that may serve others and deserve to be
kept under version control for long. What is published is chosen per braindump and per challenge
in \`publication/github.toml\`; everything else is internal.

This layout is advice, not a rule. Free text stays free. The YAML files are checked, because
agdev acts on them. A catalog written this way, in a repository named \`mycatalog\`, is easy for
agdev and for other people to take in (\`wfe summon style <user>\`).
`

// Creates the catalog on Gitea (or attaches an existing repository that is a
// catalog) and records it in <area>/catalog.json. A same-named repository
// that is not a catalog is a collision: refused, nothing changed.
export async function initCatalog(ctx: CatalogContext, o: { title?: string; plan?: string; author: string }) {
  const g = needGitea(ctx)
  const current = await loadCatalogSetting(ctx.area)
  if (current) return { ok: true, message: `This installation's catalog is ${current.repository.owner}/${current.repository.name} (${CATALOG_SETTING}); nothing was changed.`, setting: current, steps: [] }
  if (!o.author.trim()) throw new RequestError(400, 'creating the catalog needs its author (--author)')
  const plan = o.plan ?? ''
  if (plan && !PLAN_NAME_PATTERN.test(plan)) throw new RequestError(400, `plan name "${plan}" must match ${PLAN_NAME_PATTERN.source}`)
  const steps: { name: string; status: string; detail: string }[] = []
  const owner = g.owner
  let repo = await wrap(() => g.repo(owner, CATALOG_REPOSITORY))
  if (repo && await wrap(() => g.hasContent(repo!.owner, repo!.name))) {
    const read = await wrap(() => g.readFiles(repo!.owner, repo!.name, repo!.defaultBranch, [CATALOG_FILE, OLD_LAYOUT.marker], join(ctx.area, '.local', 'gitea-cache')))
    const m = read.files[CATALOG_FILE] === null ? null : parseMycatalog(read.files[CATALOG_FILE]!)
    const old = !m && read.files[OLD_LAYOUT.marker] !== null
    if (!old && (!m?.ok || m.model.schema !== MYCATALOG_SCHEMA)) throw new RequestError(409, `${repo.fullName} already exists and is not a catalog (no ${CATALOG_FILE} with ${MYCATALOG_SCHEMA}); nothing was changed. Ask the owner what it is before using the name.`)
    steps.push({ name: 'gitea', status: 'kept', detail: old ? `${repo.fullName} is a catalog in ${OLD_LAYOUT_PROBLEM}; attaching it` : `${repo.fullName} is a catalog (owner ${m!.ok ? m!.model.owner : '?'}); attaching it` })
  } else {
    repo ??= await wrap(() => g.createRepo(CATALOG_REPOSITORY, `${owner}'s catalog: braindumps, reviews, summonplans and shared projects (agdev)`))
    steps.push({ name: 'gitea', status: 'done', detail: `created ${repo.fullName}` })
    const work = join(ctx.area, '.local', `new-catalog-${process.pid}`)
    const env = await wrap(() => g.gitEnv())
    const run = (args: string[]) => gitOk(work, args, { env, config: { 'init.defaultBranch': 'main', 'user.name': 'agdev', 'user.email': 'agdev@agdev.invalid' }, timeoutMs: 120_000 })
    try {
      await rm(work, { recursive: true, force: true })
      await mkdir(join(work, EPISODES_DIR), { recursive: true })
      await mkdir(join(work, SUMMONPLAN_DIR), { recursive: true })
      await run(['init', '-q', '--initial-branch=main'])
      await writeFile(join(work, CATALOG_FILE), `schema: ${MYCATALOG_SCHEMA}\nowner: ${owner}\ntitle: ${JSON.stringify(o.title || `${owner}'s catalog`)}\n`)
      await writeFile(join(work, PROJECTS_PATH), `schema: ${PROJECTS_SCHEMA}\nowner: ${owner}\nprojects: []\n`)
      await writeFile(join(work, EPISODES_DIR, '.gitkeep'), '')
      await writeFile(join(work, SUMMONPLAN_DIR, '.gitkeep'), '')
      await writeFile(join(work, 'README.md'), README(owner))
      await run(['add', '-A'])
      await run(['commit', '-q', '--author', authorLine(o.author.trim()), '-m', 'Initialize the catalog'])
      await run(['push', '-q', g.cloneUrl(repo.owner, repo.name), 'HEAD:refs/heads/main'])
      steps.push({ name: 'initial commit', status: 'done', detail: `${CATALOG_FILE}, ${PROJECTS_PATH}, ${EPISODES_DIR}/, ${SUMMONPLAN_DIR}/ pushed` })
    } finally { await rm(work, { recursive: true, force: true }) }
  }
  const r = await registerRepository(ctx.registryFile, repo, 'catalog')
  steps.push({ name: 'registration', status: r.status === 'registered' ? 'done' : 'kept', detail: `${repo.fullName} as catalog` })
  const setting: CatalogSetting = { repository: { id: repo.id, owner: repo.owner, name: repo.name }, branch: repo.defaultBranch || 'main', plan }
  await atomicWrite(settingFile(ctx.area), `${JSON.stringify(setting, null, 2)}\n`)
  steps.push({ name: CATALOG_SETTING, status: 'done', detail: `${resolve(settingFile(ctx.area))}${plan ? ` (this installation's plan: ${plan})` : ''}` })
  // The owner's challenges live in the catalog (user_catalog p2): an area with
  // no challenge repository gets the catalog as one. A setting that exists is the owner's.
  const cj = join(ctx.area, 'challenges.json')
  if (await exists(cj)) steps.push({ name: 'challenges.json', status: 'kept', detail: `${resolve(cj)} exists; challenges stay where it says` })
  else {
    await atomicWrite(cj, `${JSON.stringify({ repository: g.cloneUrl(repo.owner, repo.name), branch: setting.branch }, null, 1)}\n`)
    steps.push({ name: 'challenges.json', status: 'done', detail: `challenges are kept in the catalog (${CHALLENGES_DIR}/<id>/); the running service reads this at its next start` })
  }
  return { ok: true, message: `This installation's catalog is ${repo.fullName}.`, setting, steps }
}

// Changes which summonplan describes this installation.
export async function setInstallationPlan(ctx: CatalogContext, plan: string) {
  const s = await needSetting(ctx)
  if (!PLAN_NAME_PATTERN.test(plan)) throw new RequestError(400, `plan name "${plan}" must match ${PLAN_NAME_PATTERN.source}`)
  const next = { ...s, plan }
  await atomicWrite(settingFile(ctx.area), `${JSON.stringify(next, null, 2)}\n`)
  return { ok: true, message: `This installation's plan is now ${plan}.`, setting: next }
}

// ---- migration from the layout before user_catalog p1 -----------------------------

// One commit: braindumps/<slug>.md → braindumps/episodes/<slug>/braindump.md,
// mind.yaml → mycatalog.yaml, catalog.yaml → projects.yaml, their schema
// lines, every `because` in summonplans and projects.yaml, and the file
// entries of publication/github.toml. README.md is the owner's text and is
// not rewritten. Refused on a repository already in the new layout.
const OLD_BRAINDUMP = /braindumps\/([a-z0-9][a-z0-9-]{0,63})\.md/g
async function migration(dir: string): Promise<{ changes: CatalogChange[]; lines: string[] }> {
  if (await exists(join(dir, CATALOG_FILE))) throw new RequestError(409, `the catalog already has ${CATALOG_FILE}: it is in the new layout; nothing to migrate`)
  const marker = await readTextOrNull(join(dir, OLD_LAYOUT.marker))
  if (marker === null) throw new RequestError(409, `the repository has neither ${CATALOG_FILE} nor ${OLD_LAYOUT.marker}: it is not a catalog in the old layout`)
  const changes: CatalogChange[] = [], lines: string[] = []
  const move = (from: string, to: string, text: string, note = '') => { changes.push({ path: from, text: null }, { path: to, text }); lines.push(`move    ${from} → ${to}${note}`) }
  const because = (t: string) => t.replace(OLD_BRAINDUMP, (_, slug: string) => braindumpPath(slug))
  move(OLD_LAYOUT.marker, CATALOG_FILE, marker.replace(OLD_LAYOUT.schema, MYCATALOG_SCHEMA), ` (schema ${MYCATALOG_SCHEMA})`)
  const projects = await readTextOrNull(join(dir, OLD_LAYOUT.projects))
  if (projects !== null) move(OLD_LAYOUT.projects, PROJECTS_PATH, because(projects.replace(OLD_LAYOUT.projectsSchema, PROJECTS_SCHEMA)), ` (schema ${PROJECTS_SCHEMA}, because paths)`)
  else { changes.push({ path: PROJECTS_PATH, text: `schema: ${PROJECTS_SCHEMA}\nowner: ${/^owner:\s*(\S+)/m.exec(marker)?.[1] ?? ''}\nprojects: []\n` }); lines.push(`write   ${PROJECTS_PATH} (empty)`) }
  for (const f of (await readdir(join(dir, BRAINDUMP_DIR)).catch(() => [] as string[])).filter(f => f.endsWith('.md')).sort()) {
    const slug = f.slice(0, -3)
    if (!SEGMENT_PATTERN.test(slug)) { lines.push(`keep    ${BRAINDUMP_DIR}/${f} (not a braindump name)`); continue }
    move(`${BRAINDUMP_DIR}/${f}`, braindumpPath(slug), (await readTextOrNull(join(dir, BRAINDUMP_DIR, f))) ?? '')
  }
  if (await exists(join(dir, BRAINDUMP_DIR, '.gitkeep'))) changes.push({ path: `${BRAINDUMP_DIR}/.gitkeep`, text: null }, { path: `${EPISODES_DIR}/.gitkeep`, text: '' })
  for (const f of (await readdir(join(dir, SUMMONPLAN_DIR)).catch(() => [] as string[])).filter(f => f.endsWith('.yaml')).sort()) {
    const t = (await readTextOrNull(join(dir, SUMMONPLAN_DIR, f))) ?? ''
    if (because(t) !== t) { changes.push({ path: `${SUMMONPLAN_DIR}/${f}`, text: because(t) }); lines.push(`rewrite ${SUMMONPLAN_DIR}/${f} (because paths)`) }
  }
  const pub = 'publication/github.toml'
  const pt = await readTextOrNull(join(dir, pub))
  if (pt !== null) {
    const next = because(pt).replace(/\bcatalog\.yaml\b/g, PROJECTS_PATH).replace(/\bmind\.yaml\b/g, CATALOG_FILE)
    if (next !== pt) { changes.push({ path: pub, text: next }); lines.push(`rewrite ${pub} (file entries)`) }
  }
  return { changes, lines }
}

export async function migrate(ctx: CatalogContext, o: { author: string; dryRun?: boolean }) {
  const s = await needSetting(ctx)
  if (o.dryRun) {
    const lines = await withLock(settingFile(ctx.area), async () => { await sync(ctx, s, 0); return (await migration(checkoutDir(ctx.area))).lines }, { what: 'the catalog' })
    return { ok: true, dryRun: true, message: `Would migrate ${s.repository.owner}/${s.repository.name} in one commit:`, lines, commit: null as string | null }
  }
  let lines: string[] = []
  const r = await commitChanges(ctx, s, async dir => { const m = await migration(dir); lines = m.lines; return m.changes }, o.author,
    `Migrate to the catalog layout: ${CATALOG_FILE}, ${PROJECTS_PATH}, ${EPISODES_DIR}/<path>/${BRAINDUMP_FILE} (user_catalog p1)`)
  return { ok: true, dryRun: false, message: `Migrated ${s.repository.owner}/${s.repository.name} (${r.commit.slice(0, 7)}). README.md is yours and was not rewritten.`, lines, commit: r.commit as string | null }
}
