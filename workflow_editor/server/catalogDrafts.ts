// Drafts of braindumps (user_catalog p6 ex1, docs/mycatalog.md *Drafts*).
//
// A draft is the owner's text before it is a braindump: kept outside Git, in
// one folder `catalog.json` `drafts` names (a share reference or an absolute
// folder; without it <area>/.local/catalog-drafts/). It is no ground, no
// citation, no entry of the index and no input of a publication. It needs no
// path until it is registered, and registering it is one ordinary catalog
// commit of its text and tags (server/catalog.ts registerBraindump).
//
//   <root>/.agdev-catalog-drafts.json        the marker: which catalog the folder serves
//   <root>/<id>/draft.json                   ag.catalog-draft.v1: text, tags, revision, receipt
//   <root>/<id>/snapshots/<revision>.json    frozen when advice is asked; never rewritten
//   <root>/<id>/advice/<advice>.json         ag.catalog-draft-advice.v1
//
// A configured root that is not there (an unmounted share, a missing folder, no
// marker) answers 503 and nothing is written anywhere else. Only the default
// root is created on demand. Every write is a temporary file renamed into place,
// under a lock per draft; a save names the revision it was made on.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { braindumpExcerpt, braindumpTitle, isBraindumpId, normalizeTags } from '../shared/catalog.ts'
import { archivedAt, catalogSnapshot, changeBraindump, findRegistration, freePath, loadCatalogSetting, REGISTRATION_TRAILER, registerBraindump, setDraftsSetting, type CatalogContext } from './catalog.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { withLock } from './lock.ts'
import { loadShareConfig, resolveRef, shareRoot } from './shares.ts'
import { RequestError } from './workspace.ts'

export const DRAFT_SCHEMA = 'ag.catalog-draft.v1'
// user_catalog p7: an ask is ex1's advice record, widened (kind, actions, dismissed); the old schema name is read as one.
export const ADVICE_SCHEMA = 'ag.catalog-ask.v1'
const OLD_ADVICE_SCHEMA = 'ag.catalog-draft-advice.v1'
export const DRAFTS_MARKER = '.agdev-catalog-drafts.json'
const DRAFT_ID = /^d-[0-9]{8}-[0-9a-f]{8}$/
const ADVICE_ID = /^a-[0-9]{8}-[0-9a-f]{8}$/
const MAX_TEXT = 512 * 1024

export interface Registration {
  operation: string; path: string; revision: number; sha256: string; tags: string[]; at: string; by: string
  state: 'pending' | 'registered' | 'failed'; commit?: string; confirmedAt?: string; problem?: string
}
export interface Draft {
  schema: typeof DRAFT_SCHEMA; id: string; catalog: string
  created: { at: string; by: string }; saved: { at: string; by: string }
  revision: number; sha256: string; text: string; tags: string[]; path?: string
  // user_catalog p6 ex2: a change of a registered braindump, written in the same
  // field: the braindump (`of`) and the commit of its text that was read (`ofBase`).
  of?: string; ofBase?: string
  state: 'draft' | 'registered'; registration?: Registration
}
export interface TagSuggestion { op: 'add' | 'remove'; tag: string; reason: string }
// What the summoner proposes under its answer (server/catalogAsk.ts): nothing is done before the owner's click.
export type AskActionState = 'proposed' | 'done' | 'declined' | 'failed'
export interface AskAction {
  do: string; why?: string; braindump?: string; to?: string; changes?: TagSuggestion[]
  tag?: string; project?: string; licence?: string; follows?: string; source?: { braindump: string; commit: string; sentence: string }; rule?: string
  publishTarget?: string // publish (p8): the project, or mycatalog for the catalog
  target?: { workspace: string; workflow: string } // hand-over: who receives the text
  state: AskActionState
  result?: { at: string; by: string; message: string; commit?: string; href?: string }
}
export type AskKind = 'braindump' | 'instruction' | 'question'
export interface Advice {
  schema: string; id: string; draft: string
  kind?: AskKind // what the summoner says the text is; the service never decides it
  actions?: AskAction[]
  dismissed?: { at: string; by: string }
  revision: number; sha256: string // the snapshot it reads
  requested: { at: string; by: string }
  ask?: string // what the owner wants advice on, in their words; kept here, never in the request
  run?: { workspace: string; workflow: string; run: string; href: string }
  state: 'requested' | 'written' | 'failed'
  written?: { at: string; by: string; head?: string; read?: string }
  text?: string; tags?: TagSuggestion[]; rewrite?: string; problem?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')
const exists = (p: string) => stat(p).then(() => true, () => false)
const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, '')
const newId = (prefix: string) => `${prefix}-${day()}-${randomBytes(4).toString('hex')}`
const now = () => new Date().toISOString()
const needDraftId = (id: string) => { if (!DRAFT_ID.test(id)) throw new RequestError(400, `"${id}" is not a draft id (d-<date>-<hex>)`) }
const needAdviceId = (id: string) => { if (!ADVICE_ID.test(id)) throw new RequestError(400, `"${id}" is not an advice id (a-<date>-<hex>)`) }
const needAskId = needAdviceId
const unavailable = (detail: string) => new RequestError(503, `drafts are unavailable: ${detail}. Nothing was written; your text stays where you typed it`, { code: 'drafts-unavailable' })

