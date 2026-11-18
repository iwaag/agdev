// What is public, why, and what the owner asked to change (improve_publish p3; agdev docs/external-publication.md,
// *Seeing and changing it from the Catalog page*).
//
// One reading: the publication tool's `facts` (the contract, the journal, the holds and the rules are interpreted
// there, nowhere else), with every ground resolved to the owner's sentence or the answer it stands on. The page
// reads it per project when its row is opened; nothing here stages, edits a contract or publishes.
//
// Two requests, never edits: *keep local from now on* records a hold with the tool (under its lock) before it is
// reported accepted, then queues the owning agent's publication-edit; *propose publication* queues the publisher,
// which prepares, assesses and asks once on the exact scope change. The publisher's question with its attached
// scope-proposal.json is answered in one batch (approve all, optional exclusions), bound to the proposal's version.
//
// The request log (<area>/.local/publication-requests.json) records what was asked and which run serves it: it is
// coordination, never policy (the contract, the journal and rules.yaml stay the only places that decide).
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadCatalogSetting, type CatalogContext } from './catalog.ts'
import { CATALOG_EDIT, CATALOG_TARGET, PUBLISHER, publicationRequest, publishTool, rules, type RuleView } from './catalogRules.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git } from './git.ts'
import { withLock } from './lock.ts'
import { loadRegistry } from './registry.ts'
import { RequestError, type Workspace } from './workspace.ts'

// ---- the tool's reading (loosely typed: the tool's JSON is its contract) -----------------------------------

export interface ToolHold { request: string; repository: string; path: string; by?: string; at: string; note?: string; state: 'held' | 'integrated' | 'released' | 'withdrawn'; integrated?: { rev: string; at: string; note?: string }; released?: { rev: string; at: string } }
export interface PublicAt { public_commit: string; source_rev: string; published_at?: string; head: boolean }
export interface Selection {
  kind: 'tree' | 'file' | 'submodule' | 'run'; key: string; group: string
  status: 'public' | 'public; source changed since' | 'selected, not published yet' | 'widening'
  because?: string; answer?: string | null; paths: string[]; count: number; edits: number; adds?: string[]
  public?: string; from?: string; exclude?: string[]; id?: string; files?: string[]; path?: string
}
export interface RepoFacts {
  id: string; name: string; path: string | null; source_rev: string; destination: string; visibility?: string; license?: string; because?: string; checkout: string
  public: { public_commit: string; source_rev: string; published_at?: string; scope_recorded: boolean } | null
  publications: number; answered_by: string; selections: Selection[]
  local: { path: string; because?: string; public: PublicAt | null }[]
  dropped: { key: string; kind: string; answer?: string; public_commit: string }[]
  staged: { operation?: string; public_commit: string; source_rev: string; staged_at?: string } | null
  conflict: { files: string[]; at: string } | null
  not_grounded: string[]; grounds_stale: string[]; holds: ToolHold[]
  rules?: { id: string; share: string; public: boolean; why: string }[]
}
export interface RunsFacts { project: string; source_rev: string; criterion: { rule?: string; proposal?: string; follows: string; braindump: string; sentence: string } | null; judged: string; selected: { id: string; files: string[]; because?: string }[]; local: string[]; unchanged_since_judged: number; runs: { id: string; kinds: Record<string, number>; development: string[]; texts: string[]; 'request.md': { bytes: number; private: string[]; forbidden: string[] } | null; 'report.md': { bytes: number; private: string[]; forbidden: string[] } | null }[]; problem?: string }
interface ToolFacts { root: string; source_rev: string; project: string | null; problems: string[]; repositories: RepoFacts[]; holds: ToolHold[]; operation: { id: string; status: string; owner?: string; scope_answer?: string | null; completed_at?: string } | null; runs?: RunsFacts }

// ---- what the page reads -------------------------------------------------------------------------------------

export interface Ground {
  value: string
  kind: 'rule' | 'answer' | 'project' | 'owner' | 'legacy' | 'missing' | 'unknown'
  words: string // one line for people
  rule?: { id: string; sentence: string; braindump: string; commit: string; adoptedBy: string; adoptedAt: string; share?: string; changed?: string }
  run?: { workspace: string; workflow: string; run: string; href: string }
  owner?: string
}
export type RequestState = 'blocked; contract update pending' | 'exclusion integrated' | 'removal from public head pending' | 'removal published' | 'kept local' | 'failed; protection retained' | 'withdrawn'
  | 'asked' | 'waiting for your answer' | 'answered' | 'done' | 'failed'
