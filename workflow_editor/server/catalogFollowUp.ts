// The catalog's follow-up (user_catalog p6 ex2, docs/mycatalog.md *The follow-up*).
//
// After a braindump is put in or changed, the service asks the summoner by
// itself: the review of that braindump, then the index once no review is open.
// The requests are the ones the buttons make (server/catalog.ts upkeepRequest,
// exec requestOnce: one open request per review or index), in the name of the
// person who made the change. Changes noted within two minutes of the first
// one are answered by one round; a change while a run is open starts the next
// round when it ends. A run that ends without its result is asked once more;
// after that the braindump says what was not done. `catalog.json`
// "followUp": false turns it off.
//
//   <area>/.local/catalog-followup.json   ag.catalog-followup.v1
//
// The writers (service or CLI on this host) note changes in that file; the
// service's loop acts on it. It holds no text, only paths, names and runs.
import { join } from 'node:path'
import { atomicWrite, readTextOrNull } from './files.ts'
import { withLock } from './lock.ts'
import type { CatalogContext } from './catalog.ts'

export const FOLLOWUP_SCHEMA = 'ag.catalog-followup.v1'
export const FOLLOWUP_DELAY_MS = 120_000
const TICK_MS = 15_000

export interface FollowUpRun { workspace: string; workflow: string; run: string; href: string }
export interface FollowUpItem {
  by: string; first: string; last: string
  state: 'waiting' | 'reading' | 'not-done'
  run?: FollowUpRun; requestedAt?: string; tries: number; reason?: string; again?: boolean
}
interface FollowUpState { schema: typeof FOLLOWUP_SCHEMA; items: Record<string, FollowUpItem>; index: FollowUpItem | null }
export type FollowUpBrief = Pick<FollowUpItem, 'state' | 'reason' | 'first' | 'by'> & { href?: string; run?: string; dueAt?: string }
export interface FollowUpView { enabled: boolean; braindumps: Record<string, FollowUpBrief>; index: FollowUpBrief | null }

const file = (area: string) => join(area, '.local', 'catalog-followup.json')
const now = () => new Date().toISOString()
const empty = (): FollowUpState => ({ schema: FOLLOWUP_SCHEMA, items: {}, index: null })

async function read(area: string): Promise<FollowUpState> {
  const t = await readTextOrNull(file(area)).catch(() => null)
  if (!t) return empty()
  try { const s = JSON.parse(t) as FollowUpState; return s?.schema === FOLLOWUP_SCHEMA ? { ...empty(), ...s } : empty() } catch { return empty() }
}
async function change<T>(area: string, f: (s: FollowUpState) => T | Promise<T>): Promise<T> {
  return withLock(file(area), async () => {
    const s = await read(area)
    const r = await f(s)
    await atomicWrite(file(area), `${JSON.stringify(s, null, 1)}\n`)
    return r
  }, { what: 'the catalog follow-up' })
}
async function enabled(area: string): Promise<boolean> {
  const { loadCatalogSetting } = await import('./catalog.ts')
  const s = await loadCatalogSetting(area).catch(() => null)
  return !!s && s.followUp !== false
}

// A change noted for one round. A new change resets an item that was not done.
const touch = (cur: FollowUpItem | null | undefined, by: string): FollowUpItem => {
  const at = now()
  if (cur && cur.state === 'reading') return { ...cur, last: at, by, again: true }
  if (cur && cur.state === 'waiting') return { ...cur, last: at, by }
  return { by, first: at, last: at, state: 'waiting', tries: 0 }
}
export async function noteFollowUp(area: string, o: { review?: string; index?: boolean; drop?: string; rename?: { from: string; to: string }; by: string }): Promise<void> {
  if (!await enabled(area)) return
  try {
    await change(area, s => {
      if (o.rename && s.items[o.rename.from]) { s.items[o.rename.to] = s.items[o.rename.from]; delete s.items[o.rename.from] }
      if (o.drop) delete s.items[o.drop]
      if (o.review) s.items[o.review] = touch(s.items[o.review], o.by)
      if (o.index || o.review) s.index = touch(s.index, o.by)
    })
  } catch (e) { console.error(`catalog follow-up: the change was not noted: ${(e as Error).message}`) }
}

const brief = (i: FollowUpItem): FollowUpBrief => ({ state: i.state, by: i.by, first: i.first, ...(i.reason ? { reason: i.reason } : {}),
  ...(i.run ? { href: i.run.href, run: `${i.run.workflow}/${i.run.run}` } : {}),
  ...(i.state === 'waiting' ? { dueAt: new Date(Date.parse(i.first) + FOLLOWUP_DELAY_MS).toISOString() } : {}) })
export async function followUpView(area: string): Promise<FollowUpView> {
  const s = await read(area)
  return { enabled: await enabled(area), braindumps: Object.fromEntries(Object.entries(s.items).map(([k, v]) => [k, brief(v)])), index: s.index ? brief(s.index) : null }
}

// ---- the loop (in the service: it needs the execution store) -------------------------

interface Exec {
  requestOnce(o: { workspace: string; workflow: string; text: string; author: string; receipt: string; via: string }): Promise<{ ref: { workflow: string; run: string }; duplicate: boolean }>
  runState(workspace: string, ref: { workflow: string; run: string }): Promise<string | undefined>
}
const ENDED = new Set(['completed', 'cancelled', 'stopped', undefined])
const href = (ws: string, wf: string, run: string) => `#/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(wf)}/${encodeURIComponent(run)}`