// ---- the root ----------------------------------------------------------------------

export interface DraftRoot { dir: string; where: string; catalog: string; configured: boolean }
async function place(ctx: CatalogContext, where: string): Promise<string> {
  if (where.startsWith('shared://')) {
    const cfg = loadShareConfig(ctx.area)
    const r = await resolveRef(where.endsWith('/') ? where : `${where}/`, cfg)
    if (r.state !== 'ok') throw unavailable(`${where}: ${r.detail || r.state}`)
    return r.abs!
  }
  if (!isAbsolute(where)) throw new RequestError(500, `catalog.json drafts "${where}" is neither shared://<share>/<folder>/ nor an absolute folder`)
  const st = await stat(where).catch(() => null)
  if (!st?.isDirectory()) throw unavailable(`${where} does not exist`)
  return where
}
export async function draftRoot(ctx: CatalogContext): Promise<DraftRoot> {
  const s = await loadCatalogSetting(ctx.area)
  if (!s) throw new RequestError(404, 'this installation has no catalog yet; drafts belong to a catalog (wfe catalog init)')
  const catalog = `${s.repository.owner}/${s.repository.name}`
  if (!s.drafts) {
    const dir = join(ctx.area, '.local', 'catalog-drafts')
    await mkdir(dir, { recursive: true })
    if (!await exists(join(dir, DRAFTS_MARKER))) await atomicWrite(join(dir, DRAFTS_MARKER), `${JSON.stringify({ schema: 'ag.catalog-drafts.v1', catalog }, null, 1)}\n`)
    return { dir, where: dir, catalog, configured: false }
  }
  const dir = await place(ctx, s.drafts)
  const m = await readTextOrNull(join(dir, DRAFTS_MARKER)).catch(() => null)
  if (m === null) throw unavailable(`${s.drafts} has no ${DRAFTS_MARKER} (not prepared, or the wrong folder is mounted there; prepare it with wfe catalog draft use ${s.drafts})`)
  let named: unknown
  try { named = (JSON.parse(m) as { catalog?: unknown }).catalog } catch { named = undefined }
  if (named !== catalog) throw unavailable(`${s.drafts} keeps the drafts of ${String(named)}, not of ${catalog}`)
  return { dir, where: s.drafts, catalog, configured: true }
}
// Prepares a folder for drafts and records it in catalog.json. A share must be
// mounted here; the folder below it is created with its marker. null: back to the default.
export async function useDraftRoot(ctx: CatalogContext, where: string | null) {
  const s = await loadCatalogSetting(ctx.area)
  if (!s) throw new RequestError(404, 'this installation has no catalog yet (wfe catalog init)')
  const catalog = `${s.repository.owner}/${s.repository.name}`
  if (where === null) { await setDraftsSetting(ctx, null); return { ok: true, message: `Drafts are kept in ${join(ctx.area, '.local', 'catalog-drafts')} (the default). Drafts of the former place stay there.`, root: await draftRoot(ctx) } }
  let dir: string
  if (where.startsWith('shared://')) {
    const m = /^shared:\/\/([^/]+)\/(.+?)\/?$/.exec(where)
    if (!m) throw new RequestError(400, `"${where}" is not shared://<share>/<folder>/`)
    const root = await shareRoot(m[1], loadShareConfig(ctx.area))
    if (root.state !== 'ok') throw unavailable(root.detail)
    dir = join(root.root!, ...m[2].split('/').filter(x => x && x !== '..'))
    where = `shared://${m[1]}/${m[2].replace(/\/+$/, '')}/`
  } else {
    if (!isAbsolute(where)) throw new RequestError(400, 'give shared://<share>/<folder>/ or an absolute folder')
    dir = where
  }
  await mkdir(dir, { recursive: true })
  const marker = await readTextOrNull(join(dir, DRAFTS_MARKER))
  if (marker !== null) {
    let named: unknown
    try { named = (JSON.parse(marker) as { catalog?: unknown }).catalog } catch { named = undefined }
    if (named !== catalog) throw new RequestError(409, `${where} already keeps the drafts of ${String(named)}`)
  } else await atomicWrite(join(dir, DRAFTS_MARKER), `${JSON.stringify({ schema: 'ag.catalog-drafts.v1', catalog }, null, 1)}\n`)
  await setDraftsSetting(ctx, where)
  return { ok: true, message: `Drafts of ${catalog} are kept in ${where}.`, root: await draftRoot(ctx) }
}

// ---- drafts ------------------------------------------------------------------------

