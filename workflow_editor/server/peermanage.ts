// Management of a child installation over the agdev link (improve_multinodes
// p3, docs/management.md): observation of an installation and updates of it
// through its own lifecycle. Addressed by installation (the pair's
// management id), not by delegation; it reuses the link store's outbox,
// retries and authentication (server/peerlink.ts).
//
// The managed side (B) admits an authorized `update` by writing one request
// file into its lifecycle folder, bound first in its journal (`mops`), so a
// crash anywhere repeats nothing: one operation, one lifecycle id, one
// update record. B's lifecycle service (install/agdevctl, root on Linux)
// performs the update and writes the record; B's link only reads records
// and the lifecycle's status file, and tells the parent each phase.
//
// The managing side (A) records each operation before sending it, retries
// it until B's receipt, asks B for an observation (with its unfinished
// operations) on an interval, and keeps the latest status of each.
// Nothing is concluded from silence: an operation without news is
// `unknown`, an old observation `stale`.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, accessSync, constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { hostname } from 'node:os'
import {
  CAPABILITIES, COMMIT, enrollmentOf, envelope, LIFECYCLE_TERMINAL, manageIdOf, peerOf, sha256, UPDATE_OP_ID,
  identityOk, type AdminAccess, type Enrollment, type Envelope, type InstallationBody, type InstallationSample, type PeerConfig, type PeerEntry, type PeerIdentity, type PeerRoute, type Relation, type UpdateBody, type UpdateHealth, type UpdateStatusBody,
} from '../shared/peers.ts'
import type { Delivery, InboxRow, PeerStore } from './peerlink.ts'
import { RequestError } from './workspace.ts'
import { browserUrl, editorBase, siteView } from './site.ts'

export const OBSERVE_BUSY_MS = 60_000
export const OBSERVE_IDLE_MS = 15 * 60_000
export const MANAGE_STALE_MS = 15 * 60_000
export const SAMPLE_STALE_S = 120
export const STATUS_HISTORY = 12
export const OBSERVE_OPS = 20
const MAX = 9500 // = MAX_MESSAGE of peerlink.ts (not imported: the modules import each other)
const SERVICES = ['wfe', 'executor', 'observer', 'watchdog', 'lifecycle', 'web']

export interface MopRow {
  id: string; dir: 'out' | 'in'; peer: string; kind: 'update'; n: number | null; payload: string; body: string
  state: 'queued' | 'posted' | 'admitting' | 'accepted' | 'refused'; code: string | null; reason: string | null; lifecycle: string | null
  status: string | null; told: number; message: number | null; created: string; updated: string
  route: PeerRoute // p4: the route the operation travelled: http (zulip only on rows of the retired link)
}
interface ObservationRow { peer: string; query: string | null; body: string | null; received: string | null; asks: number; asked: string | null; route: PeerRoute }
type Applied = { state: InboxRow['state']; note: string }
type OpAnswer = InstallationBody['ops'][string]

// p4: where the management token a peer issued to this installation is
// (the same rule as peerlink's credentialFile, which imports this module).
const manageCredentialFile = (area: string, p: PeerEntry) => p.manageCredential ? (isAbsolute(p.manageCredential) ? p.manageCredential : join(area, p.manageCredential)) : join(area, '.local', 'peerlink', 'credentials', `${p.instance}.manage.token`)
const isTerminal = (state: string) => (LIFECYCLE_TERMINAL as readonly string[]).includes(state)
const readJson = (file: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return null } }
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

export class Management {
  readonly store: PeerStore
  constructor(store: PeerStore) {
    this.store = store
    mkdirSync(join(store.ctx.area, '.local', 'peerlink'), { recursive: true })
  }
  private get now() { return this.store.now() }
  private ms() { return this.store.ms() }
  mop(id: string, dir: 'in' | 'out') { return this.store.one<MopRow>('SELECT * FROM mops WHERE id = ? AND dir = ?', id, dir) }
  lifecycleDir(): string | null {
    const d = this.store.ctx.lifecycle === undefined ? process.env.AGDEV_LIFECYCLE ?? null : this.store.ctx.lifecycle
    return d || null
  }

  // ---- relationship -----------------------------------------------------------------------

  // This installation's chain of operational parents as it knows it: its
  // parent, then what that parent last said of its own.
  ancestry(cfg: PeerConfig): string[] {
    const parent = cfg.peers.find(p => p.parentage === 'parent')
    if (!parent) return []
    return [parent.instance, ...(this.relationOf(parent.instance).relation?.ancestry ?? [])].slice(0, 8)
  }
  relationFor(cfg: PeerConfig, p: PeerEntry): Relation {
    return { you: p.parentage, grants: [...p.grant], manages: [...p.manage], ancestry: this.ancestry(cfg) }
  }
  heardRelation(instance: string, r: Relation) {
    const changed = this.store.run('UPDATE peers SET relation = ?, relation_seen = ? WHERE instance = ?', JSON.stringify(r), this.now, instance).changes
    if (!changed) this.store.run('INSERT INTO peers (instance, capabilities, seen, relation, relation_seen) VALUES (?, \'[]\', ?, ?, ?)', instance, this.now, JSON.stringify(r), this.now)
  }
  relationOf(instance: string): { relation: Relation | null; seen: string | null } {
    const r = this.store.one<{ relation: string | null; relation_seen: string | null }>('SELECT relation, relation_seen FROM peers WHERE instance = ?', instance)
    return { relation: r?.relation ? JSON.parse(r.relation) as Relation : null, seen: r?.relation_seen ?? null }
  }
  enrollment(cfg: PeerConfig, p: PeerEntry): { state: Enrollment; detail: string } {
    return enrollmentOf(cfg.self, p, this.relationOf(p.instance).relation, this.store.capabilitiesOf(p.instance).capabilities, this.ancestry(cfg))
  }