export class FollowUpLoop {
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private ctx: CatalogContext
  private exec: Exec
  constructor(ctx: CatalogContext, exec: Exec) { this.ctx = ctx; this.exec = exec }
  start() { if (!this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS) }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try { await this.step() } catch (e) { console.error(`catalog follow-up: ${(e as Error).message}`) } finally { this.busy = false }
  }

  private async step() {
    const area = this.ctx.area
    const first = await read(area)
    if (!Object.keys(first.items).length && !first.index) return
    if (!await enabled(area)) return
    const m = await import('./catalog.ts')
    const t = Date.now()
    const due = (i: FollowUpItem) => i.state === 'waiting' && Date.parse(i.first) + FOLLOWUP_DELAY_MS <= t
    const ask = async (kind: 'review' | 'index', i: FollowUpItem, id?: string): Promise<Partial<FollowUpItem> | 'gone'> => {
      try {
        const r = await m.upkeepRequest(this.ctx, { kind, id, followUp: i.by })
        const q = await this.exec.requestOnce({ workspace: r.workspace, workflow: r.workflow, text: r.text, author: i.by, receipt: r.receipt, via: 'catalog-follow-up' })
        return { state: 'reading', run: { workspace: r.workspace, workflow: q.ref.workflow, run: q.ref.run, href: href(r.workspace, q.ref.workflow, q.ref.run) }, requestedAt: now(), again: false }
      } catch (e) {
        const status = (e as { status?: number }).status
        if (kind === 'review' && status === 404) return 'gone'
        // Asking failed (the queue, a clone): once more at the next step, then it is said.
        if (i.tries < 1) return { state: 'waiting', tries: i.tries + 1 }
        return { state: 'not-done', reason: `not asked: ${(e as Error).message}` }
      }
    }
    // What ended, read once per step from Gitea.
    let snap: Awaited<ReturnType<typeof m.catalogSnapshot>> | null = null
    const fresh = async () => snap ??= await m.catalogSnapshot(this.ctx, { maxAgeMs: 0 })
    const ended = async (i: FollowUpItem) => !i.run || ENDED.has(await this.exec.runState(i.run.workspace, i.run).catch(() => 'in-progress'))
    const after = (i: FollowUpItem, done: boolean, what: string): FollowUpItem | null => {
      if (i.again) return { ...i, state: 'waiting', first: i.last, tries: 0, again: false, run: undefined, reason: undefined }
      if (done) return null
      if (i.tries < 1) return { ...i, state: 'waiting', first: new Date(t - FOLLOWUP_DELAY_MS).toISOString(), tries: i.tries + 1 }
      return { ...i, state: 'not-done', reason: `the run ${i.run?.workflow}/${i.run?.run} ended without ${what}; asked twice` }
    }

    // Reviews first.
    const updates = new Map<string, FollowUpItem | null>()
    for (const [id, i] of Object.entries(first.items)) {
      if (due(i)) { const r = await ask('review', i, id); updates.set(id, r === 'gone' ? null : { ...i, ...r }) }
      else if (i.state === 'reading' && await ended(i)) {
        const b = (await fresh()).braindumps.find(x => x.id === id)
        updates.set(id, b ? after(i, !!b.review && !b.changedAfterReview, 'a review') : null)
      } else if (i.state === 'not-done') {
        const b = (await m.catalogSnapshot(this.ctx)).braindumps.find(x => x.id === id)
        if (!b || (b.review && !b.changedAfterReview)) updates.set(id, null)
      }
    }
    await change(area, s => {
      for (const [id, u] of updates) {
        const cur = s.items[id]
        if (!cur) continue
        // A change noted meanwhile is kept: it starts the next round.
        if (cur.last !== first.items[id]?.last && u?.state !== 'reading') { s.items[id] = { ...cur, ...(u ?? {}), state: 'waiting', first: cur.last, last: cur.last, tries: 0, run: undefined, reason: undefined }; continue }
        if (cur.last !== first.items[id]?.last && u?.state === 'reading') { s.items[id] = { ...u, last: cur.last, again: true }; continue }
        if (u) s.items[id] = u; else delete s.items[id]
      }
    })

    // The index once no review is waiting or open.
    const s2 = await read(area)
    const i = s2.index
    if (!i) return
    const reviewsOpen = Object.values(s2.items).some(x => x.state === 'waiting' || x.state === 'reading')
    let u: FollowUpItem | null | undefined
    if (due(i) && !reviewsOpen) u = { ...i, ...(await ask('index', i) as Partial<FollowUpItem>) }
    else if (i.state === 'reading' && await ended(i)) { const x = await fresh(); u = after(i, x.index.text !== null && !x.index.stale.length, 'the index') }
    else if (i.state === 'not-done') { const x = await m.catalogSnapshot(this.ctx); if (x.index.text !== null && !x.index.stale.length) u = null }
    if (u === undefined) return
    await change(area, s => {
      const cur = s.index
      if (!cur) return
      if (cur.last !== i.last) { s.index = u && u.state === 'reading' ? { ...u, last: cur.last, again: true } : { ...cur, ...(u ?? {}), state: 'waiting', first: cur.last, last: cur.last, tries: 0, run: undefined, reason: undefined }; return }
      s.index = u
    })
  }
}