const draftDir = (root: DraftRoot, id: string) => join(root.dir, id)
const draftFile = (root: DraftRoot, id: string) => join(draftDir(root, id), 'draft.json')
async function readDraftFile(root: DraftRoot, id: string): Promise<Draft> {
  needDraftId(id)
  const t = await readTextOrNull(draftFile(root, id))
  if (t === null) throw new RequestError(404, `no draft ${id}`)
  const d = JSON.parse(t) as Draft
  if (d.schema !== DRAFT_SCHEMA) throw new RequestError(500, `${draftFile(root, id)} is not ${DRAFT_SCHEMA}`)
  return d
}
const writeDraftFile = (root: DraftRoot, d: Draft) => atomicWrite(draftFile(root, d.id), `${JSON.stringify(d, null, 1)}\n`)
const lockDraft = <T>(root: DraftRoot, id: string, f: () => Promise<T>) => withLock(draftFile(root, id), f, { what: `draft ${id}` })

function needText(text: unknown): string {
  if (typeof text !== 'string') throw new RequestError(400, 'a draft needs its text (it may be empty)')
  if (Buffer.byteLength(text) > MAX_TEXT) throw new RequestError(413, `a draft is at most ${MAX_TEXT / 1024} KiB`)
  return text
}
function needTags(tags: unknown): string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags)) throw new RequestError(400, 'tags is a list')
  const n = normalizeTags(tags.map(String))
  if (n.problems.length) throw new RequestError(400, `tags: ${n.problems.join('; ')}`)
  return n.tags
}
const needPath = (path: unknown): string | undefined => {
  if (path === undefined || path === null || path === '') return undefined
  const p = String(path).trim().replace(/^\/+|\/+$/g, '')
  if (!isBraindumpId(p)) throw new RequestError(400, `"${p}" is not a braindump path: folder names of lower-case letters, digits, "-", "_" and "."`)
  return p
}

export type DraftSummary = Pick<Draft, 'id' | 'revision' | 'saved' | 'created' | 'state' | 'tags' | 'path' | 'of'> & { title: string; excerpt: string; registration?: Registration; advice: { total: number; requested: number; written: number }; asked?: AskKind }
const summary = (d: Draft, advice: Advice[]): DraftSummary => ({ id: d.id, revision: d.revision, saved: d.saved, created: d.created, state: d.state, tags: d.tags, ...(d.path ? { path: d.path } : {}), ...(d.of ? { of: d.of } : {}),
  title: braindumpTitle('(untitled)', d.text), excerpt: braindumpExcerpt(d.text, 240), ...(d.registration ? { registration: d.registration } : {}),
  advice: { total: advice.length, requested: advice.filter(a => a.state === 'requested').length, written: advice.filter(a => a.state === 'written').length },
  // The newest answer's reading of the text: an instruction or a question is listed under Asked, not under Unfinished.
  ...(advice.find(a => a.state === 'written' && !a.dismissed)?.kind ? { asked: advice.find(a => a.state === 'written' && !a.dismissed)!.kind } : {}) })

export async function listDrafts(ctx: CatalogContext) {
  const root = await draftRoot(ctx)
  const out: DraftSummary[] = []
  for (const e of (await readdir(root.dir, { withFileTypes: true })).filter(e => e.isDirectory() && DRAFT_ID.test(e.name))) {
    try {
      const d = await readDraftFile(root, e.name)
      out.push(summary(d, await listAdvice(root, d.id)))
    } catch { /* a folder without a readable draft.json is not a draft */ }
  }
  out.sort((a, b) => b.saved.at.localeCompare(a.saved.at))
  return { where: root.where, configured: root.configured, drafts: out }
}

const needCommit = (c: unknown): string | undefined => {
  if (c === undefined || c === null || c === '') return undefined
  if (typeof c !== 'string' || !/^[0-9a-f]{7,40}$/.test(c)) throw new RequestError(400, 'ofBase is the commit of the braindump that was read')
  return c
}
export async function createDraft(ctx: CatalogContext, o: { text?: string; tags?: unknown; path?: unknown; of?: unknown; ofBase?: unknown; by: string }) {
  if (!o.by.trim()) throw new RequestError(400, 'a draft needs its writer (author)')
  const root = await draftRoot(ctx)
  const text = needText(o.text ?? '')
  const id = newId('d')
  const at = now()
  const d: Draft = { schema: DRAFT_SCHEMA, id, catalog: root.catalog, created: { at, by: o.by.trim() }, saved: { at, by: o.by.trim() }, revision: 1, sha256: sha256(text), text, tags: needTags(o.tags),
    ...(needPath(o.path) ? { path: needPath(o.path) } : {}), ...(needPath(o.of) ? { of: needPath(o.of), ...(needCommit(o.ofBase) ? { ofBase: needCommit(o.ofBase) } : {}) } : {}), state: 'draft' }
  await mkdir(draftDir(root, id), { recursive: true })
  await writeDraftFile(root, d)
  return { ok: true, message: `Saved draft ${id} (revision 1).`, draft: d }
}

