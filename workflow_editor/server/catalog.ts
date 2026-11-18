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
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Issue } from '../shared/model.ts'
import type { BraindumpAttachmentRef } from '../shared/intake.ts'
import { citationCounts, citations, type Citation } from './citations.ts'
import {
  ARCHIVE_DIR, braindumpExcerpt, braindumpPath, braindumpTitle, BRAINDUMP_DIR, BRAINDUMP_FILE, CATALOG_FILE, CATALOG_REPOSITORY, CHALLENGES_DIR, EPISODES_DIR, INDEX_PATH, isBraindumpId,
  isPreferenceName, MAX_BRAINDUMP_DEPTH, METADATA_FILE, metadataPath, nameFromText, normalizeTag, normalizeTags, sameTag, tagsAfterText, MYCATALOG_SCHEMA, OLD_LAYOUT, OLD_LAYOUT_PROBLEM, PLAN_NAME_PATTERN, preferencePath, PREFERENCES_DIR, PROJECTS_PATH, PROJECTS_SCHEMA, PUBLICATION_CONTRACT, publishedPaths, readPublicationContract, REVIEW_FILE, reviewPath,
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
import { noteFollowUp } from './catalogFollowUp.ts'
import { dropBecause, renameBecause, parseMycatalog, parseProjects, parseSummonplan, readBraindumpMetadata, writeBraindumpMetadata } from './yamlDoc.ts'

export const CATALOG_SETTING = 'catalog.json'
// publicationWorkspace: where the owner publishes the catalog from (the folder
// agdev-external-publish works in); only its journal is read, for the last public commit.
// drafts (user_catalog p6 ex1): where drafts are kept, outside Git: shared://<share>/<folder>/ or an absolute folder; absent: <area>/.local/catalog-drafts/.
export interface CatalogSetting { repository: { id: number; owner: string; name: string }; branch: string; plan: string; publicationWorkspace?: string; drafts?: string; followUp?: boolean }
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
    ...(typeof raw.publicationWorkspace === 'string' && raw.publicationWorkspace ? { publicationWorkspace: raw.publicationWorkspace } : {}),
    ...(typeof raw.drafts === 'string' && raw.drafts ? { drafts: raw.drafts } : {}),
    ...(typeof raw.followUp === 'boolean' ? { followUp: raw.followUp } : {}) }
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
async function commitChanges(ctx: CatalogContext, s: CatalogSetting, changes: CatalogChange[] | ((dir: string) => Promise<CatalogChange[]>), author: string, message: string | (() => string), check?: (dir: string) => Promise<void>, after?: (dir: string) => Promise<void>): Promise<{ commit: string; changed: boolean }> {
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
      // after: a check of the changed tree; a refusal leaves the clone as it was.
      if (after) try { await after(dir) } catch (e) { await git(dir, ['reset', '-q', '--hard', 'HEAD']); await git(dir, ['clean', '-qfd']); throw e }
      if ((await git(dir, ['diff', '--cached', '--quiet'])).code === 0) return { commit: (await gitOk(dir, ['rev-parse', 'HEAD'])).trim(), changed: false }
      await gitOk(dir, ['commit', '-q', '--author', authorLine(author.trim()), '-m', typeof message === 'function' ? message() : message], { config: { 'user.name': 'agdev', 'user.email': 'agdev@agdev.invalid' } })
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
  // user_catalog p6 ex1: optional tags (metadata.yaml beside it). The body's
  // last change is `updated`; the metadata's is its own fact. A tag change does
  // not make the review stale: tags do not change what became real.
  tags: string[]
  metadata: { path: string; updated: Change | null; problem?: string } | null
}
// A preference (user_catalog p3): preferences/<name>.md, how the owner wants work done.
export interface PreferenceInfo { name: string; path: string; title: string; text: string; updated: Change | null; published: boolean }
export interface PlanInfo { name: string; path: string; plan: Summonplan | null; problem?: string; issues: Issue[] }
export interface CatalogSnapshot {
  setting: CatalogSetting
  web: string
  head: string
  catalog: { doc: CatalogDoc | null; problem?: string; issues: Issue[] }
  braindumps: BraindumpInfo[]
  preferences: PreferenceInfo[]
  plans: PlanInfo[]
  projects: { doc: ProjectsDoc | null; problem?: string; issues: Issue[] }
  index: IndexInfo
  archived: ArchiveInfo[]
  published: Map<string, string> // source path → public path
}
// user_catalog p6: a folder of archived braindumps (braindumps/archive/<name>/).
// Only counted and linked: nothing below it is read as content.
export interface ArchiveInfo { name: string; path: string; braindumps: number; web: string }
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
// Tags (metadata.yaml) are left out: they do not change what is or is not real (user_catalog p6 ex1).
async function lastChangeUnder(dir: string, under: string): Promise<Change | null> {
  const r = await git(dir, ['log', '-1', '-M100%', '--diff-filter=AMD', '--format=%H%x09%aI%x09%an', '--', under, `:(exclude,glob)${under}/**/${METADATA_FILE}`])
  const [commit, at, author] = r.stdout.trim().split('\n')[0].split('\t')
  return commit ? { commit, at, author } : null
}
const isAfter = async (dir: string, later: string, earlier: string) => later !== earlier && (await git(dir, ['merge-base', '--is-ancestor', earlier, later])).code === 0

async function readIndex(dir: string): Promise<IndexInfo> {
  const text = await readTextOrNull(join(dir, INDEX_PATH))
  if (text === null) return { path: INDEX_PATH, text: null, updated: null, stale: [], note: `No index yet (${INDEX_PATH}).` }
  const updated = await lastChange(dir, INDEX_PATH)
  const stale: IndexInfo['stale'] = []
  // Braindumps are those below braindumps/episodes/: one that left it (removed
  // or archived) counts, a change below braindumps/archive/ does not.
  if (updated) for (const under of [EPISODES_DIR, CHALLENGES_DIR]) {
    const c = await lastChangeUnder(dir, under)
    if (c && await isAfter(dir, c.commit, updated.commit)) stale.push({ ...c, under })
  }
  return { path: INDEX_PATH, text, updated, stale, note: stale.length ? `Changed since the index was written: ${stale.map(c => `${c.under}/ (${c.author}, ${c.at.slice(0, 10)}, ${c.commit.slice(0, 7)})`).join('; ')}.` : '' }
}

