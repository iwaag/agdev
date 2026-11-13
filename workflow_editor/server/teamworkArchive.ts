// The teamwork archive (cluster_teamwork p3, docs/teamwork-archive.md):
// published, readable history of the work this installation did with other
// installations over the agdev link — independent of Zulip, of the live link
// store and of the peers being up.
//
// Peer work has no conversation room, so the conversation archive does not
// carry it. This writer extends the same publication model into the same
// archive repository (conversations.json "archive"; each installation's own
// pj-ponderer), in a namespace only this installation writes:
//
//   instances/<instance>/teamwork/<request>/manifest.json     ag.teamwork.v1
//   instances/<instance>/teamwork/<request>/transcript.jsonl  append-only records
//   instances/<instance>/teamwork/<request>/transcript.md     readable, regenerated from the records
//   instances/<instance>/teamwork/<request>/derived/          interpretations by runs; never this writer
//   instances/<instance>/teamwork/index.md                    every request of this instance
//
// Records come only from authoritative sources — this installation's run
// records (the requester's parent run and its follow-ups, or the run a
// received request created) and its link store — never reconstructed:
//
//   utterance  words recorded in a run: a request's input file (verified by
//              its recorded sha256), questions, answers, a relayed question or
//              result of the other side (with the source's seq and time beside
//              the time it was recorded here), judgements, outcomes, notes
//   state      every other entry of those runs' histories, as recorded
//   delivery   the link store's transport facts: Zulip posts read, messages
//              sent, HTTP deliveries (stored / duplicate / conflict), applied
//              operations, relayed facts. A duplicate arrival is a delivery,
//              never another utterance.
//
// Each record has a stable id. The repository is the truth: an export fetches
// the published branch, reads the ids already in the published transcript,
// appends only the others, rewrites the manifest and the readable view,
// commits and pushes; a rejected push is rebuilt on the new remote state. A
// crash after the push publishes nothing twice: the next export finds the ids.
// The other installation's half lives in its own archive; this one points at
// it by instance, run and result commit, and never claims its live state.
// Failure leaves everything else alone and is retried later.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { runKey, type RunRecord, type RunRef } from '../shared/run.ts'
import { destinationOf } from './conversationArchive.ts'
import { uidOf } from './delegate.ts'
import type { ExecStore } from './exec.ts'
import { git, gitOk } from './git.ts'
import { withLock } from './lock.ts'
import type { PeerStore } from './peerlink.ts'
import { readRun, runDir } from './runs.ts'
import { listCopies } from './runspace.ts'
import type { Workspace } from './workspace.ts'

export const TEAMWORK_FORMAT = 'ag.teamwork.v1'
const IDENTITY = { 'user.name': 'WFE teamwork archive', 'user.email': 'wfe-teamwork-archive@agdev.invalid' }
const now = () => new Date().toISOString()
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

export type RecordKind = 'utterance' | 'state' | 'delivery'
export interface TeamRecord {
  id: string
  type: RecordKind
  at: string // when it was recorded at its source here
  [k: string]: unknown
}
interface RunPart { ref: RunRef; ws: Workspace; wsId: string; record: RunRecord; dir: string; uid: string; why: string }
export interface TeamRequest { request: string; role: 'requester' | 'receiver'; peer: string; route: string; delegation: string; workspace: string; run: RunRef | null }
export interface TeamState { state: 'current' | 'failed'; commit: string | null; records: number; horizon: Horizon | null; at: string | null; error: string | null; tries: number; attempted: string | null; destination: string | null }
export interface Horizon { records: number; runs: Record<string, number>; journal: number }
export interface TeamStatus { request: string; role: string; peer: string; state: 'current' | 'behind' | 'failed' | 'never' | 'unverified' | 'disabled'; live: Horizon | null; published: TeamState | null; path: string; url: string | null; error: string | null }

export class TeamworkArchive {
  readonly area: string
  readonly exec: ExecStore
  readonly peers: PeerStore
  readonly self: string
  readonly dir: string
  readonly stateFile: string
  constructor(o: { area: string; exec: ExecStore; peers: PeerStore; self: string; dir?: string }) {
    this.area = o.area; this.exec = o.exec; this.peers = o.peers; this.self = o.self
    this.dir = o.dir ?? join(o.area, '.local', 'teamwork', 'archive')
    this.stateFile = join(o.area, '.local', 'teamwork', 'state.json')
  }

  pathOf(request: string) { return `instances/${this.self}/teamwork/${request}` }