  // ---- what was received --------------------------------------------------------------------

  async apply(cfg: PeerConfig, peer: PeerEntry, e: Envelope, _row: Delivery): Promise<Applied> {
    switch (e.type) {
      case 'update': return this.admit(cfg, peer, e)
      case 'observe': return this.answerObserve(cfg, peer, e)
      case 'update-receipt': return this.receipt(cfg, peer, e)
      case 'update-status': {
        if (e.request !== manageIdOf(cfg.self, peer.instance)) return { state: 'ignored', note: `misaddressed: ${e.request} is not the management id of this installation over ${peer.label}` }
        return this.recordStatus(peer, e.body, 'message')
      }
      case 'installation': return this.installation(cfg, peer, e)
      default: return { state: 'ignored', note: `not a management message: ${e.type}` }
    }
  }

  // B: an update asked by a peer. The checks of docs/management.md, in order.
  private admit(cfg: PeerConfig, peer: PeerEntry, e: Extract<Envelope, { type: 'update' }>): Applied {
    const m = manageIdOf(peer.instance, cfg.self)
    if (e.request !== m) return { state: 'ignored', note: `misaddressed: ${e.request} is not ${peer.label}'s management id for this installation` }
    const prior = this.mop(e.id, 'in')
    if (prior) {
      if (prior.payload !== e.payload) return { state: 'ignored', note: `conflict: ${e.id} was received before with another payload (${prior.payload.slice(0, 19)}…); the first is kept, nothing applied` }
      if (prior.state !== 'admitting') this.queueReceipt(cfg, prior, true)
      return { state: 'done', note: `${e.id}: duplicate — ${prior.state}${prior.lifecycle ? ` as lifecycle update ${prior.lifecycle}` : ''}; receipt posted again, nothing admitted` }
    }
    const refuse = (code: string, reason: string): Applied => {
      this.store.tx(() => {
        this.store.run('INSERT INTO mops (id, dir, peer, kind, n, payload, body, state, code, reason, created, updated, route) VALUES (?, \'in\', ?, \'update\', ?, ?, ?, \'refused\', ?, ?, ?, ?, \'http\')',
          e.id, peer.instance, Number(UPDATE_OP_ID.exec(e.id)![2]), e.payload, JSON.stringify(e.body), code, reason, this.now, this.now)
        this.queueReceipt(cfg, this.mop(e.id, 'in')!)
      })
      return { state: 'done', note: `${e.id}: refused (${code}) — ${reason}` }
    }
    if (!peer.grant.includes('update') || peer.parentage !== 'parent') return refuse('not-permitted', `${peer.label} may not update this installation (${peer.parentage === 'parent' ? 'no update grant' : 'it is not this installation\'s operational parent'})`)
    const en = this.enrollment(cfg, peer)
    if (en.state === 'contradictory' || en.state === 'cycle') return refuse('relationship', en.detail)
    if (e.body.target !== cfg.self) return refuse('wrong-target', `the update names ${e.body.target}; this is ${cfg.self}`)
    if (!COMMIT.test(e.body.commit)) return refuse('invalid', `${e.body.commit} is not a full commit hash`)
    const dir = this.lifecycleDir()
    const writable = !!dir && (() => { try { accessSync(join(dir, 'requests'), constants.W_OK); return true } catch { return false } })()
    if (!writable) return refuse('lifecycle-unavailable', `this installation's lifecycle folder ${dir ? `${dir}/requests is not writable` : 'is not known to the link (AGDEV_LIFECYCLE)'}`)
    const busy = this.busy(dir!)
    if (busy) return refuse('busy', `${busy}; one update at a time — ask again when it has ended`)
    const lifecycle = `${stamp(this.ms())}-${sha256(e.id).slice(0, 6)}`
    this.store.run('INSERT INTO mops (id, dir, peer, kind, n, payload, body, state, lifecycle, created, updated, route) VALUES (?, \'in\', ?, \'update\', ?, ?, ?, \'admitting\', ?, ?, ?, \'http\')',
      e.id, peer.instance, Number(UPDATE_OP_ID.exec(e.id)![2]), e.payload, JSON.stringify(e.body), lifecycle, this.now, this.now)
    return this.settle(cfg, this.mop(e.id, 'in')!)
  }

  // B: an unfinished update here — a request the lifecycle has not taken,
  // an update record not ended, or an admission in progress.
  private busy(dir: string): string | null {
    const files = (sub: string) => { try { return readdirSync(join(dir, sub)).filter(f => f.endsWith('.json')).sort() } catch { return [] } }
    const waiting = files('requests')[0]
    if (waiting) return `lifecycle request ${waiting.slice(0, -5)} is waiting to be taken up`
    for (const f of files('updates')) {
      const r = readJson(join(dir, 'updates', f))
      if (r && typeof r.state === 'string' && !isTerminal(r.state)) return `update ${f.slice(0, -5)} is ${r.state}`
    }
    const admitting = this.store.one<MopRow>('SELECT * FROM mops WHERE dir = \'in\' AND state = \'admitting\'')
    return admitting ? `the admission of ${admitting.id} is in progress` : null
  }