export interface PublicationRequest {
  id: string; kind: 'keep-local' | 'propose'; project: string; repository?: string; path?: string; items?: string[]
  by: string; at: string; note?: string; revision?: string
  run?: { workspace: string; workflow: string; run: string; href: string }
  queueProblem?: string
  // computed when read
  state?: RequestState; detail?: string; runState?: string
}
export interface PublicationFacts {
  project: string; workspace: { id?: string; path: string }
  readAt: string; revisionRead: string; sourceRev?: string; fetched?: boolean; fetchProblem?: string
  unavailable?: string; problems: string[]
  repositories: (Omit<RepoFacts, 'selections' | 'local'> & { ground: Ground; selections: (Selection & { ground: Ground; scopeGround?: Ground })[]; local: (RepoFacts['local'][number] & { ground: Ground })[] })[]
  operation: ToolFacts['operation']; holds: ToolHold[]
  runs?: RunsFacts & { criterionGround?: Ground }
  requests: PublicationRequest[]
  rules?: (NonNullable<RepoFacts['rules']>[number] & { rule?: RuleView })[]
}

const REQUESTS = (area: string) => join(area, '.local', 'publication-requests.json')
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const exists = (p: string) => stat(p).then(() => true, () => false)
const mtime = (p: string) => stat(p).then(s => s.mtimeMs, () => 0)
const runHref = (workspace: string, workflow: string, run: string) => `#/ws/${encodeURIComponent(workspace)}/run/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}`

// The workspace a project is published from: its registered workspace, or (mycatalog) the catalog's publication workspace.
export async function publicationWorkspace(ctx: CatalogContext, project: string): Promise<{ id?: string; path: string; project: string }> {
  if (project === CATALOG_TARGET) {
    const s = await loadCatalogSetting(ctx.area)
    if (!s?.publicationWorkspace) throw new RequestError(404, 'no publication workspace is recorded for the catalog (wfe catalog publication use <folder>)')
    return { path: s.publicationWorkspace, project }
  }
  const reg = await loadRegistry(ctx.registryFile)
  const ws = reg.workspaces.find(w => w.project === project) ?? reg.workspaces.find(w => w.id === project)
  if (!ws) throw new RequestError(404, `no workspace of project "${project}" here`)
  return { id: ws.id, path: ws.path, project: ws.project ?? project }
}