export async function readDraft(ctx: CatalogContext, id: string, o: { revision?: number } = {}) {
  const root = await draftRoot(ctx)
  const d = await readDraftFile(root, id)
  const advice = await listAdvice(root, id)
  if (o.revision !== undefined && o.revision !== d.revision) {
    const snap = await readSnapshot(root, id, o.revision)
    return { draft: { ...d, revision: snap.revision, sha256: snap.sha256, text: snap.text, tags: snap.tags }, snapshot: true, current: d.revision, advice, where: root.where }
  }
  return { draft: d, snapshot: false, current: d.revision, advice, where: root.where }
}

// base: the revision the change was made on. Another save after it is a 409
// with the present revision: nothing is overwritten, the caller keeps its text.
export async function saveDraft(ctx: CatalogContext, id: string, o: { text?: unknown; tags?: unknown; path?: unknown; ofBase?: unknown; base: number; by: string }) {
  if (!o.by.trim()) throw new RequestError(400, 'a save needs its writer (author)')
  const root = await draftRoot(ctx)
  needDraftId(id)
  return lockDraft(root, id, async () => {
    const d = await readDraftFile(root, id)
    if (d.state === 'registered') throw new RequestError(409, `draft ${id} was registered as ${d.registration?.path} (${d.registration?.commit?.slice(0, 7)}); change the braindump in the catalog instead`, { code: 'registered' })
    if (d.registration?.state === 'pending') throw new RequestError(409, `draft ${id} is being registered as ${d.registration.path}; register it again to finish, before changing it`, { code: 'registering' })
    if (!Number.isInteger(o.base) || o.base !== d.revision) throw new RequestError(409, `draft ${id} was saved since revision ${o.base} (now revision ${d.revision}, by ${d.saved.by} at ${d.saved.at}); your text was not saved and is kept where you typed it`, { code: 'stale', revision: d.revision, saved: d.saved })
    const text = o.text === undefined ? d.text : needText(o.text)
    const tags = o.tags === undefined ? d.tags : needTags(o.tags)
    const path = o.path === undefined ? d.path : needPath(o.path)
    const ofBase = o.ofBase === undefined || !d.of ? d.ofBase : needCommit(o.ofBase)
    if (text === d.text && JSON.stringify(tags) === JSON.stringify(d.tags) && path === d.path && ofBase === d.ofBase) return { ok: true, message: `Draft ${id} is unchanged (revision ${d.revision}).`, draft: d, changed: false }
    const { path: _p, ...rest } = d
    const next: Draft = { ...rest, ...(path ? { path } : {}), ...(ofBase ? { ofBase } : {}), text, tags, sha256: sha256(text), revision: d.revision + 1, saved: { at: now(), by: o.by.trim() }, ...(d.registration?.state === 'failed' ? { registration: d.registration } : {}) }
    await writeDraftFile(root, next)
    return { ok: true, message: `Saved draft ${id} (revision ${next.revision}).`, draft: next, changed: true }
  })
}

// Explicit cleanup by the owner: the draft with its snapshots and advice.
export async function removeDraft(ctx: CatalogContext, id: string, o: { by: string }) {
  if (!o.by.trim()) throw new RequestError(400, 'removing a draft needs your name')
  const root = await draftRoot(ctx)
  const d = await readDraftFile(root, id)
  if (d.registration?.state === 'pending') throw new RequestError(409, `draft ${id} is being registered as ${d.registration.path}; register it again to finish first`, { code: 'registering' })
  await rm(draftDir(root, id), { recursive: true, force: true })
  return { ok: true, message: `Removed draft ${id}${d.state === 'registered' ? ` (it is braindump ${d.registration?.path} in the catalog)` : ''}.` }
}

// ---- snapshots and advice ----------------------------------------------------------