  // B: the durable binding of an admitted operation to its lifecycle
  // request. Repeated after a crash, it writes the same file (unless the
  // lifecycle has it already) and accepts; a grant revoked before the file
  // existed refuses instead.
  private settle(cfg: PeerConfig, row: MopRow): Applied {
    const dir = this.lifecycleDir()
    if (!dir || !row.lifecycle) return { state: 'done', note: `${row.id}: admission waits for the lifecycle folder` }
    const req = join(dir, 'requests', `${row.lifecycle}.json`), upd = join(dir, 'updates', `${row.lifecycle}.json`)
    if (!existsSync(req) && !existsSync(upd)) {
      const peer = peerOf(cfg, row.peer)
      if (!peer || !peer.grant.includes('update') || peer.parentage !== 'parent') {
        this.store.tx(() => {
          this.store.run('UPDATE mops SET state = \'refused\', code = \'not-permitted\', reason = ?, updated = ? WHERE id = ? AND dir = \'in\'', `the update grant of ${row.peer} was revoked before the lifecycle request was written`, this.now, row.id)
          this.queueReceipt(cfg, this.mop(row.id, 'in')!)
        })
        return { state: 'done', note: `${row.id}: refused (not-permitted) — the grant was revoked before admission` }
      }
      const body = JSON.parse(row.body) as UpdateBody
      const record = {
        id: row.lifecycle, instance: cfg.self, commit: body.commit, asked: body.commit, onBranch: null, via: 'peer', op: row.id,
        reason: body.reason.slice(0, 500), requestedAt: row.created, run: '', attempt: '',
        requestedBy: { instance: row.peer, label: peer.label, actor: body.requester.actor.slice(0, 200), run: (body.requester.run ?? '').slice(0, 200), attempt: (body.requester.attempt ?? '').slice(0, 200), op: row.id },
      }
      const tmp = join(dir, 'requests', `.${row.lifecycle}.tmp`)
      writeFileSync(tmp, JSON.stringify(record, null, 1) + '\n')
      renameSync(tmp, req)
    }
    this.store.tx(() => {
      this.store.run('UPDATE mops SET state = \'accepted\', updated = ? WHERE id = ? AND dir = \'in\'', this.now, row.id)
      this.queueReceipt(cfg, this.mop(row.id, 'in')!)
    })
    return { state: 'done', note: `${row.id}: accepted — lifecycle request ${row.lifecycle} (commit ${(JSON.parse(row.body) as UpdateBody).commit.slice(0, 12)})` }
  }

  private queueReceipt(cfg: PeerConfig, row: MopRow, again = false) {
    const m = UPDATE_OP_ID.exec(row.id)![1]
    const e = envelope('update-receipt', {
      id: `${row.id}:receipt`, from: cfg.self, to: row.peer, request: m,
      body: { op: row.id, payload: row.payload, outcome: row.state === 'refused' ? 'refused' : 'accepted', code: row.code, reason: row.reason ?? (row.lifecycle ? `lifecycle request ${row.lifecycle} is durable here; it is not yet an update` : ''), update: row.state === 'refused' ? null : row.lifecycle, capabilities: [...CAPABILITIES] },
    })
    this.store.queue({ id: e.id, peer: row.peer, request: m, type: e.type, envelope: e }, again)
  }
  private size(e: Envelope) { return (this.store.constructor as typeof PeerStore).wire(e).length }

  // B: what the lifecycle says of an admitted update now (its record, or
  // its request not taken up yet); null when neither exists.
  statusOf(row: MopRow, historyCut = STATUS_HISTORY): UpdateStatusBody | null {
    const dir = this.lifecycleDir()
    if (!dir || !row.lifecycle) return null
    let rec = readJson(join(dir, 'updates', `${row.lifecycle}.json`))
    if (!rec && existsSync(join(dir, 'requests', `${row.lifecycle}.json`))) rec = { state: 'requested', history: [{ state: 'requested', at: row.updated }] }
    if (!rec) return null
    const history = (Array.isArray(rec.history) ? rec.history : []) as Record<string, unknown>[]
    const last = history.at(-1) ?? {}
    const h = (rec.health ?? null) as Record<string, unknown> | null
    const health: UpdateHealth | null = h ? {
      healthy: typeof h.healthy === 'boolean' ? h.healthy : null, api: typeof h.api === 'string' ? h.api.slice(0, 120) : null, instance: typeof h.instance === 'string' ? h.instance : null,
      cli: typeof h.cli === 'string' ? h.cli.slice(0, 120) : null, observer: typeof (h.observer as Record<string, unknown> | undefined)?.release === 'string' ? (h.observer as Record<string, string>).release : null,
      running: Object.fromEntries(Object.entries((h.running ?? {}) as Record<string, unknown>).filter(([k]) => SERVICES.includes(k)).map(([k, v]) => [k, !!v])),
    } : null
    const state = String(rec.state)
    return {
      op: row.id, update: row.lifecycle, state, terminal: isTerminal(state), h: Math.max(1, history.length),
      history: history.slice(-historyCut).map(x => ({ state: String(x.state), at: String(x.at) })),
      release: typeof rec.release === 'string' ? rec.release : null, previous: typeof rec.previous === 'string' ? rec.previous : null, health,
      notStarted: rec.notStarted && typeof rec.notStarted === 'object' ? Object.fromEntries(Object.entries(rec.notStarted as Record<string, unknown>).map(([k, v]) => [k, String(v).slice(0, 200)])) : null,
      reason: isTerminal(state) && typeof last.reason === 'string' ? last.reason.slice(0, 500) : '', at: this.now,
    }
  }