function tool(ctx: CatalogContext, args: string[], timeoutMs = 120_000): Promise<unknown> {
  return publishTool(ctx.area).then(t => new Promise((ok, fail) => execFile('python3', [t, ...args], { env: { ...process.env, WFE_AREA: ctx.area }, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (e, stdout, stderr) => {
    if (e) {
      const m = /agdev-external-publish \[([a-z-]+)\]: ([\s\S]*)/.exec(stderr)
      return fail(new RequestError(409, (m ? m[2] : stderr || e.message).trim(), m ? { code: m[1] } : undefined))
    }
    try { ok(JSON.parse(stdout)) } catch (x) { fail(new RequestError(500, `the publication tool's output cannot be read: ${(x as Error).message}`)) }
  })))
}

// The revision the page reads: the source's upstream as last fetched (the integrated main), else HEAD.
async function revisionOf(source: string): Promise<string> {
  for (const r of ['@{upstream}', 'origin/main', 'HEAD']) {
    const x = await git(source, ['rev-parse', '--verify', '--quiet', '--abbrev-ref', r])
    if (x.code === 0 && x.stdout.trim()) return r === 'HEAD' ? 'HEAD' : x.stdout.trim()
  }
  return 'HEAD'
}

// ---- grounds ---------------------------------------------------------------------------------------------------

interface GroundCtx { rules: RuleView[]; workspaces: { id: string; project?: string }[]; repoBecause?: string }
export function resolveGround(value: string | null | undefined, g: GroundCtx): Ground {
  if (!value) return { value: '', kind: 'missing', words: 'no ground recorded' }
  if (value === 'project') return { value, kind: 'project', words: `what the project is public for${g.repoBecause ? ` (${resolveGround(g.repoBecause, { ...g, repoBecause: undefined }).words})` : ''}` }
  if (value === 'answer:before-improve_publish') return { value, kind: 'legacy', words: 'decided before grounds were recorded (legacy: no sentence or answer is on record)' }
  if (value.startsWith('owner:')) return { value, kind: 'owner', owner: value.slice(6), words: `the owner's own decision: ${value.slice(6)}` }
  if (value.startsWith('rule:')) {
    const r = g.rules.find(x => x.id === value.slice(5))
    if (!r) return { value, kind: 'rule', words: `rule ${value.slice(5)}, which is not a rule of the catalog any more` }
    return { value, kind: 'rule', words: `rule ${r.id}, adopted by ${r.adopted.by} from “${r.source.braindump}”: “${r.source.sentence}”`,
      rule: { id: r.id, sentence: r.source.sentence, braindump: r.source.braindump, commit: r.source.commit, adoptedBy: r.adopted.by, adoptedAt: r.adopted.at, ...(r.share ? { share: r.share } : {}), ...(r.sourceNote ? { changed: r.sourceNote } : {}) } }
  }
  const a = /^answer:([a-z0-9][a-z0-9_.-]*)\/([a-z0-9][a-z0-9_.-]*)\/(run-[0-9]+)(#.*)?$/.exec(value)
  if (a) {
    const ws = g.workspaces.find(w => w.project === a[1]) ?? g.workspaces.find(w => w.id === a[1])
    return { value, kind: 'answer', words: `the answer in ${a[1]}/${a[2]}/${a[3]}${a[4] ?? ''}`, run: { workspace: ws?.id ?? a[1], workflow: a[2], run: a[3], href: runHref(ws?.id ?? a[1], a[2], a[3]) } }
  }
  return { value, kind: 'unknown', words: value }
}

// ---- the reading, cached ------------------------------------------------------------------------------------------

const cache = new Map<string, { key: string; facts: ToolFacts }>()
const runsCache = new Map<string, { key: string; runs: RunsFacts }>()
export function forgetFacts(project: string) { cache.delete(project); runsCache.delete(project) }

export async function publicationFacts(ctx: CatalogContext, project: string, o: { refresh?: boolean; runs?: boolean } = {}): Promise<PublicationFacts> {
  const ws = await publicationWorkspace(ctx, project)
  const source = join(ws.path, 'source')
  const state = join(ws.path, '.agdev', 'publication')
  const base: PublicationFacts = { project, workspace: { ...(ws.id ? { id: ws.id } : {}), path: ws.path }, readAt: new Date().toISOString(), revisionRead: 'HEAD', problems: [], repositories: [], operation: null, holds: [], requests: [] }
  if (!await exists(source)) return { ...base, unavailable: `${source} does not exist` }
  let fetchProblem: string | undefined
  if (o.refresh) {
    const f = await git(source, ['fetch', '-q', 'origin'], { timeoutMs: 30_000 })
    if (f.code !== 0) fetchProblem = `fetching the source failed (${f.stderr.trim().split('\n')[0]}); the last fetched revision is shown`
  }
  const revisionRead = await revisionOf(source)
  const rev = (await git(source, ['rev-parse', '--verify', '--quiet', `${revisionRead}^{commit}`])).stdout.trim()
  const ruleList = await rules(ctx).catch(() => ({ rules: [] as RuleView[], head: '' }))
  const key = [rev, await mtime(join(state, 'github.json')), await mtime(join(state, 'holds.json')), ruleList.head].join(' ')
  let facts = cache.get(project)?.key === key ? cache.get(project)!.facts : null
  try {
    if (!facts) {
      facts = await tool(ctx, ['--workspace', ws.path, 'facts', '--rev', rev || 'HEAD']) as ToolFacts
      cache.set(project, { key, facts })
    }
  } catch (e) {
    return { ...base, revisionRead, sourceRev: rev, ...(fetchProblem ? { fetchProblem } : {}), unavailable: `the publication tool could not read ${project} at ${rev.slice(0, 12)}: ${(e as Error).message}`, requests: await requestsOf(ctx, project, null) }
  }
  let runs: PublicationFacts['runs']
  if (o.runs && project !== CATALOG_TARGET) {
    const rk = `${rev} ${await mtime(join(state, 'github.json'))} ${ruleList.head}`
    let r = runsCache.get(project)?.key === rk ? runsCache.get(project)!.runs : null
    if (!r) {
      try { r = await tool(ctx, ['--workspace', ws.path, 'runs', '--rev', rev]) as RunsFacts } catch (e) { r = { problem: (e as Error).message } as RunsFacts }
      runsCache.set(project, { key: rk, runs: r })
    }
    runs = r
  }
  const reg = await loadRegistry(ctx.registryFile).catch(() => ({ workspaces: [] as { id: string; project?: string }[] }))
  const gctx = (repoBecause?: string): GroundCtx => ({ rules: ruleList.rules, workspaces: reg.workspaces, ...(repoBecause ? { repoBecause } : {}) })
  const repositories = facts.repositories.map(r => ({
    ...r, ground: resolveGround(r.because, gctx()),
    selections: r.selections.map(s => ({ ...s, ground: resolveGround(s.because, gctx(r.because)), ...(s.answer ? { scopeGround: resolveGround(s.answer, gctx()) } : {}) })),
    local: r.local.map(l => ({ ...l, ground: resolveGround(l.because, gctx()) })),
  }))
  const catalogRules = facts.repositories.find(r => r.rules)?.rules
  return {
    ...base, revisionRead, sourceRev: facts.source_rev, ...(o.refresh ? { fetched: !fetchProblem } : {}), ...(fetchProblem ? { fetchProblem } : {}),
    problems: facts.problems, repositories, operation: facts.operation, holds: facts.holds,
    ...(runs ? { runs: { ...runs, ...(runs.criterion?.rule ? { criterionGround: resolveGround(`rule:${runs.criterion.rule}`, gctx()) } : {}) } } : {}),
    requests: await requestsOf(ctx, project, facts),
    ...(catalogRules ? { rules: catalogRules.map(x => ({ ...x, rule: ruleList.rules.find(r => r.id === x.id) })) } : {}),
  }
}

// ---- the request log ----------------------------------------------------------------------------------------------

async function readRequests(area: string): Promise<PublicationRequest[]> {
  try { return (JSON.parse((await readTextOrNull(REQUESTS(area))) ?? '{}') as { requests?: PublicationRequest[] }).requests ?? [] } catch { return [] }
}
async function changeRequests<T>(area: string, f: (all: PublicationRequest[]) => Promise<T> | T): Promise<T> {
  return withLock(REQUESTS(area), async () => {
    const all = await readRequests(area)
    const out = await f(all)
    await atomicWrite(REQUESTS(area), `${JSON.stringify({ schema: 'agdev.publication-requests.v1', requests: all }, null, 2)}\n`)
    return out
  }, { what: 'the publication requests' })
}

// A request's state, from the hold (the tool's) and the run that serves it.
async function requestsOf(ctx: CatalogContext, project: string, facts: ToolFacts | null): Promise<PublicationRequest[]> {
  const mine = (await readRequests(ctx.area)).filter(r => r.project === project)
  const out: PublicationRequest[] = []
  for (const r of mine.slice(-40)) {
    const runState = r.run ? await runStateOf(ctx, r.run) : undefined
    const x: PublicationRequest = { ...r, ...(runState ? { runState } : {}) }
    if (r.kind === 'keep-local') {
      const h = facts?.holds.find(y => y.request === r.id) ?? facts?.holds.find(y => y.repository === r.repository && y.path === r.path && y.state !== 'withdrawn')
      const repo = facts?.repositories.find(y => y.id === r.repository)
      const local = repo?.local.find(l => l.path === r.path)
      const ended = runState === 'completed' || runState === 'cancelled' || runState === 'stopped'
      if (!h) { x.state = 'failed; protection retained'; x.detail = facts ? 'no hold is recorded for it' : 'the publication state cannot be read now' }
      else if (h.state === 'withdrawn') x.state = 'withdrawn'
      else if (h.state === 'released') { x.state = local?.public ? 'removal published' : 'kept local'; x.detail = `released at ${h.released?.rev.slice(0, 7)}${local?.public ? `; it remains in public history (${local.public.public_commit.slice(0, 7)})` : ''}` }
      else if (h.state === 'integrated') { x.state = local?.public?.head ? 'removal from public head pending' : 'exclusion integrated'; x.detail = local?.public?.head ? `the public head ${local.public.public_commit.slice(0, 7)} still holds it: the next publication removes it; history keeps it` : `the contract keeps it local (${h.integrated?.rev.slice(0, 7)})` }
      else if (local) { x.state = 'exclusion integrated'; x.detail = 'the contract at main keeps it local; the hold is released by the next publication' }
      else if (r.queueProblem || (ended && runState !== 'completed')) { x.state = 'failed; protection retained'; x.detail = r.queueProblem ?? `the contract change ${runState}: future publication stays blocked; ask again or withdraw` }
      else if (ended) { x.state = 'failed; protection retained'; x.detail = 'the contract change completed without the [[local]] on main: future publication stays blocked; read the run' }
      else { x.state = 'blocked; contract update pending'; x.detail = runState ? `the contract change is ${runState}` : 'the contract change is queued' }
    } else {
      x.state = r.queueProblem ? 'failed' : !runState ? 'asked' : runState === 'completed' ? 'done' : runState === 'cancelled' || runState === 'stopped' ? 'failed' : 'asked'
      if (r.queueProblem) x.detail = r.queueProblem
    }
    out.push(x)
  }
  return out
}

async function runStateOf(ctx: CatalogContext, run: NonNullable<PublicationRequest['run']>): Promise<string | undefined> {
  try {
    const reg = await loadRegistry(ctx.registryFile)
    const w = reg.workspaces.find(x => x.id === run.workspace)
    if (!w) return undefined
    const { readRun } = await import('./runs.ts')
    const { Workspace } = await import('./workspace.ts')
    const rec = (await readRun(new Workspace(w as never), { workflow: run.workflow, run: run.run })).record
    if (!rec) return undefined
    if (rec.cancelled) return 'cancelled'
    if (rec.execution.waiting.length && rec.execution.state !== 'completed') return 'waiting'
    return rec.execution.state
  } catch { return undefined }
}

type Requester = (o: { workspace: string; workflow: string; text: string; author: string; receipt: string }) => Promise<{ ref: { workflow: string; run: string }; duplicate: boolean }>

// ---- keep local from now on ------------------------------------------------------------------------------------------

export async function keepLocal(ctx: CatalogContext, o: { project: string; repository?: string; path: string; revision?: string; note?: string; author: string; request: Requester }) {
  const author = o.author.trim()
  if (!author) throw new RequestError(400, 'keeping something local needs your name: the owner asks for it')
  const path = o.path.trim().replace(/^\/+|\/+$/g, '')
  if (!path || path.startsWith('.') || path.split('/').includes('..')) throw new RequestError(400, `"${o.path}" is not a source path`)
  const ws = await publicationWorkspace(ctx, o.project)
  const owner = await owningEdit(ctx, o.project)
  const open = (await requestsOf(ctx, o.project, null)).find(r => r.kind === 'keep-local' && r.path === path && (!o.repository || r.repository === o.repository) && !r.run && r.queueProblem)
  const id = open?.id ?? `kl-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`
  // 1. The hold, under the tool's lock: from here no candidate that selects the path is staged, resolved or pushed.
  const held = await tool(ctx, ['--workspace', ws.path, 'hold', 'add', '--path', path, '--request', id, '--by', author, ...(o.repository ? ['--repo', o.repository] : []), ...(o.note ? ['--note', o.note] : [])], 90_000) as { hold: ToolHold; duplicate: boolean; selected_now: string[]; selected_count: number; staged_blocked: { operation?: string; public_commit: string; paths: string[] } | null; public: PublicAt | null }
  forgetFacts(o.project)
  const rid = held.hold.request
  const known = (await readRequests(ctx.area)).find(r => r.id === rid)
  if (known?.run && !known.queueProblem) return { ok: true, duplicate: true, request: known, held, message: `Already asked (${rid}): ${path} is held; the contract change is ${known.run.workflow}/${known.run.run}.` }
  const entry: PublicationRequest = { id: rid, kind: 'keep-local', project: o.project, repository: held.hold.repository, path, by: author, at: known?.at ?? new Date().toISOString(), ...(o.note ? { note: o.note } : {}), ...(o.revision ? { revision: o.revision } : {}) }
  // 2. The owning agent's contract change.
  const text = keepLocalText({ ...entry, selected: held.selected_now, count: held.selected_count, publicAt: held.public, staged: held.staged_blocked, owner })
  try {
    const q = await o.request({ workspace: owner.workspace, workflow: owner.workflow, text, author, receipt: `keep-local-${rid}` })
    entry.run = { workspace: owner.workspace, workflow: q.ref.workflow, run: q.ref.run, href: runHref(owner.workspace, q.ref.workflow, q.ref.run) }
  } catch (e) { entry.queueProblem = `the contract change could not be queued: ${(e as Error).message}` }
  await changeRequests(ctx.area, all => { const i = all.findIndex(r => r.id === rid); if (i >= 0) all[i] = entry; else all.push(entry) })
  const words = [
    `${path} is kept out of every future publication of ${o.project} from now on (request ${rid}).`,
    held.selected_count ? `It is still selected (${held.selected_count} file${held.selected_count === 1 ? '' : 's'}); ${entry.run ? `${owner.workspace}/${entry.run.workflow}/${entry.run.run} changes the contract` : 'the contract change could not be queued: ask again'}.` : 'Nothing selects it now; the hold is integrated.',
    held.staged_blocked ? `A candidate staged before (${held.staged_blocked.operation}) holds it: its push is refused.` : '',
    held.public ? `It is public${held.public.head ? ' in the public head' : ''} at ${held.public.public_commit.slice(0, 7)}: history keeps it; the next publication ${held.public.head ? 'removes it from the head' : 'does not bring it back'}.` : '',
  ].filter(Boolean).join(' ')
  return { ok: !entry.queueProblem, duplicate: false, request: entry, held, message: words }
}

async function owningEdit(ctx: CatalogContext, project: string): Promise<{ workspace: string; workflow: string }> {
  const reg = await loadRegistry(ctx.registryFile)
  const target = project === CATALOG_TARGET ? CATALOG_EDIT : { project, workflow: 'publication-edit' }
  const w = reg.workspaces.find(x => x.project === target.project) ?? reg.workspaces.find(x => x.id === target.project)
  if (!w) throw new RequestError(409, `no workspace of ${target.project} here to change the contract`)
  if (project !== CATALOG_TARGET) {
    const src = join(w.path, 'source')
    const rev = await revisionOf(src)
    if ((await git(src, ['cat-file', '-e', `${rev}:devdocs/workflows/${target.workflow}.yaml`])).code !== 0) throw new RequestError(409, `${project} has no ${target.workflow} workflow: its contract is changed through its freework first (the publisher's guide, A project with no publication-edit yet); nothing was held`)
  }
  return { workspace: w.id, workflow: target.workflow }
}

function keepLocalText(r: PublicationRequest & { selected: string[]; count: number; publicAt: PublicAt | null; staged: { operation?: string } | null; owner: { workspace: string; workflow: string } }): string {
  const catalog = r.project === CATALOG_TARGET
  return [`# Keep ${r.path} local from now on`, '',
    `The owner asked from the Catalog page (request \`${r.id}\`, by ${r.by}, ${r.at}${r.revision ? `; the page showed source ${r.revision.slice(0, 12)}` : ''}): keep \`${r.path}\` of repository \`${r.repository}\` out of every future publication.`, '',
    `Change the publication contract (\`publication/github.toml\`${catalog ? ' of the catalog, through `wfe catalog publication put`' : ''}), and nothing else:`, '',
    '```toml', '[[local]]', `path = "${r.path}"`, `because = "owner:${r.by.replace(/"/g, '')} (Catalog page request ${r.id})"`, '```', '',
    `- Remove every \`[[run]]\` whose folder is at or below it and every \`[[file]]\` whose \`from = "source:…"\` is at or below it (with their \`[[file.edit]]\`). A \`[[tree]]\` leaves a \`[[local]]\` path out by itself: leave trees as they are.`,
    `- If the path is not a source path of this repository, or the change would remove more than this path, do not guess: say so in your outcome and complete without the change.`,
    r.count ? `- Selected now (${r.count}): ${r.selected.slice(0, 20).map(p => `\`${p}\``).join(', ')}${r.count > 20 ? ', …' : ''}.` : '- Nothing selects it now: the entry records the decision for later selections.',
    ...(r.note ? ['', `The owner's words: ${r.note}`] : []), '',
    `The publication tool holds \`${r.path}\` (hold of request \`${r.id}\`) until a revision whose contract no longer selects it is published: until then no candidate that still selects it is staged or pushed.${r.staged ? ` A candidate staged before (${r.staged.operation}) is refused at push.` : ''}`,
    r.publicAt ? `It was published (public commit ${r.publicAt.public_commit.slice(0, 12)}): history keeps it; this change only stops further publication.` : 'It has not been published.',
    'This change publishes nothing. Integration of your change is an internal change of the project.', ''].join('\n')
}