  // ---- bookkeeping (not the truth: the repository is) ----
  private states(): Record<string, TeamState> { try { return JSON.parse(readFileSync(this.stateFile, 'utf8')) as Record<string, TeamState> } catch { return {} } }
  private save(request: string, s: Partial<TeamState>) {
    const all = this.states()
    const cur: TeamState = all[request] ?? { state: 'failed', commit: null, records: 0, horizon: null, at: null, error: null, tries: 0, attempted: null, destination: null }
    all[request] = { ...cur, ...s }
    mkdirSync(join(this.stateFile, '..'), { recursive: true })
    writeFileSync(this.stateFile + '.tmp', JSON.stringify(all, null, 1) + '\n'); writeFileSync(this.stateFile, readFileSync(this.stateFile + '.tmp'))
  }

  // ---- destination: the archive project's origin (conversations.json "archive") ----
  async origin(): Promise<{ url: string; web: string | null; destination: string } | { disabled: string }> {
    let cfg: { archive?: { workspace?: string } }
    try { cfg = JSON.parse(readFileSync(join(this.area, 'conversations.json'), 'utf8')) } catch { return { disabled: 'no conversations.json: no archive project is configured here' } }
    const id = cfg.archive?.workspace
    if (!id) return { disabled: 'conversations.json names no archive project' }
    try {
      const ws = await this.exec.workspace(id)
      let url = (await gitOk(ws.root, ['remote', 'get-url', 'origin'])).trim()
      if (!/^[a-z+]+:\/\//.test(url) && !isAbsolute(url) && !/^[^/]+@[^:]+:/.test(url)) url = resolve(ws.root, url)
      const destination = destinationOf(url)
      return { url, web: /^https?:\/\//.test(destination) ? destination : null, destination }
    } catch (e) { return { disabled: `the archive workspace ${id} has no readable origin: ${(e as Error).message}` } }
  }
  private async env(): Promise<Record<string, string>> { return this.exec.ctx.gitea ? await this.exec.ctx.gitea.gitEnv() : {} }

  // ---- what there is to archive ----
  requests(): TeamRequest[] {
    const out: TeamRequest[] = []
    for (const r of this.peers.db.prepare('SELECT request, peer, delegation, parent_ws, parent_workflow, parent_run, route FROM outbound ORDER BY request').all() as { request: string; peer: string; delegation: string; parent_ws: string; parent_workflow: string; parent_run: string; route: string }[])
      out.push({ request: r.request, role: 'requester', peer: r.peer, route: r.route, delegation: r.delegation, workspace: r.parent_ws, run: { workflow: r.parent_workflow, run: r.parent_run } })
    for (const r of this.peers.db.prepare('SELECT request, peer, delegation, workspace, run_workflow, run, route FROM inbound ORDER BY request').all() as { request: string; peer: string; delegation: string; workspace: string | null; run_workflow: string | null; run: string | null; route: string }[])
      out.push({ request: r.request, role: 'receiver', peer: r.peer, route: r.route, delegation: r.delegation, workspace: r.workspace ?? '', run: r.run_workflow && r.run ? { workflow: r.run_workflow, run: r.run } : null })
    return out
  }

  private async runs(t: TeamRequest): Promise<RunPart[]> {
    if (!t.run || !t.workspace) return []
    const ws = await this.exec.workspace(t.workspace)
    const one = async (ref: RunRef, why: string): Promise<RunPart | null> => {
      const r = await readRun(ws, ref).catch(() => null)
      if (!r?.record) return null
      return { ref, ws, wsId: t.workspace, record: r.record, dir: r.dir, uid: uidOf(r.record), why }
    }
    const main = await one(t.run, t.role === 'requester' ? 'the run that delegated' : 'the run the request created')
    if (!main) return []
    const parts = [main]
    // The requester's follow-ups: runs whose predecessor is the parent run
    // (P2's verification run), recorded as such — not as the delegation itself.
    if (t.role === 'requester') {
      for (const c of await listCopies(ws, undefined).catch(() => [])) {
        const ref = c.ref
        if (runKey(ref) === runKey(t.run)) continue
        const p = await one(ref, `follow-up: its predecessor is ${runKey(t.run)}`)
        if (p?.record.predecessor && runKey(p.record.predecessor) === runKey(t.run)) parts.push(p)
      }
    }
    return parts
  }

  // Every record of a request, from the sources, in a stable order.
  async collect(t: TeamRequest): Promise<{ records: TeamRecord[]; parts: RunPart[]; horizon: Horizon }> {
    const parts = await this.runs(t)
    const records: TeamRecord[] = []
    for (const p of parts) for (const h of p.record.history) records.push(await this.fromEntry(t, p, h as unknown as Entry))
    records.push(...this.journal(t))
    records.sort((a, b) => a.at.localeCompare(b.at) || order(a) - order(b) || a.id.localeCompare(b.id))
    const horizon: Horizon = { records: records.length, runs: Object.fromEntries(parts.map(p => [p.uid, p.record.seq])), journal: records.filter(r => r.type === 'delivery').length }
    return { records, parts, horizon }
  }

  private async fileText(p: RunPart, path: string | undefined, expected: string | undefined): Promise<{ text: string | null; sha256: string | null; problem?: string }> {
    if (!path) return { text: null, sha256: null, problem: 'no file named' }
    const base = runDir(p.ref) + '/'
    const rel = path.startsWith(base) ? path.slice(base.length) : path.includes('/') ? null : path
    if (rel === null || rel.includes('..')) return { text: null, sha256: null, problem: `${path} is outside the run folder` }
    const b = await readFile(join(p.dir, rel)).catch(() => null)
    if (!b) return { text: null, sha256: null, problem: `${path} is not readable now` }
    const h = sha256(b)
    if (expected && h !== expected) return { text: null, sha256: h, problem: `${path} is ${h.slice(0, 12)} now, not the ${expected.slice(0, 12)} recorded: its words are not exported as the original` }
    return { text: b.toString('utf8'), sha256: h }
  }

  private async fromEntry(t: TeamRequest, p: RunPart, h: Entry): Promise<TeamRecord> {
    const source = { instance: this.self, project: p.record.project, workspace: p.wsId, workflow: p.ref.workflow, run: p.ref.run, uid: p.uid, seq: h.seq, part: p.why }
    const base = { id: `${this.self}:${p.uid}:${h.seq}`, at: h.at, source, op: h.op, by: h.by, via: h.via }
    const u = (o: Record<string, unknown>): TeamRecord => ({ ...base, type: 'utterance', ...o, recorded: h })
    // Entries of another delegation of the same run are states here.
    const mine = !h.delegation || typeof h.delegation !== 'string' || h.delegation === t.delegation.split('/').at(-1)
    switch (h.op) {
      case 'run.create': {
        const f = await this.fileText(p, h.input?.file, h.input?.sha256)
        return u({ kind: 'request', author: h.input?.author ?? h.input?.requester ?? h.by, onBehalfOf: h.input?.onBehalfOf ?? null, file: h.input?.file ?? null, sha256: h.input?.sha256 ?? null, text: f.text, ...(f.problem ? { problem: f.problem } : {}), inputSource: h.input?.source ?? null })
      }
      case 'delegation.dispatch': if (mine) {
        const f = await this.fileText(p, h.request?.path, h.request?.sha256)
        return u({ kind: 'request', direction: 'sent', author: h.by, onBehalfOf: h.onBehalfOf ?? null, to: { instance: h.target?.instance ?? null, project: h.target?.project, workflow: h.target?.workflow }, relation: { request: t.request, delegation: h.uid }, file: h.request?.path ?? null, sha256: h.request?.sha256 ?? null, text: f.text, ...(f.problem ? { problem: f.problem } : {}) })
      } break
      case 'question.ask': return u({ kind: 'question', author: h.by, to: h.to ?? null, relation: { request: t.request, question: h.question }, text: h.text })
      case 'question.answer': return u({ kind: 'answer', author: h.from ?? h.by, actor: h.by, relation: { request: t.request, question: h.question, answer: typeof h.delegation === 'object' ? h.delegation.answer : null }, text: h.text, receipt: h.receipt ?? null })
      case 'delegation.answer': if (mine) return u({ kind: 'answer', direction: 'sent', author: h.by, to: { instance: t.peer }, relation: { request: t.request, question: h.question }, text: h.text })
        break
      case 'delegation.event': if (mine && h.event?.text && h.event.type !== 'integrated') return u({ kind: h.event.type === 'question' ? 'question' : h.event.type === 'completed' ? 'result' : h.event.type, direction: 'received', author: h.event.child?.by ?? null, origin: { instance: t.peer, seq: h.event.child?.seq ?? null, at: h.event.child?.at ?? null }, receivedAt: h.at, relation: { request: t.request, ...(h.event.question ? { question: h.event.question } : {}) }, text: h.event.text, manifest: h.event.manifest ?? null })
        break
      case 'delegation.dispose': if (mine) return u({ kind: 'judgement', author: h.by, relation: { request: t.request }, disposition: h.disposition, text: h.note, manifest: h.manifest ?? null })
        break
      case 'node.complete': if (h.outcome) return u({ kind: 'outcome', author: h.by, node: h.node, text: h.outcome })
        break
      case 'run.recover': if (h.reason) return u({ kind: 'note', author: h.by, text: h.reason, incident: h.incident ?? null })
        break
      case 'presentation.retain': if (h.note) return u({ kind: 'note', author: h.by, text: h.note, owner: h.owner ?? null })
        break
    }
    return { ...base, type: 'state', recorded: h }
  }

  // The link store's transport facts of one request.
  journal(t: TeamRequest): TeamRecord[] {
    const db = this.peers.db, out: TeamRecord[] = []
    const where = { instance: this.self, store: 'peerlink' }
    const d = (id: string, at: string, o: Record<string, unknown>): TeamRecord => ({ id: `${this.self}:link:${id}`, type: 'delivery', at, source: where, relation: { request: t.request }, ...o })
    for (const r of db.prepare('SELECT realm, message, stream, sender, sender_name, topic, content, ts, state, type, note, received FROM inbox WHERE request = ? ORDER BY message').all(t.request) as Record<string, string | number>[])
      out.push(d(`zulip/${r.realm}/${r.message}`, new Date(Number(r.ts) * 1000).toISOString(), { route: 'zulip', direction: 'read', message: r.message, realm: r.realm, stream: r.stream, sender: r.sender, senderName: r.sender_name, topic: r.topic, messageType: r.type, outcome: r.state, note: r.note, receivedAt: r.received, transport: { content: r.content } }))
    for (const r of db.prepare("SELECT id, peer, type, route, state, message, attempts, created, sent, error, receipt FROM outbox WHERE request = ? AND state IN ('sent', 'refused', 'failed', 'dropped') ORDER BY created").all(t.request) as Record<string, string | number | null>[])
      out.push(d(`outbox/${r.id}/${r.state}`, String(r.created), { route: r.route, direction: 'sent', to: r.peer, logical: r.id, messageType: r.type, outcome: r.state, message: r.message, attempts: r.attempts, queuedAt: r.created, lastSentAt: r.sent, firstSentAt: 'not kept by the link store (only the last send and the attempt count)', error: r.error, receipt: r.receipt ? JSON.parse(String(r.receipt)) : null }))
    for (const r of db.prepare("SELECT peer, id, type, state, note, received, updated FROM hinbox WHERE request = ? AND state IN ('done', 'ignored', 'failed') ORDER BY received").all(t.request) as Record<string, string>[])
      out.push(d(`http-in/${r.peer}/${r.id}/${r.state}`, r.received, { route: 'http', direction: 'received', from: r.peer, logical: r.id, messageType: r.type, outcome: r.state, note: r.note, appliedAt: r.updated }))
    for (const r of db.prepare('SELECT d.peer, d.id, d.n, d.at, d.outcome FROM hdeliveries d JOIN hinbox h ON h.peer = d.peer AND h.id = d.id WHERE h.request = ? ORDER BY d.at').all(t.request) as Record<string, string | number>[])
      out.push(d(`http-delivery/${r.peer}/${r.id}/${r.n}`, String(r.at), { route: 'http', direction: 'arrival', from: r.peer, logical: r.id, attempt: r.n, outcome: r.outcome }))
    for (const r of db.prepare("SELECT id, dir, kind, state, code, reason, seq, message, created, updated FROM ops WHERE request = ? AND state NOT IN ('pending', 'queued') ORDER BY created").all(t.request) as Record<string, string | number | null>[])
      out.push(d(`op/${r.id}/${r.dir}/${r.state}`, String(r.updated), { direction: r.dir, logical: r.id, operation: r.kind, outcome: r.state, code: r.code, reason: r.reason, appliedSeq: r.seq, message: r.message, createdAt: r.created }))
    for (const r of db.prepare('SELECT fact, receipt, state, note, at FROM facts WHERE request = ? ORDER BY at').all(t.request) as Record<string, string>[])
      out.push(d(`fact/${r.fact}/${r.state}`, r.at, { direction: 'relayed', fact: r.fact, receipt: r.receipt, outcome: r.state, note: r.note }))
    return out
  }

  // ---- status ----
  async status(): Promise<TeamStatus[]> {
    const o = await this.origin()
    const st = this.states()
    const out: TeamStatus[] = []
    for (const t of this.requests()) {
      const live = await this.collect(t).then(c => c.horizon, () => null)
      const s = st[t.request] ?? null
      const elsewhere = !!s?.destination && !('disabled' in o) && s.destination !== o.destination
      const state: TeamStatus['state'] = 'disabled' in o ? 'disabled' : s?.state === 'failed' ? 'failed' : !s?.commit ? 'never' : elsewhere ? 'unverified' : live && covers(s.horizon, live) ? 'current' : 'behind'
      const web = s?.destination && /^https?:\/\//.test(s.destination) ? s.destination : null
      out.push({ request: t.request, role: t.role, peer: t.peer, state, live, published: s, path: this.pathOf(t.request), url: web && s?.commit ? `${web}/src/commit/${s.commit}/${this.pathOf(t.request)}` : null, error: 'disabled' in o ? o.disabled : s?.error ?? null })
    }
    return out
  }

  // Requests whose live records go beyond the published horizon (a failed
  // one waits 2^tries minutes, at most an hour).
  async due(at = Date.now(), destination?: string): Promise<TeamRequest[]> {
    const st = this.states(), out: TeamRequest[] = []
    for (const t of this.requests()) {
      const s = st[t.request]
      if (s?.state === 'failed' && s.attempted && at - Date.parse(s.attempted) < Math.min(2 ** s.tries, 60) * 60_000) continue
      if (!s || s.state !== 'current' || !s.horizon || (destination && s.destination !== destination)) { out.push(t); continue }
      const live = await this.collect(t).then(c => c.horizon, () => null)
      if (live && !covers(s.horizon, live)) out.push(t)
    }
    return out
  }

  // ---- publication ----
  async publish(only?: string[], o: { interruptAfterPush?: boolean } = {}): Promise<{ published: { request: string; commit: string; records: number }[]; unchanged: string[]; failed: { request: string; error: string }[] }> {
    const origin = await this.origin()
    const all = this.requests()
    if ('disabled' in origin) return { published: [], unchanged: [], failed: (only ? all.filter(t => only.includes(t.request)) : []).map(t => ({ request: t.request, error: origin.disabled })) }
    const targets = only ? all.filter(t => only.includes(t.request)) : await this.due(Date.now(), origin.destination)
    if (!targets.length) return { published: [], unchanged: [], failed: [] }
    mkdirSync(join(this.dir, '..'), { recursive: true })
    return withLock(join(this.dir, '..', 'archive.writer'), async () => {
      const env = await this.env()
      const g = (args: string[]) => gitOk(this.dir, args, { env, config: IDENTITY, timeoutMs: 120_000 })
      const at = now()
      for (const t of targets) this.save(t.request, { attempted: at })
      try {
        // Collected before any repository work: no run or link lock is held
        // across the network.
        const collected = new Map<string, Awaited<ReturnType<TeamworkArchive['collect']>>>()
        for (const t of targets) collected.set(t.request, await this.collect(t))
        if (existsSync(join(this.dir, '.git'))) {
          const was = await git(this.dir, ['remote', 'get-url', 'origin'], { env })
          if (was.code !== 0 || destinationOf(was.stdout.trim()) !== origin.destination) rmSync(this.dir, { recursive: true, force: true })
          else await g(['remote', 'set-url', 'origin', origin.url])
        }
        if (!existsSync(join(this.dir, '.git'))) await gitOk(join(this.dir, '..'), ['clone', '-q', '--', origin.url, this.dir], { env, timeoutMs: 180_000 })
        for (let round = 1; ; round++) {
          await g(['fetch', '-q', 'origin'])
          const branch = await this.branch(env)
          if ((await git(this.dir, ['rev-parse', '--verify', '-q', 'HEAD'], { env })).code === 0) await g(['reset', '-q', '--hard'])
          if ((await git(this.dir, ['rev-parse', '--verify', '-q', `origin/${branch}`], { env })).code === 0) await g(['checkout', '-q', '-B', branch, `origin/${branch}`])
          else await g(['checkout', '-q', '--orphan', branch])
          await g(['clean', '-qfd'])
          const made: { request: string; commit: string; records: number }[] = [], unchanged: string[] = []
          for (const t of targets) {
            const c = collected.get(t.request)!
            const n = this.write(t, c)
            if (!n) { unchanged.push(t.request); continue }
            await g(['add', '--', this.pathOf(t.request), `instances/${this.self}/teamwork/index.md`])
            await g(['commit', '-q', '-m', `Archive teamwork ${t.request} (${t.role}, ${n} new records)`, '-m', `Teamwork-Horizon: ${this.self} ${t.request} r${c.horizon.records} j${c.horizon.journal} ${Object.entries(c.horizon.runs).map(([u, s]) => `${u}@${s}`).join(' ')}`])
            made.push({ request: t.request, commit: (await g(['rev-parse', 'HEAD'])).trim(), records: n })
          }
          if (made.length) {
            const p = await git(this.dir, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { env, timeoutMs: 180_000 })
            if (p.code !== 0) {
              if (round < 3 && /non-fast-forward|fetch first|rejected/.test(p.stderr)) continue
              throw new Error(`push failed: ${p.stderr.trim() || p.stdout.trim()}`)
            }
            // A diagnostic (wfe teamwork archive --interrupt-after-push): the
            // push happened, the bookkeeping below does not.
            if (o.interruptAfterPush) throw new Error('interrupted after the push (diagnostic): bookkeeping not recorded')
          }
          for (const t of [...made.map(m => m.request), ...unchanged]) {
            const m = this.published(t)
            if (!m) continue
            const commit = (await g(['log', '-1', '--format=%H', '--', `${this.pathOf(t)}/manifest.json`])).trim()
            this.save(t, { state: 'current', commit, records: m.horizon.records, horizon: m.horizon, at: m.exports.at(-1)?.at ?? null, error: null, tries: 0, destination: origin.destination })
          }
          return { published: made, unchanged, failed: [] }
        }
      } catch (e) {
        const error = (e as Error).message
        for (const t of targets) this.save(t.request, { state: 'failed', error, tries: (this.states()[t.request]?.tries ?? 0) + 1 })
        return { published: [], unchanged: [], failed: targets.map(t => ({ request: t.request, error })) }
      }
    }, { timeoutMs: 120_000, what: 'the teamwork archive' })
  }

  private async branch(env: Record<string, string>): Promise<string> {
    const h = await git(this.dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { env })
    return h.code === 0 && h.stdout.trim() ? h.stdout.trim().replace(/^origin\//, '') : 'main'
  }

  published(request: string): TeamManifest | null {
    try { return JSON.parse(readFileSync(join(this.dir, this.pathOf(request), 'manifest.json'), 'utf8')) as TeamManifest } catch { return null }
  }
  publishedIds(request: string): Set<string> {
    const ids = new Set<string>()
    let text = ''
    try { text = readFileSync(join(this.dir, this.pathOf(request), 'transcript.jsonl'), 'utf8') } catch { return ids }
    for (const line of text.split('\n')) if (line.trim()) { try { ids.add((JSON.parse(line) as { id: string }).id) } catch { /* a torn line is not an id */ } }
    return ids
  }

  // Appends what the published transcript lacks; 0 when nothing is new.
  private write(t: TeamRequest, c: Awaited<ReturnType<TeamworkArchive['collect']>>): number {
    const path = join(this.dir, this.pathOf(t.request))
    const have = this.publishedIds(t.request)
    const fresh = c.records.filter(r => !have.has(r.id))
    const prev = this.published(t.request)
    if (!fresh.length) return 0
    mkdirSync(join(path, 'derived'), { recursive: true })
    appendFileSync(join(path, 'transcript.jsonl'), fresh.map(r => JSON.stringify(r)).join('\n') + '\n')
    const all = readFileSync(join(path, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TeamRecord)
    const manifest = this.manifestOf(t, c, all.length, prev, fresh.length)
    writeFileSync(join(path, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
    writeFileSync(join(path, 'transcript.md'), readable(manifest, all))
    if (!existsSync(join(path, 'derived', 'README.md'))) writeFileSync(join(path, 'derived', 'README.md'), DERIVED_README)
    this.writeIndex()
    return fresh.length
  }

  private manifestOf(t: TeamRequest, c: Awaited<ReturnType<TeamworkArchive['collect']>>, total: number, prev: TeamManifest | null, added: number): TeamManifest {
    const main = c.parts[0]
    const d = t.role === 'requester' ? main?.record.delegations?.[t.delegation.split('/').at(-1) ?? ''] : undefined
    const latest = d?.events ? [...d.events].reverse().find(e => e.type === 'completed') : undefined
    const remote = (latest?.manifest as { remote?: Record<string, unknown> } | undefined)?.remote
    const outputs = c.parts.flatMap(p => Object.values(p.record.outputs ?? {}).map(o => ({ run: p.uid, id: o.id, ref: o.ref, digest: o.digest, count: o.count, bytes: o.bytes, title: o.title })))
    const inputs = c.parts.flatMap(p => Object.values(p.record.inputs ?? {}).map(i => ({ run: p.uid, id: i.id, ref: i.ref, digest: i.digest, count: i.count, staging: i.staging })))
    return {
      format: TEAMWORK_FORMAT,
      instance: this.self, request: t.request, role: t.role, peer: t.peer, route: t.route, delegation: t.delegation,
      writer: 'wfe teamwork archive (one writer per installation; this path is written by no one else)',
      runs: c.parts.map(p => ({ uid: p.uid, workspace: p.wsId, project: p.record.project, workflow: p.ref.workflow, run: p.ref.run, seq: p.record.seq, why: p.why, branch: p.record.storage?.branch ?? null, predecessor: p.record.predecessor ? runKey(p.record.predecessor) : null })),
      horizon: { ...c.horizon, records: total },
      counterpart: {
        instance: t.peer,
        run: t.role === 'requester' ? (d?.child?.uid ?? null) : (main?.record.input as { entrustedBy?: { delegation?: string } } | undefined)?.entrustedBy?.delegation ?? t.delegation,
        url: t.role === 'requester' ? (d?.child?.url ?? null) : null,
        result: remote ? { repository: remote.repository ?? null, commit: remote.commit ?? null, outputs: remote.outputs ?? [] } : null,
        archive: `instances/${t.peer}/teamwork/${t.request}/ in ${t.peer}'s own archive repository (its records; not owned or verified here)`,
      },
      outputs, inputs,
      kinds: { utterance: 'words as recorded (request files verified by sha256)', state: 'other run history entries, as recorded', delivery: 'link-store transport facts; duplicates are deliveries, never speech' },
      derived: 'derived/ holds interpretations (summaries, character readings) by runs, each naming the archive commit it read; this writer never writes there and never replaces the transcript',
      exports: [...(prev?.exports ?? []), { at: now(), added, records: total, runs: c.horizon.runs }],
    }
  }

  private writeIndex() {
    const root = join(this.dir, 'instances', this.self, 'teamwork')
    mkdirSync(root, { recursive: true })
    const rows: string[] = []
    for (const t of this.requests()) {
      const m = (() => { try { return JSON.parse(readFileSync(join(root, t.request, 'manifest.json'), 'utf8')) as TeamManifest } catch { return null } })()
      if (!m) continue
      rows.push(`| [${t.request}](${t.request}/transcript.md) | ${m.role} | ${m.peer} | ${m.route} | ${m.runs.map(r => `\`${r.uid}\``).join('<br>')} | ${m.horizon.records} |`)
    }
    writeFileSync(join(root, 'index.md'), `# Teamwork of ${this.self}\n\nPublished by \`wfe teamwork archive\` from this installation's run records and link store (docs/teamwork-archive.md). Each folder: \`manifest.json\`, \`transcript.jsonl\` (append-only original records), \`transcript.md\` (readable view of the same records), \`derived/\` (interpretations, never written by the archive writer).\n\n| Request | Role | Other installation | Route | Runs here | Records |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`)
  }
}

interface Entry { op: string; seq: number; at: string; by: string; via?: string; delegation?: string | { uid: string; answer: number }; uid?: string; question?: string; text?: string; to?: string; from?: string; note?: string; outcome?: string; node?: string; reason?: string; incident?: string; owner?: string; disposition?: string; manifest?: string; receipt?: string; onBehalfOf?: string
  input?: { file?: string; sha256?: string; author?: string; requester?: string; onBehalfOf?: string; source?: unknown }
  request?: { path?: string; sha256?: string }; target?: { instance?: string; project?: string; workflow?: string }
  event?: { type: string; text?: string; question?: string; manifest?: unknown; child?: { seq?: number; at?: string; by?: string } }
  delegation_answer?: number }
export interface TeamManifest {
  format: string; instance: string; request: string; role: string; peer: string; route: string; delegation: string; writer: string
  runs: { uid: string; workspace: string; project: string; workflow: string; run: string; seq: number; why: string; branch: string | null; predecessor: string | null }[]
  horizon: Horizon
  counterpart: { instance: string; run: string | null; url: string | null; result: unknown; archive: string }
  outputs: unknown[]; inputs: unknown[]; kinds: Record<string, string>; derived: string
  exports: { at: string; added: number; records: number; runs: Record<string, number> }[]
}

const order = (r: TeamRecord) => (r.type === 'utterance' ? 0 : r.type === 'state' ? 1 : 2)
function covers(a: Horizon | null, b: Horizon): boolean {
  if (!a) return false
  return a.journal >= b.journal && Object.entries(b.runs).every(([u, s]) => (a.runs[u] ?? -1) >= s)
}

const DERIVED_README = `# Derived interpretations

Summaries, translations or character readings of this request's transcript go here, written by runs
(never by the archive writer). Each file names the archive commit and transcript records it read and the
run that produced it. The original words are \`../transcript.jsonl\`; nothing here replaces them.
`

// The readable view: the same records, in their order, original words
// verbatim, kinds visible. Regenerated from transcript.jsonl.
export function readable(m: TeamManifest, recs: TeamRecord[]): string {
  const L: string[] = []
  L.push(`# Teamwork ${m.request} — ${m.instance} as ${m.role}`, '')
  L.push(`Format \`${m.format}\`. The other installation: \`${m.peer}\` (route ${m.route}). Delegation \`${m.delegation}\`.`)
  L.push(`Runs here: ${m.runs.map(r => `\`${r.uid}\` (${r.why}; seq ${r.seq})`).join('; ')}.`)
  if (m.counterpart.run) L.push(`Counterpart run: \`${m.counterpart.run}\`${m.counterpart.url ? ` (${m.counterpart.url})` : ''}; its own records: ${m.counterpart.archive}.`)
  const res = m.counterpart.result as { repository?: string; commit?: string } | null
  if (res?.commit) L.push(`Result named by the counterpart: ${res.repository} @ \`${res.commit}\`.`)
  L.push('', 'Original words are quoted exactly as recorded (`> `). **State** lines are recorded transitions; **delivery** lines are transport facts — a duplicate arrival is a delivery, not another message. Interpretations live in `derived/`, never here.', '')
  L.push('| Time (recorded here) | Kind | Who | What |', '| --- | --- | --- | --- |')
  const words: TeamRecord[] = []
  for (const r of recs) {
    const who = String(r.author ?? r.by ?? (r.from ? `from ${r.from}` : r.to ? `to ${r.to}` : ''))
    if (r.type === 'utterance') {
      words.push(r)
      const origin = r.origin as { instance?: string; seq?: number; at?: string } | undefined
      L.push(`| ${r.at} | **${r.kind}**${r.direction ? ` (${r.direction})` : ''} | ${who}${origin ? ` @ ${origin.instance} seq ${origin.seq} (${origin.at})` : ''} | [${String(r.id).split(':').slice(-1)[0]}](#${anchor(r.id)}) ${short(String(r.text ?? r.problem ?? ''))} |`)
    } else if (r.type === 'state') {
      const h = r.recorded as Entry
      L.push(`| ${r.at} | state | ${who} | \`${h.op}\` ${(r.source as { workflow: string; run: string }).workflow}/${(r.source as { run: string }).run} seq ${h.seq}${h.node ? ` node ${h.node}` : ''}${h.disposition ? ` ${h.disposition}` : ''} |`)
    } else {
      L.push(`| ${r.at} | delivery | ${who} | ${r.route ?? ''} ${r.direction ?? ''} ${String(r.logical ?? r.messageType ?? r.fact ?? '')}${r.message ? ` (post ${r.message})` : ''}${r.attempt !== undefined ? ` attempt ${r.attempt}` : ''}: ${r.outcome ?? ''}${r.note ? ` — ${short(String(r.note), 80)}` : ''} |`)
    }
  }
  L.push('', '## Words, in full', '')
  for (const r of words) {
    L.push(`### <a id="${anchor(r.id)}"></a>${r.kind}${r.direction ? ` (${r.direction})` : ''} — ${r.author ?? r.by} — ${r.at}`, '')
    L.push(`Source \`${r.id}\`${r.relation ? `; relation ${JSON.stringify(r.relation)}` : ''}${r.sha256 ? `; file \`${r.file}\` sha256 \`${String(r.sha256).slice(0, 16)}…\`` : ''}${r.origin ? `; said at ${JSON.stringify(r.origin)}, recorded here ${r.receivedAt}` : ''}`, '')
    if (r.text) L.push(...String(r.text).split('\n').map(x => `> ${x}`), '')
    else L.push(`_(not exported: ${r.problem ?? 'no text recorded'})_`, '')
  }
  return L.join('\n') + '\n'
}
const anchor = (id: string) => id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
const short = (s: string, n = 140) => { const one = s.replace(/\s+/g, ' ').replace(/\|/g, '\\|'); return one.length > n ? one.slice(0, n) + '…' : one }