  // B: an observation for a peer. Only a peer granted `observe` gets the
  // sample; any configured peer gets the status of its own operations.
  private answerObserve(cfg: PeerConfig, peer: PeerEntry, e: Extract<Envelope, { type: 'observe' }>): Applied {
    const m = manageIdOf(peer.instance, cfg.self)
    if (e.request !== m) return { state: 'ignored', note: `misaddressed: ${e.request} is not ${peer.label}'s management id for this installation` }
    const allowed = peer.grant.includes('observe')
    const ids = e.body.ops.filter(id => id.startsWith(`${m}:update:`)).slice(0, OBSERVE_OPS)
    const opsOf = (cut: number) => Object.fromEntries(ids.map(id => {
      const row = this.mop(id, 'in')
      const a: OpAnswer = !row ? { op: id, state: 'unknown' } : row.state === 'refused' ? { op: id, state: 'refused', code: row.code, reason: row.reason ?? '' } : row.state === 'admitting' ? { op: id, state: 'admitting' } : this.statusOf(row, cut) ?? { op: id, state: 'unknown' }
      return [id, a]
    }))
    const s = allowed ? this.sample() : { sample: null, age: null, problem: null }
    const build = (cut: number, keep: number) => envelope('installation', {
      id: `${e.id}:installation`, from: cfg.self, to: peer.instance, request: m,
      body: { query: e.id, at: this.now, refused: allowed ? null : 'not-permitted', sample: s.sample, sampleAge: s.age, problem: s.problem, ops: Object.fromEntries(Object.entries(opsOf(cut)).slice(0, keep)), relation: this.relationFor(cfg, peer), capabilities: [...CAPABILITIES] },
    })
    let cut = STATUS_HISTORY, keep = ids.length, msg = build(cut, keep)
    while (this.size(msg) > MAX && (cut > 2 || keep > 0)) { if (cut > 2) cut = 2; else keep = Math.floor(keep / 2); msg = build(cut, keep) }
    this.store.queue({ id: msg.id, peer: peer.instance, request: m, type: msg.type, envelope: msg })
    return { state: 'done', note: `${e.id}: ${allowed ? 'observation told' : 'observation refused (not-permitted)'}${ids.length ? `, ${ids.length} operation(s)` : ''}` }
  }

  // B: the lifecycle's status record, reduced to the facts of the contract
  // (no paths, URLs, credentials or host configuration).
  sample(): { sample: InstallationSample | null; age: number | null; problem: string | null } {
    return lifecycleSample(this.lifecycleDir(), this.ms())
  }

  // p4: how a peer last named itself in a hello (null: never told).
  identityOf(instance: string): (PeerIdentity & { received: string }) | null {
    const r = this.store.one<{ identity: string | null; identity_seen: string | null }>('SELECT identity, identity_seen FROM peers WHERE instance = ?', instance)
    if (!r?.identity || !r.identity_seen) return null
    const v = JSON.parse(r.identity) as unknown
    return identityOk(v) ? { name: v.name, host: v.host, dashboard: v.dashboard, received: r.identity_seen } : null
  }

  // A: B's receipt for an update operation.
  private receipt(cfg: PeerConfig, peer: PeerEntry, e: Extract<Envelope, { type: 'update-receipt' }>): Applied {
    if (e.request !== manageIdOf(cfg.self, peer.instance)) return { state: 'ignored', note: `misaddressed: ${e.request} is not this installation's management id over ${peer.label}` }
    const row = this.mop(e.body.op, 'out')
    if (!row || row.peer !== peer.instance) return { state: 'ignored', note: `unknown operation ${e.body.op}` }
    if (row.payload !== e.body.payload) return { state: 'ignored', note: `conflict: the receipt names payload ${e.body.payload.slice(0, 19)}…, the operation is ${row.payload.slice(0, 19)}…` }
    this.store.answered(row.id)
    if (row.state === 'queued' || row.state === 'posted') {
      this.store.run('UPDATE mops SET state = ?, code = ?, reason = ?, lifecycle = ?, updated = ? WHERE id = ? AND dir = \'out\'', e.body.outcome, e.body.code, e.body.reason, e.body.update, this.now, row.id)
      return { state: 'done', note: `${row.id}: ${e.body.outcome}${e.body.code ? ` (${e.body.code})` : ''}${e.body.update ? ` — lifecycle update ${e.body.update} on ${peer.label}` : ''}` }
    }
    return { state: 'done', note: `${row.id}: receipt again (${row.state}); nothing changed` }
  }