export async function withdrawKeepLocal(ctx: CatalogContext, o: { project: string; id: string; reason: string; author: string }) {
  if (!o.author.trim() || !o.reason.trim()) throw new RequestError(400, 'withdrawing needs your name and why')
  const ws = await publicationWorkspace(ctx, o.project)
  const r = await tool(ctx, ['--workspace', ws.path, 'hold', 'withdraw', '--request', o.id, '--by', o.author.trim(), '--note', o.reason.trim()], 90_000)
  forgetFacts(o.project)
  return { ok: true, message: `Request ${o.id} is withdrawn: the hold no longer blocks publication. A [[local]] already written stays in the contract.`, result: r }
}

// ---- propose publication --------------------------------------------------------------------------------------------

export async function proposePublication(ctx: CatalogContext, o: { project: string; items: string[]; note?: string; revision?: string; author: string; request: Requester }) {
  const author = o.author.trim()
  if (!author) throw new RequestError(400, 'proposing needs your name')
  const items = [...new Set(o.items.map(x => x.trim()).filter(Boolean))].slice(0, 100)
  if (!items.length && !o.note?.trim()) throw new RequestError(400, 'say what you propose: one or more items, or words')
  const digest = hash(JSON.stringify({ items, note: o.note?.trim() ?? '' }))
  const id = `pp-${digest}`
  const known = (await readRequests(ctx.area)).find(r => r.id === id && r.project === o.project)
  if (known?.run && !known.queueProblem) {
    const st = await runStateOf(ctx, known.run)
    if (st && st !== 'completed' && st !== 'cancelled' && st !== 'stopped') return { ok: true, duplicate: true, request: known, message: `Already proposed: the publisher works on it in ${known.run.workflow}/${known.run.run}.` }
  }
  const note = [`## The owner's proposal (Catalog page request \`${id}\`)`, '',
    items.length ? `Proposed for publication: ${items.map(x => `\`${x}\``).join(', ')}.` : '', o.note?.trim() ? `In the owner's words: ${o.note.trim()}` : '',
    '', 'Proposing approves nothing. Read the owner\'s words and the items, prepare and assess the candidate as for any publication (items you would keep local stay local, with your reason in scope.md; "nothing worth publishing" is a valid result). If the candidate widens the scope, write the build\'s `scope_proposal` to `scope-proposal.json` in the run folder, attach it to `assess`, and ask once with exactly that list naming its version: the owner answers on the Catalog page (approve all, or decline items).',
    o.revision ? `(The page showed source ${o.revision.slice(0, 12)}.)` : ''].filter(Boolean).join('\n')
  const r = await publicationRequest(ctx, { target: o.project, by: author, note })
  const entry: PublicationRequest = { id, kind: 'propose', project: o.project, items, by: author, at: new Date().toISOString(), ...(o.note?.trim() ? { note: o.note.trim() } : {}), ...(o.revision ? { revision: o.revision } : {}) }
  try {
    const q = await o.request({ workspace: r.workspace, workflow: r.workflow, text: r.text, author, receipt: `propose-${o.project}-${digest}` })
    entry.run = { workspace: r.workspace, workflow: q.ref.workflow, run: q.ref.run, href: runHref(r.workspace, q.ref.workflow, q.ref.run) }
  } catch (e) { entry.queueProblem = `the publisher could not be asked: ${(e as Error).message}` }
  await changeRequests(ctx.area, all => { const i = all.findIndex(x => x.id === id); if (i >= 0) all[i] = entry; else all.push(entry) })
  if (entry.queueProblem) throw new RequestError(409, entry.queueProblem)
  return { ok: true, duplicate: false, request: entry, message: `Asked the publisher (${entry.run!.workflow}/${entry.run!.run}). It prepares and assesses the candidate, then asks you once on the exact change; nothing is approved yet.` }
}