interface Snapshot { revision: number; sha256: string; text: string; tags: string[]; at: string }
async function readSnapshot(root: DraftRoot, id: string, revision: number): Promise<Snapshot> {
  const t = await readTextOrNull(join(draftDir(root, id), 'snapshots', `${revision}.json`))
  if (t === null) throw new RequestError(404, `draft ${id} has no snapshot of revision ${revision} (a snapshot is made when advice is asked)`)
  return JSON.parse(t) as Snapshot
}
async function freeze(root: DraftRoot, d: Draft): Promise<Snapshot> {
  const file = join(draftDir(root, d.id), 'snapshots', `${d.revision}.json`)
  const t = await readTextOrNull(file)
  if (t !== null) return JSON.parse(t) as Snapshot
  const s: Snapshot = { revision: d.revision, sha256: d.sha256, text: d.text, tags: d.tags, at: now() }
  await mkdir(join(draftDir(root, d.id), 'snapshots'), { recursive: true })
  await atomicWrite(file, `${JSON.stringify(s, null, 1)}\n`)
  return s
}
const adviceFile = (root: DraftRoot, id: string, aid: string) => join(draftDir(root, id), 'advice', `${aid}.json`)
async function listAdvice(root: DraftRoot, id: string): Promise<Advice[]> {
  const dir = join(draftDir(root, id), 'advice')
  const out: Advice[] = []
  for (const f of (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.json'))) {
    try { out.push(JSON.parse((await readTextOrNull(join(dir, f))) ?? 'null') as Advice) } catch { /* not advice */ }
  }
  return out.filter(a => a?.schema === ADVICE_SCHEMA || a?.schema === OLD_ADVICE_SCHEMA).sort((a, b) => b.requested.at.localeCompare(a.requested.at))
}
async function readAdvice(root: DraftRoot, id: string, aid: string): Promise<Advice> {
  needAdviceId(aid)
  const t = await readTextOrNull(adviceFile(root, id, aid))
  if (t === null) throw new RequestError(404, `draft ${id} has no advice ${aid}`)
  return JSON.parse(t) as Advice
}
const writeAdvice = (root: DraftRoot, a: Advice) => atomicWrite(adviceFile(root, a.draft, a.id), `${JSON.stringify(a, null, 1)}\n`)

// Asking for advice freezes the revision the owner sees (base) and opens an
// advice record for it; the caller queues the summoner's workflow `ask`
// with the request text returned. The text names the draft, never its words.
export const ADVISE = { project: 'summoner', workflow: 'ask' } as const
export async function adviceRequest(ctx: CatalogContext, id: string, o: { base: number; by: string; ask?: string }) {
  if (!o.by.trim()) throw new RequestError(400, 'asking for advice needs your name')
  const ask = typeof o.ask === 'string' ? o.ask.trim() : ''
  if (ask.length > 4000) throw new RequestError(400, 'the question is at most 4000 characters')
  const root = await draftRoot(ctx)
  const { loadRegistry } = await import('./registry.ts')
  const reg = await loadRegistry(ctx.registryFile)
  const ws = reg.workspaces.find(w => w.id === ADVISE.project || w.project === ADVISE.project)
  if (!ws) throw new RequestError(409, `no ${ADVISE.project} here to answer: run agdevctl bootstrap-projects first. Nothing was asked; your text is kept`)
  const { loadWorkers } = await import('./workers.ts')
  const node = loadWorkers(ctx.area).local
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  return lockDraft(root, id, async () => {
    const d = await readDraftFile(root, id)
    if (d.state === 'registered') throw new RequestError(409, `this text is in the catalog already (${d.registration?.path}); write what you ask in an empty field`, { code: 'registered' })
    if (o.base !== d.revision) throw new RequestError(409, `draft ${id} was saved since revision ${o.base} (now ${d.revision}); advice is asked on the text you see, so save first`, { code: 'stale', revision: d.revision })
    if (!d.text.trim()) throw new RequestError(400, 'the draft is empty: write something first')
    // The same advice still being written (same revision, same question) is that advice, not a second run.
    const open = (await listAdvice(root, id)).find(x => x.state === 'requested' && x.revision === d.revision && (x.ask ?? '') === ask)
    if (open) return { existing: true as const, advice: open, workspace: ws.id, workflow: ADVISE.workflow, node, text: '', receipt: `draft-advice-${open.id}` }
    const s = await freeze(root, d)
    const a: Advice = { schema: ADVICE_SCHEMA, id: newId('a'), draft: id, revision: s.revision, sha256: s.sha256, requested: { at: now(), by: o.by.trim() }, ...(ask ? { ask } : {}), state: 'requested' }
    await mkdir(join(draftDir(root, id), 'advice'), { recursive: true })
    await writeAdvice(root, a)
    const text = [`# Answer a text the owner asked`, '',
      `Draft \`${id}\`, revision ${s.revision} (sha256 ${s.sha256}); ask \`${a.id}\`; catalog ${snap.setting.repository.owner}/${snap.setting.repository.name} at ${snap.head}.`, '',
      `The owner wrote this text in the Catalog page's field and pressed Ask: it is an unfinished braindump, an instruction or a question, and it is for you to read and answer. Read it with \`wfe catalog draft show ${id} --revision ${s.revision}\` and \`wfe catalog ask show ${id} ${a.id}\`. Put your answer with \`wfe catalog ask answer ${id} ${a.id} …\` (agent/ask.md).`, '',
      'The text is not in this request on purpose: it is kept outside Git. Do not copy, quote or rewrite it into any file of the working copy, an attachment, a node outcome or a commit.', '',
      '(Requested from the Catalog page.)', ''].join('\n')
    return { existing: false as const, advice: a, workspace: ws.id, workflow: ADVISE.workflow, node, text, receipt: `draft-advice-${a.id}` }
  })
}
export async function recordAdviceRun(ctx: CatalogContext, id: string, aid: string, run: Advice['run']) {
  const root = await draftRoot(ctx)
  return lockDraft(root, id, async () => { const a = await readAdvice(root, id, aid); const next = { ...a, run }; await writeAdvice(root, next); return next })
}
export async function failAdvice(ctx: CatalogContext, id: string, aid: string, o: { reason: string; by: string }) {
  const root = await draftRoot(ctx)
  return lockDraft(root, id, async () => {
    const a = await readAdvice(root, id, aid)
    const next: Advice = { ...a, state: 'failed', problem: o.reason.slice(0, 2000), written: { at: now(), by: o.by.trim() } }
    await writeAdvice(root, next)
    return { ok: true, message: `Advice ${aid} on draft ${id} is marked failed.`, advice: next }
  })
}
// The agent's advice, kept beside the draft. It names the revision it read; the
// draft is not changed by it.
export async function putAdvice(ctx: CatalogContext, id: string, aid: string, o: { text: string; tags?: unknown; rewrite?: string; by: string; head?: string; read?: string; revision?: number; kind?: AskKind; actions?: AskAction[] }) {
  if (!o.by.trim()) throw new RequestError(400, 'advice needs its writer (--author)')
  if (typeof o.text !== 'string' || !o.text.trim()) throw new RequestError(400, 'advice needs its text')
  if (Buffer.byteLength(o.text) + Buffer.byteLength(o.rewrite ?? '') > 2 * MAX_TEXT) throw new RequestError(413, 'the advice is too long')
  const root = await draftRoot(ctx)
  const tags: TagSuggestion[] = []
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags)) throw new RequestError(400, 'tags: a list of {"op": "add"|"remove", "tag", "reason"}')
    for (const [i, t] of (o.tags as unknown[]).entries()) {
      if (!isObj(t) || (t.op !== 'add' && t.op !== 'remove')) throw new RequestError(400, `tag suggestion ${i + 1}: op is "add" or "remove"`)
      const n = normalizeTags([String(t.tag ?? '')])
      if (!n.tags.length) throw new RequestError(400, `tag suggestion ${i + 1}: ${n.problems.join('; ') || 'no tag'}`)
      tags.push({ op: t.op, tag: n.tags[0], reason: String(t.reason ?? '').trim().slice(0, 2000) })
    }
  }
  return lockDraft(root, id, async () => {
    const a = await readAdvice(root, id, aid)
    if (o.revision !== undefined && o.revision !== a.revision) throw new RequestError(409, `advice ${aid} is for revision ${a.revision}, not ${o.revision}`)
    const next: Advice = { ...a, state: 'written', text: o.text, ...(o.kind ? { kind: o.kind } : {}), ...(tags.length ? { tags } : {}), ...(o.rewrite?.trim() ? { rewrite: o.rewrite } : {}), ...(o.actions?.length ? { actions: o.actions } : {}),
      written: { at: now(), by: o.by.trim(), ...(o.head ? { head: o.head } : {}), ...(o.read?.trim() ? { read: o.read.trim().slice(0, 4000) } : {}) } }
    delete next.problem
    await writeAdvice(root, next)
    return { ok: true, message: `The answer ${aid} on draft ${id} (revision ${a.revision}) is kept beside it, outside Git: ${o.text.length} characters${o.kind ? `, kind ${o.kind}` : ''}${o.actions?.length ? `, ${o.actions.length} proposed action${o.actions.length === 1 ? '' : 's'} (${o.actions.map(x => x.do).join(', ')})` : ''}${next.rewrite ? ', a proposed rewrite' : ''}. Nothing is carried out until the owner presses Do it.`, advice: { ...next, text: undefined, rewrite: undefined } }
  })
}