  // A: a status of an update operation, from a message or an observation.
  // Only a newer one (a longer lifecycle history) replaces the kept one.
  private recordStatus(peer: PeerEntry, b: UpdateStatusBody, via: string): Applied {
    const row = this.mop(b.op, 'out')
    if (!row || row.peer !== peer.instance) return { state: 'ignored', note: `unknown operation ${b.op}` }
    const prev = row.status ? JSON.parse(row.status) as UpdateStatusBody : null
    if (prev && (b.h < prev.h || (b.h === prev.h && (prev.terminal || !b.terminal)))) return { state: 'done', note: `${b.op}: ${b.state} (h ${b.h}) already known` }
    this.store.answered(row.id)
    this.store.run('UPDATE mops SET status = ?, state = CASE WHEN state IN (\'queued\', \'posted\') THEN \'accepted\' ELSE state END, lifecycle = coalesce(lifecycle, ?), updated = ? WHERE id = ? AND dir = \'out\'', JSON.stringify(b), b.update, this.now, row.id)
    return { state: 'done', note: `${b.op}: ${b.state}${b.terminal ? ' (ended)' : ''} on ${peer.label} (${via})` }
  }

  // A: B's observation answer.
  private installation(cfg: PeerConfig, peer: PeerEntry, e: Extract<Envelope, { type: 'installation' }>): Applied {
    if (e.request !== manageIdOf(cfg.self, peer.instance)) return { state: 'ignored', note: `misaddressed: ${e.request} is not this installation's management id over ${peer.label}` }
    if (!this.store.one('SELECT 1 FROM outbox WHERE id = ?', e.body.query)) return { state: 'ignored', note: `unknown query ${e.body.query}` }
    const prev = this.store.one<ObservationRow>('SELECT * FROM observations WHERE peer = ?', peer.instance)
    const prevAt = prev?.body ? (JSON.parse(prev.body) as InstallationBody).at : null
    const notes: string[] = []
    if (!prevAt || e.body.at >= prevAt) {
      this.store.run('INSERT INTO observations (peer, query, body, received) VALUES (?, ?, ?, ?) ON CONFLICT (peer) DO UPDATE SET query = excluded.query, body = excluded.body, received = excluded.received', peer.instance, e.body.query, JSON.stringify(e.body), this.now)
    }
    if (e.body.relation) this.heardRelation(peer.instance, e.body.relation)
    for (const [id, a] of Object.entries(e.body.ops)) {
      const row = this.mop(id, 'out')
      if (!row || row.peer !== peer.instance) continue
      if (a.state === 'unknown') {
        // B never received it: posted again at once.
        if (this.store.run('UPDATE outbox SET state = \'ready\', reposts = reposts + 1 WHERE id = ? AND answered IS NULL AND state = \'sent\'', id).changes) notes.push(`${id} posted again (${peer.label} has not received it)`)
      } else if (a.state === 'refused' && 'code' in a) {
        if (row.state === 'queued' || row.state === 'posted') { this.store.answered(id); this.store.run('UPDATE mops SET state = \'refused\', code = ?, reason = ?, updated = ? WHERE id = ? AND dir = \'out\'', a.code ?? null, a.reason ?? '', this.now, id); notes.push(`${id}: refused (${a.code})`) }
      } else if ('h' in a) {
        const r = this.recordStatus(peer, a, 'observation')
        if (!r.note.endsWith('already known')) notes.push(r.note)
      }
    }
    const s = e.body.sample
    return { state: 'done', note: `${peer.label}: ${e.body.refused ? `observation refused (${e.body.refused})` : s ? `release ${s.release.active?.slice(0, 12) ?? 'none'}, sampled ${s.at}${e.body.problem ? ` — ${e.body.problem}` : ''}` : `no sample — ${e.body.problem ?? 'none'}`}${notes.length ? `; ${notes.join('; ')}` : ''}` }
  }

  // ---- passes ---------------------------------------------------------------------------------

  pass(cfg: PeerConfig): string[] {
    const notes: string[] = []
    // B: admissions left between the journal and the request file.
    for (const row of this.store.all<MopRow>('SELECT * FROM mops WHERE dir = \'in\' AND state = \'admitting\' ORDER BY created')) {
      try { notes.push(this.settle(cfg, row).note) } catch (e) { notes.push(`${row.id}: admission not settled — ${(e as Error).message}`) }
    }
    // B: each admitted update's new phases, told to the peer that asked.
    for (const row of this.store.all<MopRow>('SELECT * FROM mops WHERE dir = \'in\' AND state = \'accepted\' AND (status IS NULL OR json_extract(status, \'$.terminal\') = 0) ORDER BY created')) {
      try {
        const st = this.statusOf(row)
        if (!st || st.h <= row.told) continue
        const m = UPDATE_OP_ID.exec(row.id)![1]
        const e = envelope('update-status', { id: `${row.id}:status:${st.h}`, from: cfg.self, to: row.peer, request: m, body: st })
        this.store.tx(() => {
          this.store.queue({ id: e.id, peer: row.peer, request: m, type: e.type, envelope: e })
          this.store.run('UPDATE mops SET told = ?, status = ?, updated = ? WHERE id = ? AND dir = \'in\'', st.h, JSON.stringify(st), this.now, row.id)
        })
        notes.push(`${row.id}: ${st.state} told to ${row.peer}`)
      } catch (e) { notes.push(`${row.id}: status not told — ${(e as Error).message}`) }
    }
    notes.push(...this.observeDue(cfg))
    return notes
  }