async function readArchives(dir: string, web: string, branch: string): Promise<ArchiveInfo[]> {
  const count = new Map<string, number>()
  for (const f of (await gitOk(dir, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', ARCHIVE_DIR])).split('\0').filter(Boolean)) {
    const name = f.slice(ARCHIVE_DIR.length + 1).split('/')[0]
    count.set(name, (count.get(name) ?? 0) + (f.endsWith(`/${BRAINDUMP_FILE}`) ? 1 : 0))
  }
  return [...count].sort(([a], [b]) => a.localeCompare(b)).map(([name, braindumps]) => ({ name, path: `${ARCHIVE_DIR}/${name}`, braindumps, web: `${web}/src/branch/${branch}/${ARCHIVE_DIR}/${name}` }))
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
  const mt = await readTextOrNull(join(dir, metadataPath(id)))
  const md = readBraindumpMetadata(mt)
  const metadata = mt === null ? null : { path: metadataPath(id), updated: await lastChange(dir, metadataPath(id)), ...(md.problem ? { problem: md.problem } : {}) }
  return { id, path, title: braindumpTitle(id, text), excerpt: braindumpExcerpt(text), ...(withText ? { text } : {}), updated, published: published.has(path), review, changedAfterReview, tags: md.tags, metadata }
}

// Every preferences/<name>.md, sorted by name. They are few and short, and
// every run is given them whole, so the text is always read.
async function readPreferences(dir: string, published: Map<string, string>): Promise<PreferenceInfo[]> {
  const out: PreferenceInfo[] = []
  for (const e of (await readdir(join(dir, PREFERENCES_DIR), { withFileTypes: true }).catch(() => [])).filter(e => e.isFile() && e.name.endsWith('.md') && isPreferenceName(e.name.slice(0, -3))).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = e.name.slice(0, -3), path = preferencePath(name)
    const text = (await readTextOrNull(join(dir, path))) ?? ''
    out.push({ name, path, title: braindumpTitle(name, text), text, updated: await lastChange(dir, path), published: published.has(path) })
  }
  return out
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
  const web = g.webUrl(s.repository.owner, s.repository.name)
  return { setting: s, web, head, catalog, braindumps, preferences: await readPreferences(dir, published), plans, projects, index: await readIndex(dir), archived: await readArchives(dir, web, s.branch), published }
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
  // cited (user_catalog p4): how many times it was cited by a message or a request here.
  // openProposals (user_catalog p6 ex2): the open proposals that can be applied, one line each on the card.
  // uncovered, rule (user_catalog p7): what the last link suggestion says no project serves; what an adopted rule says about it.
  braindumps: (BraindumpInfo & { projects: string[]; cited: number; proposals: number; openProposals: { id: string; by: string; changes: { op: 'add' | 'remove'; tag: string }[] }[]; uncovered?: string; rule?: { never?: string; suggest?: string; selected: boolean } })[]
  // user_catalog p7: asked texts (null when the drafts folder is not there), the link suggestion, the adopted rules.
  asked: import('./catalogDrafts.ts').AskedLine[] | null
  links: import('./catalogLinks.ts').LinksView
  rules: import('./catalogRules.ts').RuleView[]
  publicationCheck: import('./catalogRules.ts').PublicationCheck | null
  // user_catalog p8: what the owner's words make of each project, and the default licence; what waits for the owner (one list, its count).
  disclosure: import('./catalogRules.ts').Disclosure | null
  waiting: WaitingView
  // user_catalog p8: the published part in one line each: last publication, and whether the public list changed since.
  publication: { workspace: string | null; last: { publicCommit: string; sourceRev: string; at: string } | null; changedSince: boolean; destination: string } | null
  // user_catalog p6 ex2: what the follow-up is doing (server/catalogFollowUp.ts).
  followUp: import('./catalogFollowUp.ts').FollowUpView
  preferences: PreferenceInfo[]
  projects: ProjectGround[]
  plans: { name: string; intent: string; entries: number; problem?: string; errors: number; warnings: number }[]
  index: IndexInfo
  archived: ArchiveInfo[]
  challenges: ChallengesBrief
  issues: { where: string; issue: Issue }[]
  problems: string[]
}

// user_catalog p8 decision 17: everything that waits for the owner, at the top of the page; the count is on the navigation.
export interface WaitingItem { kind: 'answer' | 'links' | 'disclosure' | 'licence' | 'publisher' | 'publication'; title: string; detail?: string; href?: string; ask?: { draft: string; id: string }; n?: number | 'licence'; question?: import('./publicationFacts.ts').PublisherQuestion }
export interface WaitingView { count: number; items: WaitingItem[] }

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
export function relate(snap: CatalogSnapshot, reg: Known): { braindumps: (BraindumpInfo & { projects: string[] })[]; projects: ProjectGround[] } {
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

// The last publication of the catalog (its journal) and whether a selected file changed since.
async function publicationBrief(ctx: CatalogContext, snap: CatalogSnapshot): Promise<CatalogView['publication']> {
  const ws = snap.setting.publicationWorkspace ?? null
  const dir = checkoutDir(ctx.area)
  const p = await withLock(settingFile(ctx.area), () => readPublished(dir), { what: 'the catalog' })
  if (!p.contract) return null
  let last: NonNullable<CatalogView['publication']>['last'] = null
  if (ws) try {
    const j = JSON.parse((await readTextOrNull(join(ws, '.agdev', 'publication', 'github.json'))) ?? 'null') as { repositories?: Record<string, { publications?: { status?: string; public_commit?: string; source_rev?: string; published_at?: string }[] }> } | null
    const l = Object.values(j?.repositories ?? {}).flatMap(r => r.publications ?? []).filter(x => x.status === 'published' && x.public_commit).sort((a, b) => (a.published_at ?? '').localeCompare(b.published_at ?? '')).at(-1)
    if (l) last = { publicCommit: l.public_commit!, sourceRev: l.source_rev ?? '', at: l.published_at ?? '' }
  } catch { /* no journal */ }
  let changedSince = !last
  if (last?.sourceRev) changedSince = await withLock(settingFile(ctx.area), async () => {
    const d = await git(dir, ['diff', '--name-only', last!.sourceRev, 'HEAD'])
    if (d.code !== 0) return true
    return d.stdout.split('\n').filter(Boolean).some(f => p.paths.has(f) || f.startsWith('publication/'))
  }, { what: 'the catalog' })
  return { workspace: ws, last, changedSince, destination: p.destination }
}

async function waitingView(ctx: CatalogContext, o: { asked: import('./catalogDrafts.ts').AskedLine[] | null; links: import('./catalogLinks.ts').LinksView; disclosure: import('./catalogRules.ts').Disclosure | null; pub: CatalogView['publication'] }): Promise<WaitingView> {
  const items: WaitingItem[] = []
  for (const a of o.asked ?? []) {
    const open = a.actions.filter(x => x.state === 'proposed').length
    if (a.state === 'written' && (open || !a.actions.length)) items.push({ kind: 'answer', title: a.title, detail: open ? `${open} action${open === 1 ? '' : 's'} wait for Do it / No` : 'the summoner answered', ask: { draft: a.draft, id: a.id }, ...(a.run ? { href: a.run.href } : {}) })
  }
  const s = o.links.suggestion
  if (s?.open) items.push({ kind: 'links', title: `${s.open} suggested link${s.open === 1 ? '' : 's'}`, detail: 'OK / No under Braindumps and projects' })
  const cn: Record<string, string> = { runs: 'Run records', workflows: 'Workflows', episodes: 'Episodes' }
  for (const x of s?.disclosure ?? []) if (x.state === 'suggested' && x.content) items.push({ kind: 'disclosure', n: x.n, title: `${cn[x.content] ?? x.content} of ${x.project || 'every project'}: ${x.follows === 'never-publish' ? 'never published' : 'a criterion for publishing'}`, detail: `from ${x.braindump}: “${x.quote}”${x.follows === 'never-publish' ? ' — refused by the publication tool from now on unless you answer No' : ' — the publisher reads it once you answer OK; it selects nothing by itself'}` })
  for (const x of s?.disclosure ?? []) if (x.state === 'suggested' && !x.content) items.push({ kind: 'disclosure', n: x.n, title: x.follows === 'never-publish' ? `${x.project}: stated private` : `${x.project}: stated public`, detail: `from ${x.braindump}: “${x.quote}”${x.follows === 'never-publish' ? ' — kept private from now on unless you answer No' : ' — nothing follows until you answer OK'}` })
  if (s?.licence?.state === 'suggested') items.push({ kind: 'licence', n: 'licence', title: `Default licence ${s.licence.licence}`, detail: `from ${s.licence.braindump}: “${s.licence.quote}”` })
  if (o.pub?.changedSince) items.push({ kind: 'publication', title: 'The public list changed since the last publication', detail: o.pub.last ? `last published from ${o.pub.last.sourceRev.slice(0, 7)} at ${o.pub.last.at.slice(0, 10)}` : 'not published yet' })
  // A publisher run that waits on a question: answered here in one batch when it attached its scope proposal
  // (improve_publish p3), else on its run.
  try {
    for (const q of await (await import('./publicationFacts.ts')).publisherQuestions(ctx)) items.push({ kind: 'publisher', title: `The publisher asks (${q.workflow}/${q.run} ${q.question.id})`, detail: q.title ?? '', href: q.href, question: q })
  } catch { /* the publisher's runs cannot be read: not listed */ }
  return { count: items.length, items }
}

// The count alone, for the navigation (user_catalog p8 decision 17); no catalog: 0.
export async function waitingCount(ctx: CatalogContext): Promise<{ count: number }> {
  if (!await loadCatalogSetting(ctx.area)) return { count: 0 }
  const snap = await catalogSnapshot(ctx)
  const asked = await (await import('./catalogDrafts.ts')).listAsked(ctx).catch(() => null)
  const links = await (await import('./catalogLinks.ts')).linksView(ctx, snap)
  const disclosure = await (await import('./catalogRules.ts')).disclosure(ctx).catch(() => null)
  const pub = snap.published.size ? await publicationBrief(ctx, snap).catch(() => null) : null
  return { count: (await waitingView(ctx, { asked, links, disclosure, pub })).count }
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
  const cited = citationCounts(ctx.area)
  const open = new Map<string, { id: string; by: string; changes: { op: 'add' | 'remove'; tag: string }[] }[]>()
  for (const p of await tagProposals(ctx, { snap })) if (!p.stale) open.set(p.braindump, [...(open.get(p.braindump) ?? []), { id: p.id, by: p.by, changes: p.changes.map(c => ({ op: c.op, tag: c.tag })) }])
  const linksView = await (await import('./catalogLinks.ts')).linksView(ctx, snap)
  const rm = await import('./catalogRules.ts')
  const ruleList = await rm.rules(ctx).catch(e => { problems.push(`rules.yaml: ${(e as Error).message}`); return { rules: [] as import('./catalogRules.ts').RuleView[], problem: undefined as string | undefined } })
  if (ruleList.problem) problems.push(`rules.yaml cannot be read (${ruleList.problem}): no rule is in force until it is corrected`)
  const check = ruleList.rules.length ? await rm.publicationCheck(ctx).catch(() => null) : null
  const asked = await (await import('./catalogDrafts.ts')).listAsked(ctx).catch(() => null)
  const uncovered = new Map((linksView.suggestion?.uncovered ?? []).map(u => [u.braindump, u.why || 'no project serves this']))
  const disclosure = await rm.disclosure(ctx).catch(e => { problems.push(`disclosure: ${(e as Error).message}`); return null })
  const pub = snap.published.size ? await publicationBrief(ctx, snap).catch(() => null) : null
  const waiting = await waitingView(ctx, { asked, links: linksView, disclosure, pub })
  return {
    configured: true,
    repository: `${snap.setting.repository.owner}/${snap.setting.repository.name}`, web: snap.web, branch: snap.setting.branch, head: snap.head, plan: snap.setting.plan,
    title: snap.catalog.doc?.title ?? '', person: await personOf(ctx.area),
    ...(r => ({ projects: r.projects, braindumps: r.braindumps.map(b => ({ ...b, cited: cited.get(b.id) ?? 0, proposals: open.get(b.id)?.length ?? 0, openProposals: open.get(b.id) ?? [], ...(uncovered.has(b.id) && !b.projects.length ? { uncovered: uncovered.get(b.id)! } : {}), ...(check?.braindumps[b.id] ? { rule: check.braindumps[b.id] } : {}) })) }))(relate(snap, reg)),
    asked, links: linksView, rules: ruleList.rules, publicationCheck: check, disclosure, waiting, publication: pub,
    followUp: await (await import('./catalogFollowUp.ts')).followUpView(ctx.area),
    preferences: snap.preferences,
    plans: snap.plans.map(p => ({ name: p.name, intent: p.plan?.intent ?? '', entries: p.plan?.entries.length ?? 0, ...(p.problem ? { problem: p.problem } : {}), errors: p.issues.filter(i => i.severity === 'error').length, warnings: p.issues.filter(i => i.severity === 'warning').length })),
    index: snap.index, archived: snap.archived, challenges: await challengesBrief(ctx, snap.setting, snap.published),
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
  return { ...b, head: snap.head, web: `${snap.web}/src/branch/${snap.setting.branch}/${b.path}`, history: await historyOf(checkoutDir(ctx.area), b.path), projects, plans, citedBy: await citedBy(ctx, id),
    proposals: await tagProposals(ctx, { id, snap }) }
}

// ---- citing a braindump (user_catalog p4) ------------------------------------------

// The conversations and runs that cited a braindump, newest first, each with
// where it opens in the editor and whether the braindump's text changed since
// the cited commit.
// href: the run's view in the editor; a conversation opens in the conversation client.
export type CitedBy = Citation & { href: string | null; label: string; changed: boolean }
export async function citedBy(ctx: CatalogContext, id: string): Promise<CitedBy[]> {
  const list = citations(ctx.area, id)
  if (!list.length) return []
  const dir = checkoutDir(ctx.area)
  const now = (await git(dir, ['rev-parse', `HEAD:${braindumpPath(id)}`])).stdout.trim()
  const blobs = new Map<string, string>()
  const out: CitedBy[] = []
  for (const c of list) {
    if (!blobs.has(c.commit)) blobs.set(c.commit, (await git(dir, ['rev-parse', `${c.commit}:${braindumpPath(id)}`])).stdout.trim())
    const w = c.where
    out.push({ ...c, changed: blobs.get(c.commit) !== now,
      href: w.kind === 'conversation' ? null : `#/ws/${encodeURIComponent(w.workspace)}/run/${encodeURIComponent(w.workflow)}/${encodeURIComponent(w.run)}`,
      label: w.kind === 'conversation' ? `conversation ${w.conversation} #${w.message}` : `${w.workspace}/${w.workflow}/${w.run}` })
  }
  return out
}

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')
const showAt = async (dir: string, commit: string, path: string): Promise<string | null> => { const r = await git(dir, ['show', `${commit}:${path}`]); return r.code === 0 ? r.stdout : null }

// A braindump at the catalog's head now, or at the commit named: what a
// citation records. Refused when the path or the commit does not resolve: a
// message never carries a citation that cannot be read.
export async function pinBraindump(ctx: CatalogContext, id: string, at?: string): Promise<BraindumpAttachmentRef> {
  const s = await needSetting(ctx)
  needId(id)
  return withLock(settingFile(ctx.area), async () => {
    const head = await sync(ctx, s, 0)
    const dir = checkoutDir(ctx.area)
    let commit = head
    if (at) {
      if (!/^[0-9a-f]{7,64}$/.test(at)) throw new RequestError(400, `"${at}" is not a commit id`)
      const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${at}^{commit}`])
      if (r.code !== 0) throw new RequestError(404, `the catalog has no commit ${at}`, { code: 'missing' })
      commit = r.stdout.trim()
    }
    const text = await showAt(dir, commit, braindumpPath(id))
    if (text === null) throw new RequestError(404, `no braindump "${id}" in the catalog${at ? ` at ${commit.slice(0, 12)}` : ''} (${braindumpPath(id)}); wfe catalog braindump list`, { code: 'missing' })
    return { kind: 'braindump', id, commit, title: braindumpTitle(id, text), sha256: sha256(text) }
  }, { what: 'the catalog' })
}
export async function pinBraindumps(ctx: CatalogContext, refs: { id: string; at?: string }[]): Promise<BraindumpAttachmentRef[]> {
  if (refs.length > 20) throw new RequestError(400, 'a message cites at most 20 braindumps')
  const out: BraindumpAttachmentRef[] = []
  for (const r of refs) {
    const id = r.id.replace(/^\/+|\/+$/g, '')
    if (!out.some(x => x.id === id)) out.push(await pinBraindump(ctx, id, r.at))
  }
  return out
}

// The file a run is given for a cited braindump: what it is, the text at the
// cited commit, the review as it was then with its author and date, and the
// names of the projects this installation's plan grounded on it then (the
// names only: their records are theirs to be asked for).
export async function citedText(ctx: CatalogContext, ref: BraindumpAttachmentRef): Promise<string> {
  const s = await needSetting(ctx)
  return withLock(settingFile(ctx.area), async () => {
    const dir = checkoutDir(ctx.area)
    if (!await exists(join(dir, '.git')) || (await git(dir, ['cat-file', '-e', `${ref.commit}^{commit}`])).code !== 0) await sync(ctx, s, 0)
    const path = braindumpPath(ref.id)
    const text = await showAt(dir, ref.commit, path)
    if (text === null) throw new RequestError(404, `the cited braindump ${ref.id} cannot be read at ${ref.commit.slice(0, 12)}`)
    if (sha256(text) !== ref.sha256) throw new RequestError(409, `the cited braindump ${ref.id}@${ref.commit.slice(0, 12)}: its text is not the one cited (hash differs)`)
    const log = async (p: string) => { const [commit, at, author] = (await git(dir, ['log', '-1', '--format=%H%x09%aI%x09%an', ref.commit, '--', p])).stdout.trim().split('\t'); return commit ? { commit, at, author } : null }
    const written = await log(path)
    const review = await showAt(dir, ref.commit, reviewPath(ref.id))
    const reviewed = review === null ? null : await log(reviewPath(ref.id))
    const tags = readBraindumpMetadata(await showAt(dir, ref.commit, metadataPath(ref.id))).tags
    const pt = s.plan ? await showAt(dir, ref.commit, summonplanPath(s.plan)) : null
    const pp = pt === null ? null : parseSummonplan(pt)
    const projects = pp?.ok ? pp.model.entries.filter(e => e.because.includes(path)).map(e => e.project) : []
    const repo = `${s.repository.owner}/${s.repository.name}`
    return [
      `# Cited braindump: ${ref.title}`, '',
      `This is the braindump \`${ref.id}\` of the catalog ${repo}, as it was at commit ${ref.commit.slice(0, 12)} when it was cited with the words you were given.`,
      'It is the ground of this request: what the person stands on when asking. It is not an instruction to carry out in full, and it is not a preference (how work is done). Do what the request asks; read this to understand why it is asked and what it is part of.',
      `A later edit never changes this file. The present text: \`wfe catalog braindump show ${ref.id}\`.`, '',
      `- Path: \`${path}\`${written ? `; last changed by ${written.author}, ${written.at.slice(0, 10)} (${written.commit.slice(0, 12)})` : ''}`,
      `- Projects this installation's plan${s.plan ? ` (${s.plan})` : ''} grounded on it then: ${projects.length ? projects.join(', ') : 'none'}`,
      ...(tags.length ? [`- Tags then (the owner's optional labels, ${METADATA_FILE}; they ask for nothing by themselves): ${tags.join(', ')}`] : []),
      `- Review: ${reviewed ? `by ${reviewed.author}, ${reviewed.at.slice(0, 10)} (${reviewed.commit.slice(0, 12)}); below` : review !== null ? 'below' : 'none existed at this commit'}`, '',
      '---', '', '## The braindump', '', text.trimEnd(), '',
      ...(review !== null ? ['---', '', `## Its review${reviewed ? ` (${reviewed.author}, ${reviewed.at.slice(0, 10)})` : ''}`, '', 'A review is free text about the braindump: what of it became real, where, what did not.', '', review.trimEnd(), ''] : []),
    ].join('\n')
  }, { what: 'the catalog' })
}

// Whether each cited braindump's text changed since its cited commit: the
// last change of the present text when it differs, `removed` when it is gone.
export async function citedNow(ctx: CatalogContext, refs: { id: string; commit: string }[]): Promise<Map<string, { changed: Change | null; removed: boolean }>> {
  const out = new Map<string, { changed: Change | null; removed: boolean }>()
  if (!refs.length) return out
  const s = await loadCatalogSetting(ctx.area)
  if (!s) return out
  await withLock(settingFile(ctx.area), async () => {
    await sync(ctx, s, 10_000)
    const dir = checkoutDir(ctx.area)
    for (const r of refs) {
      const key = `${r.id}@${r.commit}`
      if (out.has(key)) continue
      const path = braindumpPath(r.id)
      const now = await git(dir, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`])
      if (now.code !== 0) { out.set(key, { changed: null, removed: true }); continue }
      const then = (await git(dir, ['rev-parse', '--verify', '--quiet', `${r.commit}:${path}`])).stdout.trim()
      out.set(key, { changed: then === now.stdout.trim() ? null : await lastChange(dir, path), removed: false })
    }
  }, { what: 'the catalog' })
  return out
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
// user_catalog p6 ex2: tags written in the text are the braindump's tags
// (shared/catalog.ts textTags): on every commit of a body, what the new text
// writes is added and what the old text wrote and the new one does not is
// removed, in the same commit; tags set otherwise stay. The text is kept as typed.
export async function changeBraindump(ctx: CatalogContext, o: { op: BraindumpOp; id: string; text?: string; author: string; base?: string; message?: string; force?: boolean; tags?: string[]; trailer?: string }) {
  const s = await needSetting(ctx)
  needId(o.id)
  const path = braindumpPath(o.id)
  if (o.op !== 'remove' && (typeof o.text !== 'string' || !o.text.trim())) throw new RequestError(400, 'a braindump needs its text')
  const text = o.op === 'remove' ? null : o.text!.endsWith('\n') ? o.text! : `${o.text}\n`
  const given = o.op === 'add' && o.tags?.length ? needTags(o.tags) : []
  let tagNote = ''
  // Removing a braindump removes its review and its metadata with it; other files of the folder are the owner's and stay.
  const changes = async (dir: string): Promise<CatalogChange[]> => {
    if (o.op === 'remove') return [{ path, text }, { path: reviewPath(o.id), text: null }, { path: metadataPath(o.id), text: null }]
    const meta = o.op === 'add' ? null : await readTextOrNull(join(dir, metadataPath(o.id)))
    const present = o.op === 'add' ? given : readBraindumpMetadata(meta).tags
    const next = needTags(tagsAfterText(present, o.op === 'add' ? null : await readTextOrNull(join(dir, path)), text!))
    const before = o.op === 'add' ? [] : present
    const add = next.filter(t => !before.some(b => sameTag(b, t))), rm = before.filter(t => !next.some(n => sameTag(n, t)))
    tagNote = add.length || rm.length ? tagWords(add, rm) : ''
    return [{ path, text }, ...(add.length || rm.length ? [{ path: metadataPath(o.id), text: next.length || meta !== null ? writeBraindumpMetadata(meta, next) : null }] : [])]
  }
  const r = await commitChanges(ctx, s, changes, o.author, () => [o.message?.trim() || `${o.op === 'add' ? 'Add' : o.op === 'edit' ? 'Edit' : 'Remove'} braindump ${o.id}`,
    ...(tagNote ? ['', `Tags from the text: ${tagNote}`] : []), ...(o.trailer ? ['', o.trailer] : [])].join('\n'), async dir => {
    const present = await exists(join(dir, path))
    if (o.op === 'add' && present) throw new RequestError(409, `braindump "${o.id}" already exists; edit it instead`, { code: 'taken' })
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
  if (r.changed) await noteFollowUp(ctx.area, o.op === 'remove' ? { drop: o.id, index: true, by: o.author.trim() } : { review: o.id, by: o.author.trim() })
  return { ok: true, message: r.changed ? `${o.op === 'add' ? 'Added' : o.op === 'edit' ? 'Changed' : 'Removed'} braindump ${o.id} (${r.commit.slice(0, 7)})${tagNote ? `; tags from the text: ${tagNote}` : ''}.` : `Braindump ${o.id} is unchanged.`, commit: r.commit, changed: r.changed, path }
}

// user_catalog p6 ex2: the path the service gives a new braindump (decision 3
// of the plan): the name from its first line, never one that is taken or that
// any braindumps/archive/*/ held; then -2, -3, …
export async function freePath(ctx: CatalogContext, text: string): Promise<string> {
  const base = nameFromText(text)
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  const taken = (p: string) => snap.braindumps.some(b => b.id === p || b.id.startsWith(`${p}/`))
  for (let n = 1; n < 1000; n++) {
    const p = n === 1 ? base : `${base}-${n}`
    if (!taken(p) && !(await archivedAt(ctx, p)).length) return p
  }
  throw new RequestError(409, `no free path near ${base}`)
}

// user_catalog p6 ex2: renaming a braindump. The files directly in its folder
// move (folders below it are other braindumps or the owner's, and stay); every
// because naming it names the new path; one commit. What cited the old path
// shows it removed, as after an archive.
export async function moveBraindump(ctx: CatalogContext, o: { from: string; to: string; author: string; reuseArchived?: boolean }) {
  const s = await needSetting(ctx)
  needId(o.from); needId(o.to)
  if (o.from === o.to) throw new RequestError(400, 'the new path is the present one')
  if (o.to.startsWith(`${o.from}/`)) throw new RequestError(400, `${o.to} is inside ${o.from}: choose a path outside it`)
  if (!o.reuseArchived) {
    const archived = await archivedAt(ctx, o.to)
    if (archived.length) throw new RequestError(409, `${archived.join(', ')} held a braindump at ${o.to}: a braindump there takes that old identity. Choose another path (or --reuse-archived if it is the same braindump)`, { code: 'archived-path', archived })
  }
  const fromPath = braindumpPath(o.from), toPath = braindumpPath(o.to)
  let moved: string[] = [], stayed: string[] = [], because: { file: string; entry: string }[] = []
  const r = await commitChanges(ctx, s, async dir => {
    const src = join(dir, EPISODES_DIR, o.from)
    const entries = await readdir(src, { withFileTypes: true })
    moved = entries.filter(e => e.isFile()).map(e => e.name).sort()
    stayed = entries.filter(e => e.isDirectory()).map(e => e.name).sort()
    const out: CatalogChange[] = []
    for (const f of moved) out.push({ path: `${EPISODES_DIR}/${o.from}/${f}`, text: null }, { path: `${EPISODES_DIR}/${o.to}/${f}`, text: (await readTextOrNull(join(src, f))) ?? '' })
    because = []
    const rewrite = async (file: string, key: 'entries' | 'projects') => {
      const t = await readTextOrNull(join(dir, file))
      if (t === null) return
      const x = renameBecause(t, key, fromPath, toPath)
      if (!x) { if (t.includes(fromPath)) throw new RequestError(409, `${file} cannot be read as YAML and names ${fromPath}: nothing was moved`); return }
      if (x.changed.length) { out.push({ path: file, text: x.text }); for (const c of x.changed) because.push({ file, entry: c.entry }) }
    }
    for (const f of (await readdir(join(dir, SUMMONPLAN_DIR)).catch(() => [] as string[])).filter(f => f.endsWith('.yaml')).sort()) await rewrite(`${SUMMONPLAN_DIR}/${f}`, 'entries')
    await rewrite(PROJECTS_PATH, 'projects')
    return out
  }, o.author, () => [`Rename braindump ${o.from} to ${o.to}`, '', `Moved ${moved.join(', ')}${because.length ? `; because rewritten in ${because.map(b => `${b.file} (${b.entry})`).join(', ')}` : ''}.`].join('\n'), async dir => {
    if (!await exists(join(dir, fromPath))) throw new RequestError(404, `no braindump "${o.from}"`)
    const there = (await readdir(join(dir, EPISODES_DIR, o.to), { withFileTypes: true }).catch(() => [])).filter(e => e.isFile())
    if (there.length) throw new RequestError(409, `the path "${o.to}" holds ${there.map(e => e.name).join(', ')}: choose another path`, { code: 'taken' })
  })
  await noteFollowUp(ctx.area, { rename: { from: o.from, to: o.to }, index: true, by: o.author.trim() })
  return { ok: true, message: `Renamed braindump ${o.from} to ${o.to} (${r.commit.slice(0, 7)}): moved ${moved.join(', ')}${because.length ? `; because rewritten for ${because.map(b => b.entry).join(', ')}` : ''}${stayed.length ? `; folders below it stayed: ${stayed.join(', ')}` : ''}. What cited ${o.from} shows it removed.`, commit: r.commit, from: o.from, to: o.to, moved, because, stayed }
}

// ---- tags (user_catalog p6 ex1) ------------------------------------------------------
//
// A braindump's optional tags are metadata.yaml beside it. Setting them is one
// commit of that file only: the body is not touched and its last change stays
// what it was. Tags are never required and never refused for what they mean.
const needTags = (raw: string[]) => {
  const n = normalizeTags(raw)
  if (n.problems.length) throw new RequestError(400, `tags: ${n.problems.join('; ')}`)
  return n.tags
}
// base for metadata: the metadata's last commit read, or "none" when it had no metadata.
async function refuseIfMetadataChanged(dir: string, id: string, base: string | undefined) {
  if (!base) return
  const last = await lastChange(dir, metadataPath(id))
  if (base === 'none') { if (last && await exists(join(dir, metadataPath(id)))) throw new RequestError(409, `the tags of "${id}" were set since you read them (by ${last.author} at ${last.at}, ${last.commit.slice(0, 7)}); read them again`, { code: 'stale' }); return }
  await refuseIfChangedSince(dir, metadataPath(id), base, `the tags of "${id}"`)
}
const tagWords = (add: string[], remove: string[]) => [...add.map(t => `+${t}`), ...remove.map(t => `-${t}`)].join(' ')

export async function setTags(ctx: CatalogContext, o: { id: string; tags?: string[]; add?: string[]; remove?: string[]; author: string; base?: string; message?: string; trailer?: string }) {
  const s = await needSetting(ctx)
  needId(o.id)
  if (!o.tags && !o.add?.length && !o.remove?.length) throw new RequestError(400, 'give the tags (tags), or tags to add or remove')
  const path = metadataPath(o.id)
  let before: string[] = [], after: string[] = []
  const r = await commitChanges(ctx, s, async dir => {
    const cur = await readTextOrNull(join(dir, path))
    before = readBraindumpMetadata(cur).tags
    let next = o.tags ? needTags(o.tags) : [...before]
    for (const t of o.add?.length ? needTags(o.add) : []) if (!next.some(x => sameTag(x, t))) next.push(t)
    for (const t of o.remove ?? []) next = next.filter(x => !sameTag(x, t.replace(/^#+/, '').trim()))
    after = needTags(next)
    return [{ path, text: writeBraindumpMetadata(cur, after) }]
  }, o.author, () => {
    const add = after.filter(t => !before.some(b => sameTag(b, t))), rm = before.filter(t => !after.some(a => sameTag(a, t)))
    return [o.message?.trim() || `Tags of braindump ${o.id}: ${tagWords(add, rm) || 'reordered'}`, ...(o.trailer ? ['', o.trailer] : [])].join('\n')
  }, async dir => {
    if (!await exists(join(dir, braindumpPath(o.id)))) throw new RequestError(404, `no braindump "${o.id}"`)
    await refuseIfMetadataChanged(dir, o.id, o.base)
  })
  return { ok: true, message: r.changed ? `Tags of ${o.id}: ${after.join(', ') || 'none'} (${r.commit.slice(0, 7)}).` : `The tags of ${o.id} are unchanged.`, commit: r.commit, changed: r.changed, path, tags: after, before }
}

// ---- tag proposals ------------------------------------------------------------------
//
// An agent (or a person) proposes tags to add or remove, each with its reason,
// against the versions it read: the body's and the metadata's last commits. A
// proposal is not metadata: it is kept outside Git, in the service's area
// (<area>/.local/catalog-proposals/<id>.json), and changes nothing until the
// owner accepts chosen changes of it, which is one catalog commit in the
// owner's name naming the proposal and its proposer. When the braindump or its
// tags changed after the proposal, it is stale: shown, never applied.
export interface TagChange { op: 'add' | 'remove'; tag: string; reason: string }
export interface TagProposal {
  schema: 'ag.catalog-tag-proposal.v1'
  id: string; braindump: string; changes: TagChange[]; by: string; at: string; run?: string; note?: string
  base: { body: string | null; metadata: string | null; head: string }
  state: 'open' | 'applied' | 'dismissed'
  decided?: { by: string; at: string; accepted: TagChange[]; commit?: string }
}
export type TagProposalView = TagProposal & { stale: boolean; staleReason?: string }
const proposalDir = (area: string) => join(area, '.local', 'catalog-proposals')
const PROPOSAL_ID = /^tp-[0-9]{8}-[0-9a-f]{8}$/
const newId = (prefix: string) => `${prefix}-${localDate().replace(/-/g, '')}-${randomBytes(4).toString('hex')}`

async function readProposal(area: string, id: string): Promise<TagProposal> {
  if (!PROPOSAL_ID.test(id)) throw new RequestError(400, `"${id}" is not a tag proposal id`)
  const t = await readTextOrNull(join(proposalDir(area), `${id}.json`))
  if (t === null) throw new RequestError(404, `no tag proposal ${id}`)
  return JSON.parse(t) as TagProposal
}
async function listProposals(area: string): Promise<TagProposal[]> {
  const out: TagProposal[] = []
  for (const f of (await readdir(proposalDir(area)).catch(() => [] as string[])).filter(f => f.endsWith('.json')).sort()) {
    try { out.push(JSON.parse((await readTextOrNull(join(proposalDir(area), f))) ?? 'null') as TagProposal) } catch { /* a broken file is not a proposal */ }
  }
  return out.filter(p => p && p.schema === 'ag.catalog-tag-proposal.v1')
}
const staleness = (p: TagProposal, b: BraindumpInfo | undefined): { stale: boolean; staleReason?: string } => {
  if (!b) return { stale: true, staleReason: 'the braindump is no longer in the catalog' }
  if ((b.updated?.commit ?? null) !== p.base.body) return { stale: true, staleReason: `the braindump's text changed after the proposal (${b.updated?.commit.slice(0, 7) ?? 'none'})` }
  const m = b.metadata?.updated?.commit ?? null
  if (m !== p.base.metadata && !(m === null && !b.metadata)) return { stale: true, staleReason: `its tags changed after the proposal (${m?.slice(0, 7) ?? 'none'})` }
  if (p.base.metadata !== null && !b.metadata) return { stale: true, staleReason: 'its tags were removed after the proposal' }
  return { stale: false }
}

export async function proposeTags(ctx: CatalogContext, o: { id: string; changes: { op?: string; tag?: string; reason?: string }[]; by: string; run?: string; note?: string; base?: string }) {
  needId(o.id)
  if (!o.by.trim()) throw new RequestError(400, 'a proposal needs its proposer (--author)')
  if (!Array.isArray(o.changes) || !o.changes.length) throw new RequestError(400, 'a proposal needs at least one change: {"op": "add"|"remove", "tag", "reason"}')
  if (o.changes.length > 32) throw new RequestError(400, 'at most 32 changes in one proposal')
  const changes: TagChange[] = o.changes.map((c, i) => {
    if (c.op !== 'add' && c.op !== 'remove') throw new RequestError(400, `change ${i + 1}: op is "add" or "remove"`)
    const n = normalizeTag(String(c.tag ?? ''))
    if ('problem' in n) throw new RequestError(400, `change ${i + 1}: ${n.problem}`)
    const reason = String(c.reason ?? '').trim()
    if (!reason) throw new RequestError(400, `change ${i + 1} (${n.tag}): give the reason, from the braindump's text`)
    return { op: c.op, tag: n.tag, reason: reason.slice(0, 2000) }
  })
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  const b = snap.braindumps.find(x => x.id === o.id)
  if (!b) throw new RequestError(404, `no braindump "${o.id}"`)
  if (o.base && b.updated && !b.updated.commit.startsWith(o.base) && o.base !== snap.head) throw new RequestError(409, `braindump "${o.id}" changed since ${o.base.slice(0, 7)} (now ${b.updated.commit.slice(0, 7)}); read it again before proposing`, { code: 'stale' })
  const p: TagProposal = { schema: 'ag.catalog-tag-proposal.v1', id: newId('tp'), braindump: o.id, changes, by: o.by.trim(), at: new Date().toISOString(),
    ...(o.run ? { run: o.run } : {}), ...(o.note?.trim() ? { note: o.note.trim().slice(0, 2000) } : {}),
    base: { body: b.updated?.commit ?? null, metadata: b.metadata?.updated?.commit ?? null, head: snap.head }, state: 'open' }
  await mkdir(proposalDir(ctx.area), { recursive: true })
  await atomicWrite(join(proposalDir(ctx.area), `${p.id}.json`), `${JSON.stringify(p, null, 1)}\n`)
  return { ok: true, message: `Proposed for ${o.id}: ${tagWords(changes.filter(c => c.op === 'add').map(c => c.tag), changes.filter(c => c.op === 'remove').map(c => c.tag))} (proposal ${p.id}). Nothing is changed until the owner accepts.`, proposal: p }
}

export async function tagProposals(ctx: CatalogContext, o: { id?: string; all?: boolean; snap?: CatalogSnapshot } = {}): Promise<TagProposalView[]> {
  const list = (await listProposals(ctx.area)).filter(p => (!o.id || p.braindump === o.id) && (o.all || p.state === 'open'))
  if (!list.length) return []
  const snap = o.snap ?? await catalogSnapshot(ctx)
  return list.map(p => ({ ...p, ...(p.state === 'open' ? staleness(p, snap.braindumps.find(b => b.id === p.braindump)) : { stale: false }) }))
}

// accept: the changes accepted, as "add:<tag>" / "remove:<tag>" (or the tag alone); the rest are declined.
export async function decideTagProposal(ctx: CatalogContext, o: { proposal: string; accept?: string[]; dismiss?: boolean; author: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'deciding a proposal needs your name (--author)')
  return withLock(join(proposalDir(ctx.area), o.proposal), async () => {
    const p = await readProposal(ctx.area, o.proposal)
    if (p.state !== 'open') throw new RequestError(409, `proposal ${p.id} was already ${p.state} (by ${p.decided?.by ?? '?'})`)
    const write = (next: TagProposal) => atomicWrite(join(proposalDir(ctx.area), `${next.id}.json`), `${JSON.stringify(next, null, 1)}\n`)
    if (o.dismiss) {
      const next: TagProposal = { ...p, state: 'dismissed', decided: { by: o.author.trim(), at: new Date().toISOString(), accepted: [] } }
      await write(next)
      return { ok: true, message: `Dismissed proposal ${p.id}; the tags of ${p.braindump} are unchanged.`, proposal: next, commit: null as string | null }
    }
    const keys = new Set((o.accept ?? []).map(k => k.includes(':') ? k : `add:${k}`).map(k => k.toLowerCase()))
    const accepted = p.changes.filter(c => keys.has(`${c.op}:${c.tag}`.toLowerCase()))
    if (!accepted.length) throw new RequestError(400, `choose the changes to accept (${p.changes.map(c => `${c.op}:${c.tag}`).join(', ')}), or dismiss the proposal`)
    const s = await needSetting(ctx)
    const path = metadataPath(p.braindump)
    let after: string[] = []
    const r = await commitChanges(ctx, s, async dir => {
      const cur = await readTextOrNull(join(dir, path))
      let next = readBraindumpMetadata(cur).tags
      for (const c of accepted) next = c.op === 'add' ? next.some(t => sameTag(t, c.tag)) ? next : [...next, c.tag] : next.filter(t => !sameTag(t, c.tag))
      after = needTags(next)
      return [{ path, text: writeBraindumpMetadata(cur, after) }]
    }, o.author, () => [`Tags of braindump ${p.braindump}: ${tagWords(accepted.filter(c => c.op === 'add').map(c => c.tag), accepted.filter(c => c.op === 'remove').map(c => c.tag))}`, '',
      `Proposed by ${p.by}${p.run ? ` (${p.run})` : ''}, proposal ${p.id}; accepted by ${o.author.trim()}${accepted.length < p.changes.length ? ` (${accepted.length} of ${p.changes.length} changes)` : ''}.`].join('\n'), async dir => {
      if (!await exists(join(dir, braindumpPath(p.braindump)))) throw new RequestError(409, `braindump "${p.braindump}" is no longer in the catalog: the proposal cannot be applied`, { code: 'stale' })
      const body = await lastChange(dir, braindumpPath(p.braindump))
      if ((body?.commit ?? null) !== p.base.body) throw new RequestError(409, `braindump "${p.braindump}" changed after this proposal (${body?.commit.slice(0, 7)}): it is not applied; read the braindump again, set the tags yourself or ask for a new proposal`, { code: 'stale' })
      await refuseIfMetadataChanged(dir, p.braindump, p.base.metadata ?? 'none').catch(e => { throw new RequestError(409, `the tags of "${p.braindump}" changed after this proposal: it is not applied (${(e as Error).message})`, { code: 'stale' }) })
    })
    const next: TagProposal = { ...p, state: 'applied', decided: { by: o.author.trim(), at: new Date().toISOString(), accepted, commit: r.commit } }
    await write(next)
    return { ok: true, message: `Accepted ${accepted.length} of ${p.changes.length} proposed change${p.changes.length === 1 ? '' : 's'} for ${p.braindump}: tags ${after.join(', ') || 'none'} (${r.commit.slice(0, 7)}).`, proposal: next, commit: r.commit as string | null }
  }, { what: `tag proposal ${o.proposal}` })
}

// ---- registering a draft (user_catalog p6 ex1, server/catalogDrafts.ts) ----------------
//
// A draft becomes a braindump through the same writer: braindump.md and its
// metadata.yaml in one commit, marked with the registration's operation id so
// that a retry after an unknown result finds what was committed.
export const REGISTRATION_TRAILER = 'Draft-Registration'
export async function registerBraindump(ctx: CatalogContext, o: { id: string; text: string; tags: string[]; author: string; operation: string; draft: string; revision: number }) {
  const s = await needSetting(ctx)
  needId(o.id)
  if (!o.text.trim()) throw new RequestError(400, 'a braindump needs its text')
  const text = o.text.endsWith('\n') ? o.text : `${o.text}\n`
  const tags = needTags(tagsAfterText(needTags(o.tags), null, text))
  const r = await commitChanges(ctx, s, [{ path: braindumpPath(o.id), text }, ...(tags.length ? [{ path: metadataPath(o.id), text: writeBraindumpMetadata(null, tags) }] : [])], o.author,
    [`Add braindump ${o.id}`, '', `Registered from a draft (revision ${o.revision}).`, '', `${REGISTRATION_TRAILER}: ${o.operation}`].join('\n'), async dir => {
      if (await exists(join(dir, braindumpPath(o.id)))) throw new RequestError(409, `the path "${o.id}" is taken: braindump ${braindumpPath(o.id)} exists. Choose another path; the draft is kept`, { code: 'taken' })
    })
  if (r.changed) await noteFollowUp(ctx.area, { review: o.id, by: o.author.trim() })
  return { commit: r.commit, changed: r.changed, path: braindumpPath(o.id), tags }
}
// The commit on the catalog's branch that carries this registration, with what it holds now.
export async function findRegistration(ctx: CatalogContext, operation: string): Promise<{ commit: string; id: string | null; text: string | null; tags: string[] } | null> {
  const s = await needSetting(ctx)
  return withLock(settingFile(ctx.area), async () => {
    await sync(ctx, s, 0)
    const dir = checkoutDir(ctx.area)
    const commit = (await git(dir, ['log', '-1', '--format=%H', '--fixed-strings', `--grep=${REGISTRATION_TRAILER}: ${operation}`, 'HEAD'])).stdout.trim()
    if (!commit) return null
    const files = (await git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit])).stdout.split('\n').filter(Boolean)
    const path = files.find(f => f.startsWith(`${EPISODES_DIR}/`) && f.endsWith(`/${BRAINDUMP_FILE}`))
    const id = path ? braindumpIdOf(path) : null
    const text = path ? await showAt(dir, commit, path) : null
    const mt = id ? await showAt(dir, commit, metadataPath(id)) : null
    return { commit, id, text, tags: readBraindumpMetadata(mt).tags }
  }, { what: 'the catalog' })
}
// Archive folders that hold a braindump at this path: a new braindump there would take an old identity.
export async function archivedAt(ctx: CatalogContext, id: string): Promise<string[]> {
  needId(id)
  const snap = await catalogSnapshot(ctx)
  const dir = checkoutDir(ctx.area)
  const out: string[] = []
  for (const a of snap.archived) if (await exists(join(dir, a.path, id, BRAINDUMP_FILE))) out.push(`${a.path}/${id}`)
  return out
}

// ---- archiving (user_catalog p6) ----------------------------------------------------
//
// Archiving moves a braindump with its review from braindumps/episodes/<path>/
// to braindumps/archive/<date>/<path>/. The one rule reads braindumps only
// below braindumps/episodes/, so an archived one is no braindump any more: it
// grounds nothing, is not reviewed, not indexed and not offered for citing; it
// stays readable in the tree. The same commit removes it from every `because`
// (summonplans/*.yaml and projects.yaml; a list left empty is "no ground", and
// no ground is written in its place) and records in the folder's README.md
// which projects named it. A tag archive/<date> marks the commit before: the
// last state with the braindumps in place. Citation records are not touched:
// what was cited keeps its text at its commit.
export interface ArchiveMove { id: string; title: string; from: string; to: string; review: boolean; metadata?: boolean; updated: Change | null; named: { where: string; projects: string[] }[] }
export interface ArchiveBecause { file: string; entry: string; before: string[]; after: string[] }
interface ArchivePlan { date: string; folder: string; tag: string; parent: string; moves: ArchiveMove[]; because: ArchiveBecause[]; warnings: string[]; changes: CatalogChange[] }

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const ARCHIVE_README = (date: string) => `# Braindumps archived on ${date}

These texts were braindumps of this catalog. They were archived: moved here, each with its review,
from \`${EPISODES_DIR}/<path>/\`. agdev reads braindumps only below \`${EPISODES_DIR}/\`, so nothing
here grounds a project, is reviewed, is listed in the index or is offered for citing. They are kept
to be read.

- A message or a run that cited one of them keeps the text it cited, at the commit it cited. Where
  the citation is shown it says that the braindump was removed.
- Do not write a new braindump at one of these paths unless it is meant to be the same braindump:
  what cited the old one is then listed as having cited the new one.
- Each list below says which projects named the braindump in \`because\` when it was archived. It
  was taken out of those \`because\` lists in the same commit, and no other ground was written in
  its place.
`

async function planArchive(ctx: CatalogContext, s: CatalogSetting, dir: string, o: { id?: string; all?: boolean; author: string; note?: string }): Promise<ArchivePlan> {
  const g = needGitea(ctx)
  const all = await braindumpIds(dir)
  if (o.id && !all.includes(o.id)) throw new RequestError(404, `no braindump "${o.id}" (${braindumpPath(o.id)}); wfe catalog braindump list`)
  const ids = o.id ? [o.id] : all
  if (!ids.length) throw new RequestError(409, `the catalog has no braindump below ${EPISODES_DIR}/: nothing to archive`)
  const date = localDate(), folder = `${ARCHIVE_DIR}/${date}`
  const parent = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim()
  // The tag marks the commit before this archive; a later archive of the same day gets a numbered one.
  const lr = await git(dir, ['ls-remote', '--tags', '--', g.cloneUrl(s.repository.owner, s.repository.name), `refs/tags/archive/${date}*`], { env: await wrap(() => g.gitEnv()), timeoutMs: 60_000 })
  if (lr.code !== 0) throw new RequestError(502, `reading the catalog's tags failed: ${lr.stderr.trim()}`)
  const tags = new Set(lr.stdout.split('\n').map(l => l.split('\t')[1]?.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')).filter(Boolean))
  let tag = `archive/${date}`
  for (let n = 2; tags.has(tag); n++) tag = `archive/${date}.${n}`

  const gone = new Set(ids.map(braindumpPath))
  const changes: CatalogChange[] = [], because: ArchiveBecause[] = [], warnings: string[] = []
  const named = new Map<string, { where: string; projects: string[] }[]>()
  const rewrite = async (file: string, key: 'entries' | 'projects', where: string) => {
    const text = await readTextOrNull(join(dir, file))
    if (text === null) return
    const r = dropBecause(text, key, gone)
    if (!r) { if ([...gone].some(p => text.includes(p))) warnings.push(`${file} cannot be read as YAML and names an archived braindump: its because lists were not changed`); return }
    if (!r.changed.length) return
    changes.push({ path: file, text: r.text })
    for (const c of r.changed) {
      because.push({ file, ...c })
      for (const p of c.before.filter(b => gone.has(b))) {
        const list = named.get(p) ?? []
        const at = list.find(x => x.where === where) ?? (list.push({ where, projects: [] }), list.at(-1)!)
        at.projects.push(c.entry)
        named.set(p, list)
      }
    }
  }
  for (const f of (await readdir(join(dir, SUMMONPLAN_DIR)).catch(() => [] as string[])).filter(f => f.endsWith('.yaml')).sort()) await rewrite(`${SUMMONPLAN_DIR}/${f}`, 'entries', `plan \`${f.slice(0, -5)}\``)
  await rewrite(PROJECTS_PATH, 'projects', `\`${PROJECTS_PATH}\``)

  // A path already in the day's folder gets a numbered folder, never an overwrite.
  const taken = new Set<string>()
  const moves: ArchiveMove[] = []
  const lines: string[] = []
  for (const id of ids) {
    let to = id
    for (let n = 2; taken.has(to) || await exists(join(dir, folder, to, BRAINDUMP_FILE)) || await exists(join(dir, folder, to, REVIEW_FILE)) || await exists(join(dir, folder, to, METADATA_FILE)); n++) to = `${id}.${n}`
    taken.add(to)
    const text = (await readTextOrNull(join(dir, braindumpPath(id)))) ?? ''
    const review = await readTextOrNull(join(dir, reviewPath(id)))
    const updated = await lastChange(dir, braindumpPath(id))
    const reviewed = review === null ? null : await lastChange(dir, reviewPath(id))
    changes.push({ path: braindumpPath(id), text: null }, { path: `${folder}/${to}/${BRAINDUMP_FILE}`, text })
    if (review !== null) changes.push({ path: reviewPath(id), text: null }, { path: `${folder}/${to}/${REVIEW_FILE}`, text: review })
    // Its tags go with it (user_catalog p6 ex1): metadata.yaml is agdev's, not an unrelated file of the folder.
    const meta = await readTextOrNull(join(dir, metadataPath(id)))
    if (meta !== null) changes.push({ path: metadataPath(id), text: null }, { path: `${folder}/${to}/${METADATA_FILE}`, text: meta })
    const tags = readBraindumpMetadata(meta).tags
    const m: ArchiveMove = { id, title: braindumpTitle(id, text), from: `${EPISODES_DIR}/${id}`, to: `${folder}/${to}`, review: review !== null, metadata: meta !== null, updated, named: named.get(braindumpPath(id)) ?? [] }
    moves.push(m)
    const say = (c: Change | null) => c ? `\`${c.commit.slice(0, 12)}\` (${c.author}, ${c.at.slice(0, 10)})` : 'not committed'
    lines.push(`- [\`${id}\`](${to}/${BRAINDUMP_FILE})${m.title === id ? '' : `: ${m.title}`}`,
      `  - last change: ${say(updated)}`,
      `  - review: ${review === null ? 'none' : `[${REVIEW_FILE}](${to}/${REVIEW_FILE}), ${say(reviewed)}`}`,
      ...(tags.length ? [`  - tags: ${tags.join(', ')}`] : []),
      ...(m.named.length ? m.named.map(n => `  - ${n.where}: ${n.projects.join(', ')}`) : ['  - named by no project']))
  }
  const pub = await readTextOrNull(join(dir, PUBLICATION_CONTRACT))
  if (pub !== null) for (const id of ids) if (new RegExp(`${EPISODES_DIR}/${id.replace(/[.]/g, '\\.')}(["'/]|$)`, 'm').test(pub)) warnings.push(`${PUBLICATION_CONTRACT} still names ${EPISODES_DIR}/${id}: take it out of the file list before the next publication`)

  const readme = `${folder}/README.md`
  const before = await readTextOrNull(join(dir, readme))
  const section = [`## ${new Date().toISOString().slice(0, 16)}Z, by ${o.author.trim() || '(dry run)'}`, '',
    `${moves.length} braindump${moves.length === 1 ? '' : 's'}. The catalog before this commit: tag \`${tag}\` (\`${parent.slice(0, 12)}\`).`, '',
    ...(o.note?.trim() ? [o.note.trim(), ''] : []), ...lines, ''].join('\n')
  changes.push({ path: readme, text: `${(before ?? ARCHIVE_README(date)).trimEnd()}\n\n${section}` })
  return { date, folder, tag, parent, moves, because, warnings, changes }
}

export async function archiveBraindumps(ctx: CatalogContext, o: { id?: string; all?: boolean; author: string; note?: string; dryRun?: boolean }) {
  const s = await needSetting(ctx)
  if (!!o.id === !!o.all) throw new RequestError(400, 'name one braindump to archive (<path>), or all of them (--all)')
  if (o.id) needId(o.id)
  const g = needGitea(ctx)
  const dir = checkoutDir(ctx.area)
  let plan: ArchivePlan | undefined
  const result = (p: ArchivePlan, done: { commit: string } | null, problems: string[] = []) => {
    const lines = [
      ...p.moves.map(m => `move    ${m.from}/ → ${m.to}/  (${BRAINDUMP_FILE}${m.review ? `, ${REVIEW_FILE}` : ''}${m.metadata ? `, ${METADATA_FILE}` : ''})`),
      ...p.because.map(b => `because ${b.file}: ${b.entry}: [${b.before.map(x => braindumpIdOf(x)).join(', ')}] → [${b.after.map(x => braindumpIdOf(x)).join(', ')}]`),
      `write   ${p.folder}/README.md`,
      `tag     ${p.tag} → ${p.parent.slice(0, 12)} (the catalog before)`,
      ...[...p.warnings, ...problems].map(w => `warning ${w}`),
    ]
    const counts = `${p.moves.length} braindump${p.moves.length === 1 ? '' : 's'}, ${p.moves.filter(m => m.review).length} review${p.moves.filter(m => m.review).length === 1 ? '' : 's'}, ${p.because.length} because list${p.because.length === 1 ? '' : 's'}`
    return { ok: true, dryRun: !done, message: done ? `Archived ${counts} to ${p.folder}/ (${done.commit.slice(0, 7)}); tag ${p.tag} is the catalog before.` : `Would archive ${counts} to ${p.folder}/ in one commit:`,
      date: p.date, folder: p.folder, tag: p.tag, parent: p.parent, commit: done?.commit ?? null, moves: p.moves, because: p.because, warnings: [...p.warnings, ...problems], lines }
  }
  if (o.dryRun) {
    const p = await withLock(settingFile(ctx.area), async () => { await sync(ctx, s, 0); return planArchive(ctx, s, dir, o) }, { what: 'the catalog' })
    return result(p, null)
  }
  const r = await commitChanges(ctx, s, async d => { plan = await planArchive(ctx, s, d, o); return plan.changes }, o.author,
    () => [`Archive ${o.all ? `every braindump (${plan!.moves.length})` : `braindump ${o.id}`} to ${plan!.folder}/`, '',
      `Moved with ${o.all ? 'their reviews' : 'its review'}; taken out of ${plan!.because.length} because list${plan!.because.length === 1 ? '' : 's'}. The catalog before: tag ${plan!.tag}.`,
      ...(o.note?.trim() ? ['', o.note.trim()] : [])].join('\n'))
  const p = plan!
  for (const mv of p.moves) await noteFollowUp(ctx.area, { drop: mv.id, index: true, by: o.author.trim() })
  // The tag on the commit before: on Gitea, and on the mirrors (the commit itself went there with the push).
  const problems: string[] = []
  await withLock(settingFile(ctx.area), async () => {
    const url = g.cloneUrl(s.repository.owner, s.repository.name)
    const t = await git(dir, ['push', '-q', '--', url, `${p.parent}:refs/tags/${p.tag}`], { env: await wrap(() => g.gitEnv()), timeoutMs: 60_000 })
    if (t.code !== 0) problems.push(`the tag ${p.tag} was not set on Gitea: ${t.stderr.trim()} (the commit before is ${p.parent})`)
    try {
      const { config, inCatalog } = challengesHere(ctx, s)
      if (config && inCatalog) for (const m of config.mirrors) {
        const x = await git(dir, ['push', '-q', '--', m, `${p.parent}:refs/tags/${p.tag}`], { env: { GIT_TERMINAL_PROMPT: '0', ...(config.sshCommand ? { GIT_SSH_COMMAND: config.sshCommand } : {}) }, timeoutMs: 60_000 })
        if (x.code !== 0) problems.push(`the tag ${p.tag} was not set on the mirror ${m}: ${x.stderr.trim()}`)
      }
    } catch (e) { problems.push(`mirrors: ${(e as Error).message}`) }
  }, { what: 'the catalog' })
  return result(p, { commit: r.commit }, problems)
}
const braindumpIdOf = (path: string) => path.startsWith(`${EPISODES_DIR}/`) && path.endsWith(`/${BRAINDUMP_FILE}`) ? path.slice(EPISODES_DIR.length + 1, -BRAINDUMP_FILE.length - 1) : path

// A preference (user_catalog p3): how the owner wants work done, in
// preferences/<name>.md. Free Markdown, one file per subject; the Git author
// is the writer. Who may write is said in the guides, as for braindumps: an
// agent writes only what the owner said or confirmed.
const needPreferenceName = (name: string) => {
  if (!isPreferenceName(name)) throw new RequestError(400, `"${name}" is not a preference name: lower-case letters, digits, "-", "_" and "." (${SEGMENT_PATTERN.source}), without .md`)
}
export async function preferences(ctx: CatalogContext, o: { maxAgeMs?: number } = {}) {
  const snap = await catalogSnapshot(ctx, o)
  return { head: snap.head, repository: `${snap.setting.repository.owner}/${snap.setting.repository.name}`, preferences: snap.preferences }
}
export async function preference(ctx: CatalogContext, name: string) {
  needPreferenceName(name)
  const snap = await catalogSnapshot(ctx)
  const p = snap.preferences.find(x => x.name === name)
  if (!p) throw new RequestError(404, `no preference "${name}" in the catalog (${preferencePath(name)})`)
  return { ...p, head: snap.head, web: `${snap.web}/src/branch/${snap.setting.branch}/${p.path}`, history: await historyOf(checkoutDir(ctx.area), p.path) }
}
export async function changePreference(ctx: CatalogContext, o: { op: 'put' | 'remove'; name: string; text?: string; author: string; base?: string; message?: string }) {
  const s = await needSetting(ctx)
  needPreferenceName(o.name)
  const path = preferencePath(o.name)
  if (o.op === 'put' && (typeof o.text !== 'string' || !o.text.trim())) throw new RequestError(400, 'a preference needs its text')
  const text = o.op === 'remove' ? null : o.text!.endsWith('\n') ? o.text! : `${o.text}\n`
  const r = await commitChanges(ctx, s, [{ path, text }], o.author, o.message?.trim() || `${o.op === 'put' ? 'Write' : 'Remove'} preference ${o.name}`, async dir => {
    if (o.op === 'remove' && !await exists(join(dir, path))) throw new RequestError(404, `no preference "${o.name}"`)
    await refuseIfChangedSince(dir, path, o.base, `preference "${o.name}"`)
  })
  return { ok: true, message: r.changed ? `${o.op === 'put' ? 'Wrote' : 'Removed'} preference ${o.name} (${r.commit.slice(0, 7)}).` : `Preference ${o.name} is unchanged.`, commit: r.commit, changed: r.changed, path }
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
export async function upkeepRequest(ctx: CatalogContext, o: { kind: 'review' | 'index'; id?: string; followUp?: string }) {
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  if (o.kind === 'review' && o.id) { needId(o.id); if (!snap.braindumps.some(b => b.id === o.id)) throw new RequestError(404, `no braindump "${o.id}" to review`) }
  const reg = await loadRegistry(ctx.registryFile)
  const ws = reg.workspaces.find(w => w.id === UPKEEP.project || w.project === UPKEEP.project)
  if (!ws) throw new RequestError(409, `no ${UPKEEP.project} here to ${o.kind === 'review' ? 'write reviews' : 'write the index'}: run agdevctl bootstrap-projects first (it brings the summoner by the core's reference)`)
  const repo = `${snap.setting.repository.owner}/${snap.setting.repository.name}`
  const due = snap.braindumps.filter(b => !b.review || b.changedAfterReview).map(b => b.id)
  const by = o.followUp ? `(Asked by the catalog's follow-up after ${o.followUp} put in or changed a braindump.)` : ''
  const text = (o.kind === 'index'
    ? `# Rewrite the catalog's index\n\nRewrite ${INDEX_PATH} of the catalog ${repo} (head ${snap.head}): everything that is not yet real, braindumps and challenges, each with its kind, a link and one or two lines on what is missing.\n\n(Requested with wfe catalog index request.)\n`
    : o.id
      ? `# Review braindump ${o.id}\n\nWrite or refresh the review of the braindump \`${o.id}\` (${braindumpPath(o.id)}) of the catalog ${repo} (head ${snap.head}).\n\n(Requested with wfe catalog review request ${o.id}.)\n`
      : `# Review the braindumps that need it\n\nWrite or refresh the review of every braindump of the catalog ${repo} (head ${snap.head}) that has no review or changed after its review.${due.length ? ` At this head: ${due.join(', ')}.` : ' At this head there is none.'}\n\n(Requested with wfe catalog review request.)\n`).replace(/\(Requested with [^)]*\)/, m => by || m)
  return { ok: true, kind: o.kind, ...(o.id ? { id: o.id } : {}), head: snap.head, workspace: ws.id, workflow: UPKEEP[o.kind], text, receipt: `catalog-${o.kind}-${(o.id ?? 'all').replace(/[^A-Za-z0-9._-]+/g, '.')}-${snap.head.slice(0, 12)}` }
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
  // user_catalog p7: what the adopted rules say about this selection.
  const check = await (await import('./catalogRules.ts')).publicationCheck(ctx)
  return { contract: p.contract, destination: p.destination, head: snap.head, braindumps, reviews, check,
    challenges: [...byChallenge.entries()].map(([id, files]) => ({ id, files })), rest: entries.filter(e => !grouped.has(e.from)),
    internal: { braindumps: snap.braindumps.filter(b => !b.published).map(b => b.id) },
    workspace: ws, last, note: journalNote }
}
// Records where drafts are kept (server/catalogDrafts.ts useDraftRoot checks the place first).
export async function setDraftsSetting(ctx: CatalogContext, drafts: string | null) {
  const s = await needSetting(ctx)
  const { drafts: _old, ...rest } = s
  const next: CatalogSetting = drafts ? { ...rest, drafts } : rest
  await atomicWrite(settingFile(ctx.area), `${JSON.stringify(next, null, 2)}\n`)
  return next
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
- \`braindumps/archive/<date>/<path>/\`: braindumps you archived (\`wfe catalog braindump archive\`), with their reviews. Kept to be read; agdev does not read them as braindumps.
- \`challenges/<id>/\`: a problem found during work, with its trials and evidence. Written through agdev (\`wfe challenge\`), by people and agents.
- \`challenges.md\`: the index of what is not yet real: braindumps that were not carried out and challenges that are not resolved, one or two lines each. An agent writes it (\`wfe catalog index request\`).
- \`preferences/<name>.md\`: free text: how ${owner} wants work done (the language of documents, how results are handed over, …), one file per subject. agdev gives every file here to every run. Not what is wanted (a braindump) and not facts about machines.
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

// What the catalog's other modules (links, rules, asking: user_catalog p7) write and read through.
export const internals = { commitChanges, sync, checkoutDir, settingFile, needSetting, needId, lastChange, showAt, braindumpIds, readPublished, localDate, isAfter }