// ---- the publisher's question, answered in one batch ----------------------------------------------------------------

export interface ScopeProposal { schema: string; version: string; repositories: { id: string; candidate_tree: string; source_rev: string }[]; items: { key: string; repository: string; selection: string; group: string; adds: string[]; because?: string }[] }
export interface PublisherQuestion {
  workspace: string; workflow: string; run: string; href: string; title?: string; target?: string
  question: { id: string; text: string; node: string | null; asked: string; to: string }
  proposal?: ScopeProposal; proposalProblem?: string
}
// The open questions of the publisher's publish runs, each with its attached scope-proposal.json when there is one.
export async function publisherQuestions(ctx: CatalogContext): Promise<PublisherQuestion[]> {
  const reg = await loadRegistry(ctx.registryFile)
  const w = reg.workspaces.find(x => x.project === PUBLISHER.project) ?? reg.workspaces.find(x => x.id === PUBLISHER.project)
  if (!w) return []
  const { listRuns, readRun, readRunFile } = await import('./runs.ts')
  const { Workspace } = await import('./workspace.ts')
  const space = new Workspace(w as never)
  const out: PublisherQuestion[] = []
  for (const s of await listRuns(space, PUBLISHER.workflow)) {
    if (!s.waiting?.length || s.execution === 'completed') continue
    const ref = { workflow: s.workflow, run: s.run }
    const rec = (await readRun(space, ref)).record
    if (!rec || rec.cancelled) continue
    for (const q of Object.values(rec.questions)) {
      if (q.answers.length || q.takenUp || q.withdrawn) continue
      const target = await readRunFile(space, ref, 'request.md').then(f => /Target: `([^`]+)`/.exec(f.text)?.[1], () => undefined)
      const x: PublisherQuestion = { workspace: w.id, workflow: s.workflow, run: s.run, href: runHref(w.id, s.workflow, s.run), ...(s.title ? { title: s.title } : {}), ...(target ? { target } : {}), question: { id: q.id, text: q.text, node: q.node, asked: q.asked, to: q.to } }
      if (rec.artifacts.some(a => a.path.endsWith('/scope-proposal.json'))) {
        try {
          const p = JSON.parse((await readRunFile(space, ref, 'scope-proposal.json')).text) as ScopeProposal
          if (!p.version || !Array.isArray(p.items)) throw new Error('no version or items')
          x.proposal = p
        } catch (e) { x.proposalProblem = `scope-proposal.json cannot be read: ${(e as Error).message}` }
      }
      out.push(x)
    }
  }
  return out
}

// The answer's text (one question.answer): words for people and a block the publisher reads. Refuses a changed proposal.
export async function scopeAnswerText(space: Workspace, o: { workflow: string; run: string; question: string; version?: string; decline: string[]; text?: string; author: string }): Promise<{ text: string; duplicate: boolean }> {
  const { readRun, readRunFile } = await import('./runs.ts')
  const ref = { workflow: o.workflow, run: o.run }
  const rec = (await readRun(space, ref)).record
  if (!rec) throw new RequestError(404, `no run ${o.workflow}/${o.run}`)
  const q = rec.questions[o.question]
  if (!q) throw new RequestError(404, `${o.workflow}/${o.run} has no question ${o.question}`)
  if (q.answers.length || q.takenUp) {
    // A retry of the same answer (the page lost the reply) is that answer, not a second one.
    const last = q.answers.at(-1)?.text ?? ''
    const block = /```agdev-scope-answer\n(.*)\n```/.exec(last)?.[1]
    try { const b = block ? JSON.parse(block) as { version?: string; decline?: string[] } : null; if (b && b.version === o.version && JSON.stringify([...(b.decline ?? [])].sort()) === JSON.stringify([...o.decline].sort())) return { text: last, duplicate: true } } catch { /* not ours */ }
    throw new RequestError(409, `${o.question} of ${o.workflow}/${o.run} is answered already: read the run`, { code: 'answered' })
  }
  if (q.withdrawn) throw new RequestError(409, `${o.question} was withdrawn by ${q.withdrawn.by}: ${q.withdrawn.reason}`, { code: 'withdrawn' })
  const run = `${space.reg.project ?? space.reg.id}/${o.workflow}/${o.run}`
  if (o.version === undefined) {
    if (!o.text?.trim()) throw new RequestError(400, 'an answer without the proposal needs your words')
    return { text: `${o.text.trim()}\n\n(Answered on the Catalog page by ${o.author}.)`, duplicate: false }
  }
  let p: ScopeProposal
  try { p = JSON.parse((await readRunFile(space, ref, 'scope-proposal.json')).text) as ScopeProposal } catch (e) { throw new RequestError(409, `the run's scope-proposal.json cannot be read (${(e as Error).message}): answer in words on the run`, { code: 'stale-proposal' }) }
  if (p.version !== o.version) throw new RequestError(409, `the proposal changed since the page read it (${o.version} → ${p.version}): read it again; nothing was answered`, { code: 'stale-proposal' })
  const keys = new Set(p.items.map(i => i.key))
  const unknown = o.decline.filter(k => !keys.has(k))
  if (unknown.length) throw new RequestError(409, `not in proposal ${p.version}: ${unknown.join(', ')}; nothing was answered`, { code: 'stale-proposal' })
  const decline = p.items.filter(i => o.decline.includes(i.key)), approve = p.items.filter(i => !o.decline.includes(i.key))
  const label = (i: ScopeProposal['items'][number]) => p.repositories.length > 1 ? i.key : i.selection
  return { duplicate: false, text: [
    decline.length ? `${approve.length ? `Yes to ${approve.map(label).join(', ')}.` : 'Nothing of it.'} Declined: ${decline.map(label).join(', ')} — make each a [[local]] (because = "answer:${run}") in the same publication-edit, and leave it out of the selection.` : `Yes: everything in proposal ${p.version}.`,
    approve.length ? `Stage with --scope-answer ${run}#${o.question} once the build's scope change is exactly the approved items${decline.length ? ' (the declined ones gone)' : ''}.` : 'Nothing widens: finish as No change, with the declined items written as [[local]].',
    ...(o.text?.trim() ? ['', o.text.trim()] : []), '',
    `(Answered on the Catalog page by ${o.author}, proposal ${p.version}.)`, '',
    '```agdev-scope-answer', JSON.stringify({ version: p.version, approve: approve.map(i => i.key), decline: decline.map(i => i.key), by: o.author }), '```', '',
  ].join('\n') }
}