  private unfinished(peer: string): MopRow[] {
    return this.store.all<MopRow>('SELECT * FROM mops WHERE dir = \'out\' AND peer = ? AND state IN (\'queued\', \'posted\', \'accepted\') AND (status IS NULL OR json_extract(status, \'$.terminal\') = 0) ORDER BY n', peer)
  }

  // A: an observation per managed peer: every minute while an update is
  // unfinished, otherwise every 15 minutes. One outstanding; a lost one is
  // replaced by the next.
  observeDue(cfg: PeerConfig, force?: string): string[] {
    const notes: string[] = []
    for (const p of cfg.peers) {
      const open = this.unfinished(p.instance)
      if (!p.manage.includes('observe') && !open.length) continue
      if (!this.store.capabilitiesOf(p.instance).capabilities.includes('observe')) {
        if (force === p.instance) throw new RequestError(409, `${p.label} has not said it answers observations (its release has no management, or it has not posted since its update); nothing was sent`, { code: 'peer-unsupported' })
        continue
      }
      const obs = this.store.one<ObservationRow>('SELECT * FROM observations WHERE peer = ?', p.instance)
      const last = Math.max(obs?.asked ? Date.parse(obs.asked) : 0, obs?.received ? Date.parse(obs.received) : 0)
      if (force !== p.instance && this.ms() - last < (open.length ? OBSERVE_BUSY_MS : OBSERVE_IDLE_MS)) continue
      const m = manageIdOf(cfg.self, p.instance)
      const k = (obs?.asks ?? 0) + 1
      const e = envelope('observe', { id: `${m}:observe:${k}`, from: cfg.self, to: p.instance, request: m, body: { ops: open.map(r => r.id).slice(0, OBSERVE_OPS), capabilities: [...CAPABILITIES] } })
      this.store.tx(() => {
        this.store.queue({ id: e.id, peer: p.instance, request: m, type: e.type, envelope: e })
        this.store.run('INSERT INTO observations (peer, asks, asked, route) VALUES (?, ?, ?, \'http\') ON CONFLICT (peer) DO UPDATE SET asks = excluded.asks, asked = excluded.asked, route = excluded.route', p.instance, k, this.now)
      })
      notes.push(`${p.label}: observation asked (${e.id})`)
    }
    return notes
  }

  // ---- commands (A) ---------------------------------------------------------------------------

  static peerByName(cfg: PeerConfig, name: string): PeerEntry {
    const p = cfg.peers.find(x => x.instance === name) ?? cfg.peers.find(x => x.label === name)
    if (!p) throw new RequestError(404, `${name} is not a configured peer (${cfg.peers.map(x => `${x.label} ${x.instance}`).join(', ') || 'none'})`, { code: 'peer-unknown' })
    return p
  }

  requestUpdate(cfg: PeerConfig, name: string, o: { commit: string; reason: string; by: string; run?: string | null; attempt?: string | null }): { op: string; duplicate: boolean; row: MopRow } {
    const p = Management.peerByName(cfg, name)
    if (!p.manage.includes('update')) throw new RequestError(409, `this installation does not manage updates of ${p.label} (peers.json manage: ${p.manage.join(', ') || 'nothing'}); nothing was recorded`, { code: 'manage-not-permitted' })
    const en = this.enrollment(cfg, p)
    if (en.state !== 'mutual') throw new RequestError(409, `${p.label} is ${en.state}: ${en.detail}; an update is sent only to a mutual child that granted it. Nothing was recorded`, { code: 'manage-enrollment' })
    if (!(this.relationOf(p.instance).relation?.grants ?? []).includes('update')) throw new RequestError(409, `${p.label} has not granted update to this installation; nothing was recorded`, { code: 'manage-not-permitted' })
    if (!COMMIT.test(o.commit)) throw new RequestError(400, `${o.commit} is not a full commit hash; an update names the exact commit`, { code: 'manage-commit' })
    if (!o.reason.trim()) throw new RequestError(400, 'an update says why (--reason)', { code: 'manage-reason' })
    const open = this.unfinished(p.instance)
    if (open.length) {
      const same = open.find(r => (JSON.parse(r.body) as UpdateBody).commit === o.commit)
      if (same) return { op: same.id, duplicate: true, row: same }
      throw new RequestError(409, `update ${open[0].id} of ${p.label} has not ended (${open[0].state}${open[0].status ? `, ${(JSON.parse(open[0].status) as UpdateStatusBody).state}` : ''}); one update at a time. Nothing was recorded`, { code: 'manage-busy' })
    }
    const m = manageIdOf(cfg.self, p.instance)
    const n = (this.store.one<{ n: number | null }>('SELECT max(n) AS n FROM mops WHERE dir = \'out\' AND peer = ? AND kind = \'update\'', p.instance)?.n ?? 0) + 1
    const body: UpdateBody = { target: p.instance, commit: o.commit, reason: o.reason, requester: { instance: cfg.self, actor: o.by.slice(0, 200), run: o.run ?? null, attempt: o.attempt ?? null } }
    const e = envelope('update', { id: `${m}:update:${n}`, from: cfg.self, to: p.instance, request: m, body })
    const size = this.size(e)
    if (size > MAX) throw new RequestError(413, `the update message would be ${size} characters (at most ${MAX}); shorten the reason. Nothing was recorded`, { code: 'peer-message-size' })
    if (!this.hasManageCredential(p)) throw new RequestError(409, `${p.label} is managed over HTTP, but no management credential it issued is installed here; its operator issues one (wfe peer credential issue ${cfg.self} --scope manage) and this installation installs it. Nothing was recorded`, { code: 'peer-credential' })
    this.store.tx(() => {
      this.store.run('INSERT INTO mops (id, dir, peer, kind, n, payload, body, state, created, updated, route) VALUES (?, \'out\', ?, \'update\', ?, ?, ?, \'queued\', ?, ?, \'http\')', e.id, p.instance, n, e.payload, JSON.stringify(body), this.now, this.now)
      this.store.queue({ id: e.id, peer: p.instance, request: m, type: 'update', envelope: e })
      // Observe soon after: the next pass asks.
      this.store.run('UPDATE observations SET asked = NULL WHERE peer = ?', p.instance)
    })
    return { op: e.id, duplicate: false, row: this.mop(e.id, 'out')! }
  }