// user_catalog p7: an ask changed under the draft's lock (an action's state, a dismissal).
export async function updateAsk<T>(ctx: CatalogContext, id: string, aid: string, f: (a: Advice, d: Draft) => Promise<{ next: Advice; out: T }>): Promise<T> {
  const root = await draftRoot(ctx)
  needDraftId(id); needAskId(aid)
  return lockDraft(root, id, async () => {
    const r = await f(await readAdvice(root, id, aid), await readDraftFile(root, id))
    await writeAdvice(root, r.next)
    return r.out
  })
}
// Every ask that is not dismissed, on any text, newest first; each with its text's title.
export type AskedLine = Pick<Advice, 'id' | 'draft' | 'revision' | 'state' | 'kind' | 'requested' | 'run' | 'problem'> & { title: string; registered: boolean; older: boolean; actions: Pick<AskAction, 'do' | 'state'>[] }
export async function listAsked(ctx: CatalogContext): Promise<AskedLine[]> {
  const root = await draftRoot(ctx)
  const out: AskedLine[] = []
  for (const e of (await readdir(root.dir, { withFileTypes: true })).filter(e => e.isDirectory() && DRAFT_ID.test(e.name))) {
    try {
      const d = await readDraftFile(root, e.name)
      for (const a of await listAdvice(root, d.id)) if (!a.dismissed) out.push({ id: a.id, draft: d.id, revision: a.revision, state: a.state, ...(a.kind ? { kind: a.kind } : {}), requested: a.requested, ...(a.run ? { run: a.run } : {}), ...(a.problem ? { problem: a.problem } : {}),
        title: braindumpTitle('', d.text) || d.text.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 80) || '(untitled)', registered: d.state === 'registered', older: a.revision !== d.revision, actions: (a.actions ?? []).map(x => ({ do: x.do, state: x.state })) })
    } catch { /* not a draft */ }
  }
  return out.sort((a, b) => b.requested.at.localeCompare(a.requested.at))
}
// Dismissing the line under Asked. The last ask of an instruction or a question takes its text with it; an unfinished braindump stays.
export async function dismissAsk(ctx: CatalogContext, id: string, aid: string, o: { by: string }) {
  if (!o.by.trim()) throw new RequestError(400, 'dismissing needs your name')
  const root = await draftRoot(ctx)
  needDraftId(id); needAskId(aid)
  return lockDraft(root, id, async () => {
    const a = await readAdvice(root, id, aid)
    const d = await readDraftFile(root, id)
    await writeAdvice(root, { ...a, dismissed: { at: now(), by: o.by.trim() } })
    const rest = (await listAdvice(root, id)).filter(x => !x.dismissed)
    const removable = !rest.length && d.state !== 'registered' && d.registration?.state !== 'pending' && !d.of && (a.kind === 'instruction' || a.kind === 'question')
    if (removable) await rm(draftDir(root, id), { recursive: true, force: true })
    return { ok: true, message: removable ? 'Dismissed; the asked text and its answer were removed.' : 'Dismissed; the text is kept.', removed: removable }
  })
}