  hasManageCredential(p: PeerEntry): boolean {
    try { return !!readFileSync(manageCredentialFile(this.store.ctx.area, p), 'utf8').trim() } catch { return false }
  }

  observeNow(cfg: PeerConfig, name: string): string[] {
    const p = Management.peerByName(cfg, name)
    if (!p.manage.includes('observe') && !this.unfinished(p.instance).length) throw new RequestError(409, `this installation does not observe ${p.label} (peers.json manage: ${p.manage.join(', ') || 'nothing'})`, { code: 'manage-not-permitted' })
    return this.observeDue(cfg, p.instance)
  }

  // ---- views ----------------------------------------------------------------------------------

  observationOf(peer: string): { state: 'fresh' | 'stale' | 'unknown'; detail: string; body: InstallationBody | null; received: string | null; asked: string | null } {
    const o = this.store.one<ObservationRow>('SELECT * FROM observations WHERE peer = ?', peer)
    if (!o?.body) return { state: 'unknown', detail: o?.asked ? `asked ${o.asked}, no answer yet` : 'never observed', body: null, received: null, asked: o?.asked ?? null }
    const b = JSON.parse(o.body) as InstallationBody
    const age = Math.round((this.ms() - Date.parse(o.received!)) / 1000)
    if (b.refused) return { state: 'stale', detail: `refused (${b.refused})`, body: b, received: o.received, asked: o.asked }
    if (age * 1000 > MANAGE_STALE_MS) return { state: 'stale', detail: `last answer received ${o.received} (${Math.round(age / 60)} min ago)`, body: b, received: o.received, asked: o.asked }
    if (!b.sample || b.problem) return { state: 'stale', detail: b.problem ?? 'no sample', body: b, received: o.received, asked: o.asked }
    return { state: 'fresh', detail: `sampled ${b.sample.at} (${b.sampleAge ?? '?'} s before the answer), received ${o.received}`, body: b, received: o.received, asked: o.asked }
  }

  opView(row: MopRow) {
    const body = JSON.parse(row.body) as UpdateBody
    const st = row.status ? JSON.parse(row.status) as UpdateStatusBody : null
    const out = this.store.one<{ state: string; attempts: number; reposts: number; next_retry: string | null; error: string | null; answered: string | null; sent: string | null }>('SELECT state, attempts, reposts, next_retry, error, answered, sent FROM outbox WHERE id = ?', row.id)
    const selected = st?.release ?? null
    const serving = st?.health?.api ?? null
    const verified = st?.state === 'succeeded' && st.health?.healthy === true && serving === body.commit && selected === body.commit && st.health.instance === row.peer
    const partial = st?.state === 'failed' && !!st.notStarted && Object.keys(st.notStarted).length > 0
    const heardAt = st?.at ?? null
    const outcome = row.dir === 'in' ? this.inOutcome(row)
      : row.state === 'queued' ? 'unknown — queued, not posted yet'
        : row.state === 'posted' ? `unknown — no receipt yet (posted ${out?.attempts ?? 0}×${out?.next_retry ? `, next retry ${out.next_retry}` : ''}${out?.error ? `, last error ${out.error}` : ''})`
          : row.state === 'refused' ? `refused (${row.code}): ${row.reason ?? ''}`
            : !st ? `acknowledged — lifecycle request ${row.lifecycle} is durable on ${row.peer}; no phase heard yet`
              : !st.terminal ? `in progress — ${st.state} since ${st.history.at(-1)?.at ?? '?'} (heard ${heardAt}${this.ms() - Date.parse(heardAt!) > MANAGE_STALE_MS ? ', no news for a while: unknown since' : ''})`
                : verified ? `completed, verified — ${row.peer} serves ${body.commit.slice(0, 12)} and its services are healthy`
                  : st.state === 'succeeded' ? `succeeded per the lifecycle, NOT verified — serving ${serving ?? 'unknown'}, selected ${selected ?? 'unknown'}, healthy ${String(st.health?.healthy)}`
                    : partial ? `failed, partially active — release ${selected?.slice(0, 12) ?? '?'} selected; not started: ${Object.keys(st.notStarted!).join(', ')}; ${st.reason}`
                      : `${st.state} — ${st.reason}`
    return {
      id: row.id, dir: row.dir, peer: row.peer, route: row.route, commit: body.commit, reason: body.reason, requester: body.requester, created: row.created,
      acknowledged: row.state === 'accepted' ? 'accepted' : row.state === 'refused' ? 'refused' : row.state === 'admitting' ? 'admitting' : 'unknown',
      code: row.code, lifecycle: row.lifecycle, phase: st?.state ?? null, terminal: st?.terminal ?? (row.state === 'refused'), history: st?.history ?? [],
      selected, serving, healthy: st?.health?.healthy ?? null, verified, partial, notStarted: st?.notStarted ?? null, delivery: out ?? null, heard: heardAt, outcome,
    }
  }
  private inOutcome(row: MopRow): string {
    if (row.state === 'refused') return `refused (${row.code}): ${row.reason ?? ''}`
    if (row.state === 'admitting') return `admitting — lifecycle request ${row.lifecycle} being written`
    const st = this.statusOf(row)
    return st ? `${st.state}${st.terminal ? ' (ended)' : ''} — lifecycle update ${row.lifecycle}; told ${row.told} phase(s)` : `accepted — lifecycle update ${row.lifecycle}, no record found`
  }