// ---- registration ------------------------------------------------------------------

// What registering would write, and what stands in its way. Nothing is changed.
export async function previewRegistration(ctx: CatalogContext, id: string, o: { path?: unknown }) {
  const root = await draftRoot(ctx)
  const d = await readDraftFile(root, id)
  const given = d.of ?? needPath(o.path ?? d.path)
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  const problems: string[] = [], warnings: string[] = []
  // No path given: the one the service gives (user_catalog p6 ex2), never taken or archived.
  const path = given ?? (d.text.trim() ? await freePath(ctx, d.text) : undefined)
  if (!d.text.trim()) problems.push('the draft is empty')
  if (d.of && !snap.braindumps.some(b => b.id === d.of)) problems.push(`braindump ${d.of} is no longer in the catalog`)
  if (!d.of && given && snap.braindumps.some(b => b.id === given)) problems.push(`the path ${given} is taken by a braindump of the catalog`)
  const archived = given && !d.of ? await archivedAt(ctx, given) : []
  if (archived.length) warnings.push(`${archived.join(', ')} held a braindump at this path. A new braindump here takes that old identity: what cited the old one is listed as having cited the new one. Use the path only if it is meant to be the same braindump.`)
  return { draft: d, path: path ?? null, given: !!given, revision: d.revision, sha256: d.sha256, tags: d.tags, head: snap.head, problems, warnings, archived }
}