  show(id: string) {
    const rows = this.store.all<MopRow>('SELECT * FROM mops WHERE id = ? ORDER BY dir', id)
    if (!rows.length) throw new RequestError(404, `no management operation ${id}`, { code: 'manage-unknown' })
    return rows.map(r => this.opView(r))
  }

  status(cfg: PeerConfig) {
    return {
      self: cfg.self, ancestry: this.ancestry(cfg),
      peers: cfg.peers.filter(p => p.parentage !== 'none' || p.grant.length || p.manage.length || this.store.one('SELECT 1 FROM mops WHERE peer = ?', p.instance)).map(p => {
        const heard = this.relationOf(p.instance)
        return {
          instance: p.instance, label: p.label, parentage: p.parentage, grant: p.grant, manage: p.manage,
          enrollment: this.enrollment(cfg, p), heard: heard.relation, heardAt: heard.seen, capabilities: this.store.capabilitiesOf(p.instance).capabilities,
          capabilitiesSeen: this.store.capabilitiesOf(p.instance).seen, identity: this.identityOf(p.instance),
          // p4: whether this side can start management with this peer (over HTTP, its management credential).
          manageCredential: this.hasManageCredential(p),
          observation: p.manage.includes('observe') ? this.observationOf(p.instance) : null,
          operations: this.store.all<MopRow>('SELECT * FROM mops WHERE peer = ? ORDER BY created DESC LIMIT 10', p.instance).map(r => this.opView(r)),
        }
      }),
    }
  }
}

export const grants = (p: PeerEntry, a: AdminAccess) => p.grant.includes(a)

// The lifecycle's status record, reduced to the facts of the contract (no
// paths, URLs, credentials or host configuration).
export function lifecycleSample(dir: string | null, nowMs: number): { sample: InstallationSample | null; age: number | null; problem: string | null } {
  const raw = dir ? readJson(join(dir, 'status', 'installation.json')) : null
  if (!raw || typeof raw.at !== 'string') return { sample: null, age: null, problem: dir ? 'the lifecycle is not reporting (no status record)' : 'the lifecycle folder is not known to this service (AGDEV_LIFECYCLE)' }
  const str = (v: unknown) => typeof v === 'string' ? v.slice(0, 120) : null
  const rel = (raw.release ?? {}) as Record<string, unknown>, serving = raw.serving as Record<string, unknown> | null, upd = raw.update as Record<string, unknown> | null
  const sample: InstallationSample = {
    instance: String(raw.instance ?? ''), at: raw.at, release: { active: str(rel.active) },
    serving: serving && typeof serving === 'object' ? { release: str(serving.release), instance: str(serving.instance) } : null,
    services: Object.fromEntries(Object.entries((raw.services ?? {}) as Record<string, unknown>).filter(([k]) => SERVICES.includes(k)).map(([k, v]) => [k, v === 'running' || v === 'stopped' ? v : 'unknown'])),
    draining: !!raw.draining, update: upd && typeof upd === 'object' ? { id: String(upd.id), state: String(upd.state), since: String(upd.since ?? '') } : null, tool: str(raw.tool),
  }
  const age = Math.round((nowMs - Date.parse(raw.at)) / 1000)
  return { sample, age, problem: age > SAMPLE_STALE_S ? `the lifecycle has not reported since ${raw.at} (${age} s)` : null }
}

// p4 (docs/management.md, Display identity): how this installation names
// itself to its peers and on its Cluster view — the display name of
// site.json, the OS host name of this service, the dashboard base the link
// already uses for run URLs (peers.json viewBase, else present.json's answerBase).
// A value that does not fit the bound is left out, never cut.
export function localIdentity(area: string, cfg: PeerConfig | null): PeerIdentity {
  const fit = (v: string | null | undefined, max: number) => v && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null
  const name = (() => { try { return siteView(area, null).name } catch { return null } })()
  const bases = [cfg?.viewBase, editorBase(area)]
  let dashboard: string | null = null
  for (const b of bases) {
    const u = browserUrl(b)
    if ('url' in u) { dashboard = fit(u.url, 300); break }
  }
  return { name: fit(name, 64), host: fit(hostname(), 253), dashboard }
}