// Registers exactly the revision the owner previewed (base). The receipt is
// written before the commit; the draft is marked registered only after the
// commit is read back from the catalog with the same text. A retry after an
// unknown result looks for the commit first (its Draft-Registration trailer).
export async function registerDraft(ctx: CatalogContext, id: string, o: { path?: unknown; base: number; by: string; reuseArchived?: boolean }) {
  if (!o.by.trim()) throw new RequestError(400, 'registering needs your name: you are the author of the braindump')
  const root = await draftRoot(ctx)
  needDraftId(id)
  return lockDraft(root, id, async () => {
    let d = await readDraftFile(root, id)
    const done = (x: Draft, how: string) => ({ ok: true, message: `${how} braindump ${x.registration!.path} (${x.registration!.commit!.slice(0, 7)}) from draft ${id}, revision ${x.registration!.revision}. The draft stays until you remove it.`, draft: x, commit: x.registration!.commit!, path: x.registration!.path })
    if (d.state === 'registered') return done(d, 'Already registered:')
    const confirm = async (r: Registration, c: { commit: string; text: string | null; id: string | null; tags: string[] }) => {
      if (c.id !== r.path || c.text === null || sha256(c.text.endsWith('\n') ? c.text : `${c.text}\n`) !== sha256(d.text.endsWith('\n') ? d.text : `${d.text}\n`)) {
        throw new RequestError(409, `the catalog's commit ${c.commit.slice(0, 7)} of this registration does not hold the draft's text at ${r.path}; nothing was marked registered`)
      }
      const next: Draft = { ...d, state: 'registered', registration: { ...r, state: 'registered', commit: c.commit, confirmedAt: now() } }
      await writeDraftFile(root, next)
      return next
    }
    // A pending receipt: an earlier attempt's result is not known. Look for its commit first.
    if (d.registration?.state === 'pending') {
      const found = await findRegistration(ctx, d.registration.operation)
      if (found) return done(await confirm(d.registration, found), 'Registered (an earlier attempt had committed it):')
    }
    if (o.base !== d.revision) throw new RequestError(409, `draft ${id} was saved since revision ${o.base} (now ${d.revision}); preview it again and register what you see`, { code: 'stale', revision: d.revision })
    if (!d.text.trim()) throw new RequestError(400, 'the draft is empty')
    const given = d.of ?? needPath(o.path ?? d.path)
    // user_catalog p6 ex2: without a path, the service gives one that is neither taken nor archived.
    const path = given ?? (d.registration?.state === 'pending' && d.registration.revision === d.revision ? d.registration.path : await freePath(ctx, d.text))
    const archived = given && !d.of ? await archivedAt(ctx, path) : []
    if (archived.length && !o.reuseArchived) throw new RequestError(409, `${archived.join(', ')} held a braindump at ${path}: a new one there takes that old identity (what cited the old one is listed as citing the new one). Confirm to use the path for the same braindump, or choose another path`, { code: 'archived-path', archived })
    const same = d.registration?.state === 'pending' && d.registration.path === path && d.registration.revision === d.revision
    const r: Registration = same ? d.registration! : { operation: `reg-${randomBytes(8).toString('hex')}`, path, revision: d.revision, sha256: d.sha256, tags: d.tags, at: now(), by: o.by.trim(), state: 'pending' }
    d = { ...d, path, registration: r }
    await writeDraftFile(root, d)
    try {
      if (d.of) {
        // A change of a registered braindump: an edit against the commit its text was read at.
        const x = await changeBraindump(ctx, { op: 'edit', id: d.of, text: d.text, author: o.by.trim(), base: d.ofBase, message: `Edit braindump ${d.of}`, trailer: `Changed from the catalog page (revision ${d.revision}).\n\n${REGISTRATION_TRAILER}: ${r.operation}` })
          .catch(e => { const err = e as RequestError; if (err instanceof RequestError && err.status === 409) throw new RequestError(409, `${err.message}. Your text is kept`, { code: 'changed' }); throw e })
        if (!x.changed) {
          const next: Draft = { ...d, state: 'registered', registration: { ...r, state: 'registered', commit: x.commit, confirmedAt: now() } }
          await writeDraftFile(root, next)
          return { ...done(next, 'Unchanged:'), unchanged: true }
        }
      } else await registerBraindump(ctx, { id: path, text: d.text, tags: d.tags, author: o.by.trim(), operation: r.operation, draft: id, revision: d.revision })
    } catch (e) {
      const err = e as RequestError
      // Refused before anything was committed (a taken path, a bad text): the receipt is closed, the draft is unchanged.
      if (err instanceof RequestError && err.status >= 400 && err.status < 500) {
        const found = await findRegistration(ctx, r.operation).catch(() => null)
        if (found) return done(await confirm(r, found), 'Registered:')
        d = { ...d, registration: { ...r, state: 'failed', problem: err.message } }
        await writeDraftFile(root, d)
        throw e
      }
      throw new RequestError(502, `the result of registering ${path} is not known (${err.message}). The draft is kept with its receipt; register again: it looks for the commit before committing anything`, { code: 'unknown' })
    }
    const found = await findRegistration(ctx, r.operation)
    if (!found) throw new RequestError(502, `the commit of registering ${path} was not found on the catalog's branch after it was made; the draft is kept with its receipt; register again to reconcile`, { code: 'unknown' })
    return done(await confirm(r, found), d.of ? 'Changed' : 'Registered')
  })
}

// user_catalog p6 ex2: the page's main button. Saves the text on the screen
// (base: the revision it was typed on), then registers that revision as one
// commit: a new braindump at the path the service gives (or the one given),
// or the change of the braindump the text was opened from. A retry after an
// unknown answer reconciles as registerDraft does.
export async function putDraft(ctx: CatalogContext, id: string, o: { text?: unknown; base: number; by: string; path?: unknown; ofBase?: unknown; reuseArchived?: boolean }) {
  const root = await draftRoot(ctx)
  const d = await readDraftFile(root, id)
  let revision = d.revision
  if (d.state !== 'registered' && d.registration?.state !== 'pending') {
    const saved = await saveDraft(ctx, id, { text: o.text, base: o.base, by: o.by, ...(o.path !== undefined ? { path: o.path } : {}), ...(o.ofBase !== undefined ? { ofBase: o.ofBase } : {}) })
    revision = saved.draft.revision
  }
  return registerDraft(ctx, id, { base: revision, by: o.by, reuseArchived: o.reuseArchived })
}
