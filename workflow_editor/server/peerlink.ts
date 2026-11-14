// Cross-installation delegation (improve_multinodes p1/p2, docs/peers.md): the
// link store of this installation and what its posts mean here.
//
// Both sides run the same code. The requesting side (A) turns a remote
// delegation's dispatch into a request message and records what the other
// installation answers (acceptance, refusal, the child's facts) on the
// delegating run with the existing operations, so its continuation is the
// ordinary one. The receiving side (B) turns an authorized request into an
// ordinary run of its own (found again by its receipt), tells the
// acceptance, and relays the run's facts from its own record.
//
// p2: A's answers, instructions and corrections (recorded on its run, which
// is the send intent) and its cancellations (recorded here) go to B's run as
// operations; B applies each through the operation a local delivery uses and
// answers with a receipt. Messages that expect an answer are retried with
// their stable id; A asks B for its run's state and B replays the facts A
// lacks from the messages it sent then. A post whose prerequisite has not
// arrived waits instead of failing.
//
// Nothing here reads the other installation's files or stores. Delivery is
// at-least-once (a lost acknowledgment repeats a post); every application is
// idempotent by a stable identity: the request id, the run's receipt, the
// bind receipt, each fact's relay receipt and each operation's id.
//
// <area>/peers.json is the configuration (host-specific, outside Git);
// <area>/.local/peerlink/peerlink.sqlite the journal: posts received, the
// outbox, the requests in each direction, operations, what each peer speaks
// and the observations of remote runs. The run records stay the authority.
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalJson } from '../shared/canonical.ts'
import { childFacts, EVENT_TYPES, isOpenDelegation, latestResult, WAKING, type Delegation, type ResultManifest } from '../shared/delegation.ts'
import {
  authorizeHttp, CAPABILITIES, envelope, isManageType, MANAGE_ID, MANAGE_TYPES, factId, LINK_REQUEST, parseEnvelope, parsePeerConfig, peerOf, requestIdOf, sha256, storedPostEnvelope, tokenFingerprint, tokenHash, tokenParts, tokenPrefix,
  type CancelBody, type CredentialScope, type Envelope, type Operation, type OperationKind, type PeerConfig, type PeerEntry, type PeerRoute, type ReceiptBody, type RequestBody, type RunSnapshot, type StateBody,
} from '../shared/peers.ts'
import { openCorrections, questionState, runKey, type RunRecord, type RunRef } from '../shared/run.ts'
import { uidOf, type DelegateStore } from './delegate.ts'
import type { ExecStore } from './exec.ts'
import { git } from './git.ts'
import { creationOf } from './observe.ts'
import { loadRegistry, recordedWorkspace } from './registry.ts'
import { createRunInCopy, findRunByReceipt, readRun, runOp } from './runs.ts'
import { runSpace } from './runspace.ts'
import { named, openStore, transaction } from './sqlite.ts'
import { RequestError, Workspace } from './workspace.ts'
import { localIdentity, Management } from './peermanage.ts'
import { editorBase } from './site.ts'

// The bound of one logical message (its envelope as sent); nothing is
// truncated or split: what does not fit is refused (or named as a problem).
export const MAX_MESSAGE = 9500
// Reconciliation (docs/peers.md, Reconciliation).
export const RETRY_FIRST_MS = 60_000
export const RETRY_MAX_MS = 30 * 60_000
export const REPOSTS_PER_PASS = 10
export const QUERY_OPEN_MS = 5 * 60_000
export const QUERY_CLOSED_MS = 30 * 60_000
export const STALE_MS = 15 * 60_000
export const WAITING_PROBLEM_MS = 60 * 60_000
export const REPLAYS_PER_QUERY = 20
const EXPECTS_ANSWER = new Set(['request', 'answer', 'instruction', 'correction', 'cancel', 'update'])
export const backoff = (reposts: number) => Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, reposts), RETRY_MAX_MS)
// HTTP delivery (cluster_teamwork p2, docs/peers.md "HTTP delivery"). The
// logical message keeps MAX_MESSAGE on both routes; the body bound is bytes.
export const HTTP_BODY_MAX = 64 * 1024
export const HTTP_TIMEOUT_MS = 15_000
export const HTTP_PER_PEER_PASS = 20
export const httpBackoff = (attempts: number) => Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000)
// The settle pass (process) is run by the service's HTTP loop (and `wfe
// peer process`); one at a time, by this lease.
export const LEASE_MS = 10 * 60_000
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
// Where this installation keeps the tokens other installations issued to it.
// cluster_teamwork p4: a management-scope token beside it (`<instance>.manage.token`).
export const credentialFile = (area: string, peer: PeerEntry, scope: CredentialScope = 'work') => {
  const named = scope === 'manage' ? peer.manageCredential : peer.credential
  return named ? (isAbsolute(named) ? named : join(area, named)) : join(area, '.local', 'peerlink', 'credentials', `${peer.instance}${scope === 'manage' ? '.manage' : ''}.token`)
}
export function readCredential(area: string, peer: PeerEntry, scope: CredentialScope = 'work'): string | null {
  try { const t = readFileSync(credentialFile(area, peer, scope), 'utf8').trim(); return t || null } catch { return null }
}
// The scope a message travels under: management types and ids need the management credential.
export const scopeOf = (type: string, request: string): CredentialScope => isManageType(type) || MANAGE_ID.test(request) ? 'manage' : 'work'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function selfInstance(area: string): string | null {
  try { return (JSON.parse(readFileSync(join(area, 'instance.json'), 'utf8')) as { id?: string }).id ?? null } catch { return null }
}

export function loadPeerConfig(area: string): { config: PeerConfig } | { disabled: string } | { problems: string[] } {
  const file = join(area, 'peers.json')
  if (!existsSync(file)) return { disabled: `no ${file}: this installation has no peers (docs/peers.md)` }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return { problems: [`${file}: ${(e as Error).message}`] } }
  const r = parsePeerConfig(raw, selfInstance(area))
  if ('problems' in r) return { problems: r.problems.map(p => `${file}: ${p}`) }
  if (!r.config.viewBase) r.config.viewBase = editorBase(area)
  return r
}

export function needPeerConfig(area: string): PeerConfig {
  const c = loadPeerConfig(area)
  if ('disabled' in c) throw new RequestError(409, c.disabled, { code: 'peer-config' })
  if ('problems' in c) throw new RequestError(409, c.problems.join('; '), { code: 'peer-config' })
  return c.config
}

// A post the retired Zulip link stored (table `inbox`): history, read only.
export interface InboxRow { realm: string; message: number; stream: number; sender: number; sender_name: string; topic: string; content: string; ts: number; state: 'received' | 'done' | 'ignored' | 'failed' | 'waiting'; type: string | null; request: string | null; envelope: string | null; note: string | null; attempts: number; received: string; updated: string; waiting_since: string | null }
// p2 (cluster_teamwork): `route` is how the row travels; an HTTP row's
// `content` is the envelope's JSON, `receipt` the receiver's durable receipt,
// `retry_at` its transport backoff; `refused` an HTTP refusal not retried
// (conflict, invalid, misaddressed).
export interface OutboxRow { id: string; peer: string; request: string; type: string; topic: string; content: string; payload: string; state: 'ready' | 'sent' | 'failed' | 'oversize' | 'refused'; message: number | null; attempts: number; error: string | null; created: string; sent: string | null; expects: number; answered: string | null; next_retry: string | null; reposts: number; route: PeerRoute; receipt: string | null; retry_at: string | null }
export interface OutboundRow { request: string; peer: string; delegation: string; parent_ws: string; parent_workflow: string; parent_run: string; d: string; target: string; state: 'requested' | 'accepted' | 'declined'; remote_run: string | null; remote_url: string | null; problem: string | null; updated: string; observed: string | null; observed_at: string | null; heard: string | null; verified: number; queries: number; query_at: string | null; route: PeerRoute }
export interface InboundRow { request: string; peer: string; payload: string; delegation: string; project: string; workflow: string; workspace: string | null; run_workflow: string | null; run: string | null; run_uid: string | null; state: 'received' | 'accepted' | 'declined' | 'conflict' | 'cancelled'; relayed: number; problem: string | null; message: number | null; topic: string; updated: string; route: PeerRoute; delivery: string | null }
// An envelope another installation delivered over HTTP, by the credential's
// holder and the envelope id; `deliveries` counts its arrivals.
export interface HInboxRow { peer: string; id: string; payload: string; type: string; request: string; envelope: string; state: InboxRow['state']; note: string | null; attempts: number; deliveries: number; received: string; updated: string; waiting_since: string | null; credential: string | null }
export interface HttpReceipt { peer: string; id: string; type: string; request: string; payload: string; received: string; deliveries: number; state: string; note: string | null }
// Where an envelope came from: an HTTP delivery.
export type Delivery = { prior: InboxRow['state']; route: 'http'; peer: string; id: string; at: string; envelope: unknown; credential?: string | null }
// An operation in either direction: `out` = this side asked it (its
// outcome as the other side's receipt said), `in` = this side applied it.
export interface OpRow { id: string; dir: 'out' | 'in'; request: string; kind: OperationKind; payload: string; body: string; state: 'queued' | 'applied' | 'requested' | 'refused'; code: string | null; reason: string | null; seq: number | null; message: number | null; created: string; updated: string }
// Facts of a remote run this side knows but did not record as facts on the
// delegating run: an older completion (`superseded`), one arriving after
// the delegation closed (`closed`), one the other side could not carry
// (`oversize`). With the run's own receipts they are what this side `has`.
export interface FactRow { request: string; fact: string; receipt: string; state: 'superseded' | 'closed' | 'oversize'; note: string | null; at: string }

// `lifecycle`: this installation's lifecycle folder (AGDEV_LIFECYCLE of the services; p3, docs/management.md).
export interface PeerContext { area: string; registryFile: string; exec: ExecStore; clock?: () => number; lifecycle?: string | null }
type Applied = { state: InboxRow['state']; note: string }

export class PeerStore {
  readonly db: DatabaseSync
  readonly ctx: PeerContext
  constructor(ctx: PeerContext) {
    this.ctx = ctx
    const dir = join(ctx.area, '.local', 'peerlink')
    mkdirSync(dir, { recursive: true })
    this.db = openStore('peer link store', join(dir, 'peerlink.sqlite'), [{
      version: 1,
      up: db => db.exec(`
        CREATE TABLE cursor (realm TEXT NOT NULL, stream INTEGER NOT NULL, through INTEGER NOT NULL, PRIMARY KEY (realm, stream));
        CREATE TABLE inbox (realm TEXT NOT NULL, message INTEGER NOT NULL, stream INTEGER NOT NULL, sender INTEGER NOT NULL, sender_name TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL,
          state TEXT NOT NULL, type TEXT, request TEXT, envelope TEXT, note TEXT, attempts INTEGER NOT NULL DEFAULT 0, received TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (realm, message));
        CREATE INDEX inbox_state ON inbox (state);
        CREATE TABLE outbox (id TEXT PRIMARY KEY, peer TEXT NOT NULL, request TEXT NOT NULL, type TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL, payload TEXT NOT NULL,
          state TEXT NOT NULL, message INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created TEXT NOT NULL, sent TEXT);
        CREATE INDEX outbox_state ON outbox (state);
        CREATE TABLE outbound (request TEXT PRIMARY KEY, peer TEXT NOT NULL, delegation TEXT NOT NULL UNIQUE, parent_ws TEXT NOT NULL, parent_workflow TEXT NOT NULL, parent_run TEXT NOT NULL, d TEXT NOT NULL, target TEXT NOT NULL,
          state TEXT NOT NULL, remote_run TEXT, remote_url TEXT, problem TEXT, updated TEXT NOT NULL);
        CREATE TABLE inbound (request TEXT PRIMARY KEY, peer TEXT NOT NULL, payload TEXT NOT NULL, delegation TEXT NOT NULL, project TEXT NOT NULL, workflow TEXT NOT NULL, workspace TEXT, run_workflow TEXT, run TEXT, run_uid TEXT,
          state TEXT NOT NULL, relayed INTEGER NOT NULL DEFAULT 0, problem TEXT, message INTEGER NOT NULL, topic TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE transport (id INTEGER PRIMARY KEY CHECK (id = 1), ok INTEGER NOT NULL, at TEXT NOT NULL, error TEXT, detail TEXT);
      `),
    }, {
      // p2: what expects an answer and its retries, operations, what each
      // peer speaks, facts kept outside the run record, observations.
      version: 2,
      up: db => db.exec(`
        ALTER TABLE inbox ADD COLUMN waiting_since TEXT;
        ALTER TABLE outbox ADD COLUMN expects INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE outbox ADD COLUMN answered TEXT;
        ALTER TABLE outbox ADD COLUMN next_retry TEXT;
        ALTER TABLE outbox ADD COLUMN reposts INTEGER NOT NULL DEFAULT 0;
        UPDATE outbox SET expects = 1, answered = (SELECT o.updated FROM outbound o WHERE o.request = outbox.request AND o.state != 'requested') WHERE type = 'request';
        ALTER TABLE outbound ADD COLUMN observed TEXT;
        ALTER TABLE outbound ADD COLUMN observed_at TEXT;
        ALTER TABLE outbound ADD COLUMN heard TEXT;
        ALTER TABLE outbound ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE outbound ADD COLUMN queries INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE outbound ADD COLUMN query_at TEXT;
        CREATE TABLE peers (instance TEXT PRIMARY KEY, capabilities TEXT NOT NULL, seen TEXT NOT NULL, message INTEGER);
        CREATE TABLE ops (id TEXT NOT NULL, dir TEXT NOT NULL, request TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
          code TEXT, reason TEXT, seq INTEGER, message INTEGER, created TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (id, dir));
        CREATE TABLE facts (request TEXT NOT NULL, fact TEXT NOT NULL, receipt TEXT NOT NULL, state TEXT NOT NULL, note TEXT, at TEXT NOT NULL, PRIMARY KEY (request, fact));
        CREATE TABLE announced (id INTEGER PRIMARY KEY CHECK (id = 1), capabilities TEXT NOT NULL, at TEXT NOT NULL);
      `),
    }, {
      // p3 (docs/management.md): the relation each peer told, management
      // operations in both directions, observations of managed installations.
      version: 3,
      up: db => db.exec(`
        ALTER TABLE peers ADD COLUMN relation TEXT;
        ALTER TABLE peers ADD COLUMN relation_seen TEXT;
        CREATE TABLE mops (id TEXT NOT NULL, dir TEXT NOT NULL, peer TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER, payload TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
          code TEXT, reason TEXT, lifecycle TEXT, status TEXT, told INTEGER NOT NULL DEFAULT 0, message INTEGER, created TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (id, dir));
        CREATE INDEX mops_peer ON mops (peer, dir, kind);
        CREATE TABLE observations (peer TEXT PRIMARY KEY, query TEXT, body TEXT, received TEXT, asks INTEGER NOT NULL DEFAULT 0, asked TEXT);
      `),
    }, {
      // p4 (docs/management.md, Display identity): how each peer last named
      // itself in a hello, and when that was received.
      version: 4,
      up: db => db.exec(`
        ALTER TABLE peers ADD COLUMN identity TEXT;
        ALTER TABLE peers ADD COLUMN identity_seen TEXT;
      `),
    }, {
      // cluster_teamwork p2 (HTTP delivery): routes frozen per request,
      // HTTP deliveries and their provenance, issued credentials, the settle
      // lease, HTTP transport results per peer. inbound.message becomes
      // nullable (an HTTP request has no Zulip message); every row is kept.
      version: 5,
      up: db => db.exec(`
        CREATE TABLE inbound_v5 (request TEXT PRIMARY KEY, peer TEXT NOT NULL, payload TEXT NOT NULL, delegation TEXT NOT NULL, project TEXT NOT NULL, workflow TEXT NOT NULL, workspace TEXT, run_workflow TEXT, run TEXT, run_uid TEXT,
          state TEXT NOT NULL, relayed INTEGER NOT NULL DEFAULT 0, problem TEXT, message INTEGER, topic TEXT NOT NULL, updated TEXT NOT NULL, route TEXT NOT NULL DEFAULT 'zulip', delivery TEXT);
        INSERT INTO inbound_v5 (request, peer, payload, delegation, project, workflow, workspace, run_workflow, run, run_uid, state, relayed, problem, message, topic, updated)
          SELECT request, peer, payload, delegation, project, workflow, workspace, run_workflow, run, run_uid, state, relayed, problem, message, topic, updated FROM inbound;
        DROP TABLE inbound;
        ALTER TABLE inbound_v5 RENAME TO inbound;
        ALTER TABLE outbound ADD COLUMN route TEXT NOT NULL DEFAULT 'zulip';
        ALTER TABLE outbox ADD COLUMN route TEXT NOT NULL DEFAULT 'zulip';
        ALTER TABLE outbox ADD COLUMN receipt TEXT;
        ALTER TABLE outbox ADD COLUMN retry_at TEXT;
        CREATE INDEX outbox_route ON outbox (route, state);
        CREATE TABLE hinbox (peer TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, type TEXT NOT NULL, request TEXT NOT NULL, envelope TEXT NOT NULL, state TEXT NOT NULL, note TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, deliveries INTEGER NOT NULL DEFAULT 1, received TEXT NOT NULL, updated TEXT NOT NULL, waiting_since TEXT, PRIMARY KEY (peer, id));
        CREATE INDEX hinbox_state ON hinbox (state);
        CREATE TABLE hdeliveries (peer TEXT NOT NULL, id TEXT NOT NULL, n INTEGER NOT NULL, at TEXT NOT NULL, addr TEXT, outcome TEXT NOT NULL, PRIMARY KEY (peer, id, n));
        CREATE TABLE credentials (id TEXT PRIMARY KEY, peer TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, issued TEXT NOT NULL, by TEXT NOT NULL, revoked TEXT, revoked_by TEXT, used TEXT);
        CREATE TABLE lease (name TEXT PRIMARY KEY, holder TEXT NOT NULL, until TEXT NOT NULL);
        CREATE TABLE htransport (peer TEXT PRIMARY KEY, ok INTEGER NOT NULL, at TEXT NOT NULL, error TEXT, sent INTEGER NOT NULL DEFAULT 0);
      `),
    }, {
      // cluster_teamwork p4 (management over HTTP): each credential's scope
      // (every existing one stays work-only), the credential an HTTP delivery
      // arrived with, the route each management operation and observation
      // was started on (existing ones: Zulip).
      version: 6,
      up: db => db.exec(`
        ALTER TABLE credentials ADD COLUMN scope TEXT NOT NULL DEFAULT 'work';
        ALTER TABLE hinbox ADD COLUMN credential TEXT;
        ALTER TABLE mops ADD COLUMN route TEXT NOT NULL DEFAULT 'zulip';
        ALTER TABLE observations ADD COLUMN route TEXT NOT NULL DEFAULT 'zulip';
      `),
    }])
    this.manage = new Management(this)
  }
  readonly manage: Management
  close() { this.db.close() }
  all<T>(sql: string, ...a: (string | number | null)[]): T[] { return named('peer link store', 'a read', () => this.db.prepare(sql).all(...a) as T[]) }
  one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return this.all<T>(sql, ...a)[0] }
  run(sql: string, ...a: (string | number | null)[]) { return named('peer link store', 'a write', () => this.db.prepare(sql).run(...a)) }
  tx<T>(f: () => T): T { return transaction(this.db, f, 'peer link store') }
  get delegate(): DelegateStore { return this.ctx.exec.delegate }
  ms() { return this.ctx.clock?.() ?? Date.now() }
  now() { return new Date(this.ms()).toISOString() }

  // ---- HTTP delivery (cluster_teamwork p2, docs/peers.md "HTTP delivery") ----------------------

  // The receiver's side: one envelope, authenticated by its bearer credential,
  // checked for shape and address, then stored — nothing is applied here (the
  // settle pass applies it). Same (holder, id) and payload: the stored receipt,
  // and the delivery is settled again (its application is idempotent and
  // tells its answer again). Same id, other payload: a conflict; nothing changes.
  verifyBearer(header: string | undefined): { peer: string; credential: string; scope: CredentialScope } {
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
    if (!m) throw new RequestError(401, 'an agdev peer delivery needs Authorization: Bearer <the credential this installation issued>', { code: 'peer-auth' })
    const row = this.one<{ id: string; peer: string; revoked: string | null; scope: CredentialScope }>('SELECT id, peer, revoked, scope FROM credentials WHERE hash = ?', tokenHash(m[1]))
    if (!row || row.revoked) throw new RequestError(401, row ? `credential ${row.id} was revoked` : 'the credential is not one this installation issued', { code: 'peer-auth' })
    this.run('UPDATE credentials SET used = ? WHERE id = ?', this.now(), row.id)
    return { peer: row.peer, credential: row.id, scope: row.scope === 'manage' ? 'manage' : 'work' }
  }
  // p4: what a management envelope from `peer` may be, before it is stored —
  // the relationship this side configured and, for a reply, the operation or
  // query it answers. Reachability and a credential alone grant nothing.
  private manageIngress(peer: PeerEntry, e: Envelope): string | null {
    switch (e.type) {
      case 'update': return peer.parentage === 'parent' && peer.grant.includes('update') ? null : `${peer.label} may not update this installation (${peer.parentage === 'parent' ? 'no update grant' : 'it is not this installation\'s operational parent'})`
      case 'observe': return peer.grant.length ? null : `this installation grants ${peer.label} nothing to observe`
      case 'update-receipt': case 'update-status': {
        if (!peer.manage.length) return `this installation does not manage ${peer.label}; it asked nothing to be answered`
        const op = this.one<{ peer: string }>('SELECT peer FROM mops WHERE id = ? AND dir = \'out\'', e.body.op)
        return op?.peer === peer.instance ? null : `${e.body.op} is not an operation this installation asked of ${peer.label}`
      }
      case 'installation': {
        if (!peer.manage.length) return `this installation does not manage ${peer.label}; it asked no observation`
        const q = this.one<{ peer: string }>('SELECT peer FROM outbox WHERE id = ?', e.body.query)
        return q?.peer === peer.instance ? null : `${e.body.query} is not an observation this installation asked of ${peer.label}`
      }
      default: return `${e.type} is not a management message`
    }
  }
  receiveHttp(holder: string, raw: unknown, addr: string | null, auth: { credential?: string; scope?: CredentialScope } = {}): { status: 200 | 202; receipt: HttpReceipt; duplicate: boolean } {
    const scope = auth.scope ?? 'work'
    const c = loadPeerConfig(this.ctx.area)
    if (!('config' in c)) throw new RequestError(503, 'disabled' in c ? c.disabled : c.problems.join('; '), { code: 'peer-config' })
    const cfg = c.config
    if (!peerOf(cfg, holder)) throw new RequestError(403, `${holder} holds a credential of this installation but is not a configured peer (peers.json)`, { code: 'peer-identity' })
    const parsed = parseEnvelope(raw)
    if ('problem' in parsed) throw new RequestError(400, `not an agdev envelope: ${parsed.problem}`, { code: 'peer-envelope' })
    const e = parsed.envelope
    if (e.from !== holder) throw new RequestError(403, `the credential is ${holder}'s; the envelope claims to be from ${e.from}`, { code: 'peer-identity' })
    if (e.to !== cfg.self) throw new RequestError(403, `addressed to ${e.to}; this installation is ${cfg.self}`, { code: 'misaddressed' })
    // cluster_teamwork p3/p4: a work credential grants no management, a
    // management credential no work; management is also checked against
    // this side's relationship and the operation it answers. Refused before
    // anything is stored.
    const manage = isManageType(e.type) || MANAGE_ID.test(e.request)
    if (manage && scope !== 'manage') throw new RequestError(403, `${e.type} ${e.request} is management; a work credential does not carry it (management stays on its configured route)`, { code: 'peer-scope' })
    if (!manage && scope === 'manage') throw new RequestError(403, `${e.type} ${e.request} is work; a management credential does not carry it`, { code: 'peer-scope' })
    if (manage) {
      const why = this.manageIngress(peerOf(cfg, holder)!, e)
      if (why) throw new RequestError(403, why, { code: 'manage-not-permitted' })
    }
    const conflict = this.one<HInboxRow>('SELECT * FROM hinbox WHERE peer = ? AND id = ? AND payload != ?', holder, e.id, e.payload)
    if (conflict) {
      // Kept as provenance (not as a delivery number: the stored one stands).
      this.run('INSERT OR IGNORE INTO hdeliveries (peer, id, n, at, addr, outcome) VALUES (?, ?, ?, ?, ?, ?)', holder, e.id, -Date.now(), this.now(), addr, `conflict: payload ${e.payload}`)
      throw new RequestError(409, `${e.id} was received from ${holder} with payload ${conflict.payload}; this delivery carries ${e.payload}. Nothing was changed`, { code: 'peer-conflict', receipt: this.httpReceipt(conflict) })
    }
    return this.tx(() => {
      const prior = this.one<HInboxRow>('SELECT * FROM hinbox WHERE peer = ? AND id = ?', holder, e.id)
      if (prior && prior.payload !== e.payload) throw new RequestError(409, `${e.id}: a conflicting delivery raced this one; nothing was changed`, { code: 'peer-conflict', receipt: this.httpReceipt(prior) })
      if (prior) {
        // A repeated delivery: settled again, so a lost answer is told again.
        this.run('UPDATE hinbox SET deliveries = deliveries + 1, state = CASE WHEN state IN (\'done\', \'ignored\') THEN \'received\' ELSE state END, updated = ? WHERE peer = ? AND id = ?', this.now(), holder, e.id)
        this.run('INSERT INTO hdeliveries (peer, id, n, at, addr, outcome) VALUES (?, ?, ?, ?, ?, ?)', holder, e.id, prior.deliveries + 1, this.now(), addr, 'duplicate')
        return { status: 200 as const, receipt: this.httpReceipt(this.one<HInboxRow>('SELECT * FROM hinbox WHERE peer = ? AND id = ?', holder, e.id)!), duplicate: true }
      }
      this.run('INSERT INTO hinbox (peer, id, payload, type, request, envelope, state, received, updated, credential) VALUES (?, ?, ?, ?, ?, ?, \'received\', ?, ?, ?)', holder, e.id, e.payload, e.type, e.request, JSON.stringify(e), this.now(), this.now(), auth.credential ?? null)
      this.run('INSERT INTO hdeliveries (peer, id, n, at, addr, outcome) VALUES (?, ?, 1, ?, ?, ?)', holder, e.id, this.now(), addr, 'stored')
      return { status: 202 as const, receipt: this.httpReceipt(this.one<HInboxRow>('SELECT * FROM hinbox WHERE peer = ? AND id = ?', holder, e.id)!), duplicate: false }
    })
  }
  httpReceipt(r: HInboxRow): HttpReceipt { return { peer: r.peer, id: r.id, type: r.type, request: r.request, payload: r.payload, received: r.received, deliveries: r.deliveries, state: r.state, note: r.note } }
  receiptFor(holder: string, id: string): HttpReceipt | null {
    const r = this.one<HInboxRow>('SELECT * FROM hinbox WHERE peer = ? AND id = ?', holder, id)
    return r ? this.httpReceipt(r) : null
  }
  pendingHttp(): number { return this.one<{ n: number }>('SELECT count(*) AS n FROM hinbox WHERE state IN (\'received\', \'failed\')')!.n }

  // ---- credentials -----------------------------------------------------------------------------
  // This installation issues one bearer token per holder installation and
  // keeps only its sha256; the token goes to the holder's file. Revocation
  // refuses new deliveries; work already accepted is cancelled only explicitly.
  // p4: `scope` manage — the holder may send only the management messages its
  // relationship with this installation allows (manageIngress), nothing else.
  issueCredential(cfg: PeerConfig, holder: string, by: string, scope: CredentialScope = 'work'): { id: string; token: string; fingerprint: string; scope: CredentialScope } {
    const peer = peerOf(cfg, holder)
    if (!peer) throw new RequestError(409, `${holder} is not a configured peer; register it first (wfe peer set ${holder} --endpoint … --label …)`, { code: 'peer-config' })
    if (scope === 'manage' && !peer.grant.length && !peer.manage.length) throw new RequestError(409, `${peer.label} has no administrative relationship with this installation (grant and manage are empty); a management credential would carry nothing. Nothing was issued`, { code: 'peer-config' })
    const token = `${tokenPrefix(scope)}.${cfg.self}.${holder}.${randomBytes(32).toString('hex')}`
    const id = `c-${tokenFingerprint(token)}`
    this.run('INSERT INTO credentials (id, peer, hash, issued, by, scope) VALUES (?, ?, ?, ?, ?, ?)', id, holder, tokenHash(token), this.now(), by, scope)
    return { id, token, fingerprint: tokenFingerprint(token), scope }
  }
  revokeCredential(which: string, by: string): number {
    return Number(this.run('UPDATE credentials SET revoked = ?, revoked_by = ? WHERE (id = ? OR peer = ?) AND revoked IS NULL', this.now(), by, which, which).changes)
  }
  credentials(): { id: string; peer: string; issued: string; by: string; revoked: string | null; used: string | null; scope: CredentialScope }[] {
    return this.all('SELECT id, peer, issued, by, revoked, used, scope FROM credentials ORDER BY issued')
  }
  static installCredential(area: string, cfg: PeerConfig, issuer: string, token: string): { file: string; fingerprint: string; scope: CredentialScope } {
    const t = token.trim()
    const parts = tokenParts(t)
    if (!parts) throw new RequestError(400, 'not an agdev peer credential (agdev-peer1.<issuer>.<holder>.<hex>)', { code: 'peer-credential' })
    if (parts.issuer !== issuer) throw new RequestError(409, `the credential was issued by ${parts.issuer}, not ${issuer}`, { code: 'peer-credential' })
    if (parts.holder !== cfg.self) throw new RequestError(409, `the credential was issued to ${parts.holder}, not this installation (${cfg.self})`, { code: 'peer-credential' })
    const peer = peerOf(cfg, issuer)
    if (!peer) throw new RequestError(409, `${issuer} is not a configured peer; register it first (wfe peer set ${issuer} --endpoint … --label …)`, { code: 'peer-config' })
    const file = credentialFile(area, peer, parts.scope)
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${t}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
    return { file, fingerprint: tokenFingerprint(t), scope: parts.scope }
  }

  // ---- the sender's side: dispatch (only the service's HTTP loop) ---------------------------------
  // HTTP rows oldest first, at most HTTP_PER_PEER_PASS per peer; a peer that
  // fails is not tried again this pass (its order is kept). 2xx settles the
  // transport only — the answer is still awaited; 401, 5xx and timeouts keep
  // the outcome unknown and retry the same identity with capped backoff;
  // 400, 403 and 409 are refusals, kept visible and not retried.
  async dispatchHttp(cfg: PeerConfig, o: { fetch?: typeof fetch } = {}): Promise<{ sent: number; notes: string[] }> {
    const doFetch = o.fetch ?? fetch
    const rows = this.all<OutboxRow>('SELECT * FROM outbox WHERE route = \'http\' AND state IN (\'ready\', \'failed\') AND (retry_at IS NULL OR retry_at <= ?) ORDER BY created, id LIMIT 200', this.now())
    const per = new Map<string, number>(), down = new Set<string>()
    const notes: string[] = []
    let sent = 0
    for (const row of rows) {
      if (down.has(row.peer) || (per.get(row.peer) ?? 0) >= HTTP_PER_PEER_PASS) continue
      per.set(row.peer, (per.get(row.peer) ?? 0) + 1)
      const peer = peerOf(cfg, row.peer)
      const fail = (error: string, retry: boolean) => {
        this.run('UPDATE outbox SET state = ?, error = ?, attempts = attempts + 1, retry_at = ? WHERE id = ? AND state != \'sent\'', retry ? 'failed' : 'refused', error.slice(0, 500), retry ? new Date(this.ms() + httpBackoff(row.attempts + 1)).toISOString() : null, row.id)
        this.run('INSERT INTO htransport (peer, ok, at, error) VALUES (?, 0, ?, ?) ON CONFLICT (peer) DO UPDATE SET ok = 0, at = excluded.at, error = excluded.error', row.peer, this.now(), error.slice(0, 500))
        if (row.error !== error.slice(0, 500)) notes.push(`${row.id} → ${row.peer}: ${retry ? 'not delivered (retried)' : 'refused (not retried)'} — ${error}`)
      }
      if (!peer?.endpoint) { fail(`no endpoint registered for ${row.peer} (wfe peer set ${row.peer} --endpoint …)`, true); down.add(row.peer); continue }
      const scope = scopeOf(row.type, row.request)
      const token = readCredential(this.ctx.area, peer, scope)
      if (!token) { fail(`no ${scope === 'manage' ? 'management ' : ''}credential from ${peer.label} is installed (${credentialFile(this.ctx.area, peer, scope)}; wfe peer credential install)`, true); continue }
      let res: Response
      try {
        res = await doFetch(`${peer.endpoint.replace(/\/+$/, '')}/peers/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: row.content, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
      } catch (e) { fail(`${peer.endpoint}: ${(e as Error).name === 'TimeoutError' ? `no answer within ${HTTP_TIMEOUT_MS / 1000} s` : (e as Error).message} (outcome unknown)`, true); down.add(row.peer); continue }
      const text = await res.text().catch(() => '')
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
      if (res.status === 200 || res.status === 202) {
        const next = row.expects && !row.answered ? new Date(this.ms() + backoff(row.reposts)).toISOString() : null
        this.run('UPDATE outbox SET state = \'sent\', message = NULL, receipt = ?, sent = ?, error = NULL, attempts = attempts + 1, retry_at = NULL, next_retry = ? WHERE id = ?', JSON.stringify(body.receipt ?? null), this.now(), next, row.id)
        this.run('INSERT INTO htransport (peer, ok, at, error, sent) VALUES (?, 1, ?, NULL, 1) ON CONFLICT (peer) DO UPDATE SET ok = 1, at = excluded.at, error = NULL, sent = sent + 1', row.peer, this.now())
        sent++
        continue
      }
      const detail = typeof body.error === 'string' ? body.error : text.slice(0, 300)
      const code = isObj(body.detail) && typeof body.detail.code === 'string' ? body.detail.code : ''
      if ([400, 403, 409, 413].includes(res.status)) fail(`HTTP ${res.status}${code ? ` ${code}` : ''}: ${detail}`, false)
      else { fail(`HTTP ${res.status}${code ? ` ${code}` : ''}: ${detail} (outcome unknown)`, true); down.add(row.peer) }
    }
    return { sent, notes }
  }
  readyHttp(): number { return this.one<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE route = \'http\' AND state IN (\'ready\', \'failed\') AND (retry_at IS NULL OR retry_at <= ?)', this.now())!.n }

  // An operator's redelivery (a diagnostic; recovery does not need it):
  // every message of the request this side sent is posted again. The other
  // side applies a repeated message once.
  resend(request: string): number {
    return this.all<{ id: string }>('SELECT id FROM outbox WHERE request = ? AND state = \'sent\'', request).reduce((n, r) => n + this.requeue(r.id), 0)
  }

  // ---- capabilities ------------------------------------------------------------------------

  capabilitiesOf(instance: string): { capabilities: string[]; seen: string | null } {
    const r = this.one<{ capabilities: string; seen: string }>('SELECT capabilities, seen FROM peers WHERE instance = ?', instance)
    return r ? { capabilities: JSON.parse(r.capabilities) as string[], seen: r.seen } : { capabilities: [], seen: null }
  }
  heardCapabilities(instance: string, caps: unknown, message: number | null) {
    if (!Array.isArray(caps) || !caps.every(c => typeof c === 'string')) return
    // A peer whose release changed may have discarded what this side told
    // it before (p3: a relation sent while it still ran a release without
    // management): this side announces itself again on its next pass.
    const before = this.one<{ capabilities: string }>('SELECT capabilities FROM peers WHERE instance = ?', instance)?.capabilities
    if (before !== undefined && before !== JSON.stringify([...new Set(caps as string[])].sort())) this.run('DELETE FROM announced')
    this.run('INSERT INTO peers (instance, capabilities, seen, message) VALUES (?, ?, ?, ?) ON CONFLICT (instance) DO UPDATE SET capabilities = excluded.capabilities, seen = excluded.seen, message = excluded.message', instance, JSON.stringify([...new Set(caps as string[])].sort()), this.now(), message)
  }
  // A local refusal before anything is recorded: the peer has not said it
  // applies this (a P1 installation, or not heard from since its update).
  static needCapability(store: PeerStore, peer: PeerEntry, kind: string) {
    const { capabilities, seen } = store.capabilitiesOf(peer.instance)
    if (!capabilities.includes(kind)) throw new RequestError(409, `${peer.label} (${peer.instance}) has not said it applies ${kind === 'correction' ? 'corrections' : kind === 'cancel' ? 'cancellations' : `${kind}s`} over the agdev link (${seen ? `it speaks ${capabilities.join(', ') || 'peer/1 only'}, as of ${seen}` : 'nothing heard from it since this installation began speaking peer/2'}); nothing was recorded or sent. An installation on a P1 release cannot apply it: answer on that installation, or judge or abandon the delegation here`, { code: 'peer-unsupported' })
  }

  // Tells every configured peer what this installation applies, once per
  // change (and again on `wfe peer hello`).
  // p3: the hello also says how this installation sees each peer (its
  // relation), so it is announced again when peers.json changes it.
  private announce(cfg: PeerConfig, force = false): string[] {
    const identity = localIdentity(this.ctx.area, cfg)
    const bodies = cfg.peers.map(p => ({ p, body: { capabilities: [...CAPABILITIES], relation: this.manage.relationFor(cfg, p), identity } }))
    // p2: the route a peer's hello takes is part of what was announced.
    const key = JSON.stringify(bodies.map(b => [b.p.instance, 'http', b.body]))
    const last = this.one<{ capabilities: string }>('SELECT capabilities FROM announced WHERE id = 1')
    if (!force && last?.capabilities === key) return []
    const notes: string[] = []
    this.tx(() => {
      for (const { p, body } of bodies) {
        const e = envelope('hello', { id: `hello:${sha256(canonicalJson(body)).slice(0, 12)}`, from: cfg.self, to: p.instance, request: LINK_REQUEST, body })
        this.queue({ id: `${e.id}:${p.instance}`, peer: p.instance, request: LINK_REQUEST, type: 'hello', envelope: e }, true)
        notes.push(`hello queued for ${p.label}: ${CAPABILITIES.join(', ')}; relation ${body.relation.you}${body.relation.grants.length ? `, grants ${body.relation.grants.join(', ')}` : ''}${body.relation.manages.length ? `, manages ${body.relation.manages.join(', ')}` : ''}`)
      }
      this.run('INSERT INTO announced (id, capabilities, at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET capabilities = excluded.capabilities, at = excluded.at', key, this.now())
    })
    return notes
  }
  hello(): string[] { return this.announce(needPeerConfig(this.ctx.area), true) }

  // ---- reading -----------------------------------------------------------------------------

  status() {
    const waitingSince = new Date(this.ms() - WAITING_PROBLEM_MS).toISOString()
    return {
      outbox: Object.fromEntries(this.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM outbox WHERE route = \'http\' GROUP BY state').map(r => [r.state, r.n])),
      // cluster_teamwork p5: what the retired Zulip link left in this journal (history, never sent or settled).
      history: {
        posts: Object.fromEntries(this.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM inbox GROUP BY state').map(r => [r.state, r.n])),
        outbox: Object.fromEntries(this.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM outbox WHERE route != \'http\' GROUP BY state').map(r => [r.state, r.n])),
      },
      // p2: HTTP deliveries received, HTTP messages by state, each peer's last HTTP result.
      http: {
        received: Object.fromEntries(this.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM hinbox GROUP BY state').map(r => [r.state, r.n])),
        sent: Object.fromEntries(this.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM outbox WHERE route = \'http\' GROUP BY state').map(r => [r.state, r.n])),
        peers: this.all<{ peer: string; ok: number; at: string; error: string | null; sent: number }>('SELECT * FROM htransport ORDER BY peer'),
        credentials: this.credentials(),
        refused: this.all<Pick<OutboxRow, 'id' | 'peer' | 'error'>>('SELECT id, peer, error FROM outbox WHERE route = \'http\' AND state = \'refused\' ORDER BY created DESC LIMIT 20'),
        lease: this.one<{ holder: string; until: string }>('SELECT holder, until FROM lease WHERE name = \'process\'') ?? null,
      },
      outbound: this.all<OutboundRow>('SELECT * FROM outbound ORDER BY updated DESC LIMIT 50'),
      inbound: this.all<InboundRow>('SELECT * FROM inbound ORDER BY updated DESC LIMIT 50'),
      peers: this.all<{ instance: string; capabilities: string; seen: string }>('SELECT instance, capabilities, seen FROM peers ORDER BY instance').map(r => ({ ...r, capabilities: JSON.parse(r.capabilities) as string[] })),
      awaiting: this.all<Pick<OutboxRow, 'id' | 'type' | 'request' | 'attempts' | 'reposts' | 'next_retry' | 'error' | 'state' | 'route'>>('SELECT id, type, request, attempts, reposts, next_retry, error, state, route FROM outbox WHERE expects = 1 AND answered IS NULL AND route = \'http\' ORDER BY created LIMIT 50'),
      oversize: this.all<Pick<OutboxRow, 'id' | 'request' | 'type'>>('SELECT id, request, type FROM outbox WHERE state = \'oversize\' ORDER BY created LIMIT 20'),
      problems: [
        // A delivery waiting long for its prerequisite is a persistent inconsistency.
        ...this.all<{ message: string; state: string; note: string; type: string; request: string }>('SELECT \'HTTP \' || peer || \' \' || id AS message, state, note, type, request FROM hinbox WHERE (state IN (\'failed\', \'ignored\') AND (note IS NULL OR note NOT LIKE \'own:%\')) OR (state = \'waiting\' AND waiting_since < ?) ORDER BY received DESC LIMIT 20', waitingSince),
      ],
    }
  }
  messages(request?: string): { inbox: InboxRow[]; outbox: OutboxRow[]; http: HInboxRow[] } {
    return request
      ? { inbox: this.all('SELECT * FROM inbox WHERE request = ? ORDER BY message', request), outbox: this.all('SELECT * FROM outbox WHERE request = ? ORDER BY created, id', request), http: this.all('SELECT * FROM hinbox WHERE request = ? ORDER BY received, id', request) }
      : { inbox: this.all('SELECT * FROM inbox ORDER BY message DESC LIMIT 50'), outbox: this.all('SELECT * FROM outbox ORDER BY created DESC LIMIT 50'), http: this.all('SELECT * FROM hinbox ORDER BY received DESC LIMIT 50') }
  }

  // The link's view of one remote delegation, for `wfe delegate show`, the
  // API and the run view: delivery, acceptance, the remote run, operations
  // and their outcomes, what is waiting and the latest observation with its
  // age. What is not confirmed is `unknown`, never success or failure.
  linkOf(d: Delegation, self: string): LinkView {
    const request = requestIdOf(self, d.uid)
    const req = this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', `${request}:request`)
    const ob = this.one<OutboundRow>('SELECT * FROM outbound WHERE request = ?', request)
    const retry = (r: OutboxRow) => r.answered ? '' : r.state === 'sent' ? `; no answer yet — posted ${r.attempts}×, next retry ${r.next_retry ?? 'pending'}` : r.state === 'failed' ? `; not posted: ${r.error} (retried)` : '; queued'
    const via = (r: OutboxRow) => r.route === 'http' ? `delivered over HTTP (stored by ${r.peer} at ${r.sent})` : `posted on the retired Zulip link (message ${r.message} at ${r.sent})`
    const delivery = !req ? 'not queued' : req.state === 'sent' ? `${via(req)}${req.expects && !req.answered && !d.child ? retry(req) : ''}` : req.state === 'failed' ? `not ${req.route === 'http' ? 'delivered' : 'posted'} yet: ${req.error} (retried${req.retry_at ? ` at ${req.retry_at}` : ''})` : req.state === 'refused' ? `refused by ${req.peer}'s HTTP ingress: ${req.error} (not retried)` : 'queued'
    const declined = d.events.find(e => e.type === 'declined')
    const acceptance = d.child ? `accepted: ${d.child.project} ${d.child.workflow}/${d.child.run} on ${d.child.instance}` : declined ? `declined: ${declined.text}` : req?.state === 'sent' ? 'unknown (no answer from the other installation yet)' : 'unknown (not delivered)'
    const outRows = this.all<OutboxRow>('SELECT * FROM outbox WHERE request = ? AND type IN (\'answer\', \'instruction\', \'correction\', \'cancel\') ORDER BY created', request)
    const opRows = new Map(this.all<OpRow>('SELECT * FROM ops WHERE request = ? AND dir = \'out\'', request).map(o => [o.id, o]))
    const operations = outRows.map(r => {
      const o = opRows.get(r.id)
      const outcome = o && o.state !== 'queued' ? `${o.state}${o.code ? ` (${o.code})` : ''}${o.reason ? `: ${o.reason.slice(0, 200)}` : ''}${o.seq ? ` at seq ${o.seq}` : ''}` : `not acknowledged${retry(r)}`
      return { id: r.id, kind: r.type, delivery: r.state === 'sent' ? (r.route === 'http' ? 'delivered over HTTP' : `posted on the retired Zulip link (message ${r.message})`) : r.route === 'http' ? r.state : `${r.state} on the retired Zulip link (not sent)`, outcome }
    })
    const observed = ob?.observed ? JSON.parse(ob.observed) as RunSnapshot : null
    const heard = [ob?.heard, ob?.observed_at].filter((x): x is string => !!x).sort().at(-1) ?? null
    const age = heard ? this.ms() - Date.parse(heard) : null
    const freshness = !d.child ? 'unknown' : !heard ? 'unknown (nothing heard from the remote run yet)' : age! > STALE_MS && isOpenDelegation(d) ? `stale (last heard ${heard}, ${Math.round(age! / 60_000)} min ago)` : `fresh (last heard ${heard})`
    const waiting = this.all<{ note: string; id: string }>('SELECT note, id FROM hinbox WHERE request = ? AND state = \'waiting\' ORDER BY received, id', request).map(w => `${w.id}: ${w.note}`)
    const problems = [
      ...(ob?.problem ? [ob.problem] : []),
      ...this.all<FactRow>('SELECT * FROM facts WHERE request = ? AND state = \'oversize\'', request).map(f => `the remote run's ${f.fact} could not be carried: ${f.note}`),
    ]
    const superseded = this.all<FactRow>('SELECT * FROM facts WHERE request = ? AND state IN (\'superseded\', \'closed\')', request).map(f => `${f.fact} ${f.state}${f.note ? `: ${f.note}` : ''}`)
    return {
      request, peer: d.target.instance!, route: ob?.route ?? req?.route ?? null, delivery, acceptance, remoteRun: d.child?.uid ?? ob?.remote_run ?? null, remoteUrl: d.child?.url ?? ob?.remote_url ?? null,
      problem: problems.join('; ') || null, operations, observed: observed ? { ...observed, at: ob!.observed_at } : null, freshness, waiting, kept: superseded,
      capabilities: this.capabilitiesOf(d.target.instance!).capabilities,
    }
  }

  // ---- the requesting side ---------------------------------------------------------------------

  // What a remote dispatch is checked against before anything is recorded.
  static checkRemoteTarget(cfg: PeerConfig, instance: string, project: string, workflow: string): PeerEntry {
    const peer = peerOf(cfg, instance)
    if (!peer) throw new RequestError(409, `instance ${instance} is not a configured peer of this installation (peers.json lists ${cfg.peers.map(p => p.instance).join(', ') || 'none'})`, { code: 'delegate-target' })
    if (!peer.request.includes(`${project}/${workflow}`)) throw new RequestError(409, `${peer.label} (${instance}) is not configured to be asked for ${project}/${workflow} (peers.json request: ${peer.request.join(', ') || 'none'})`, { code: 'delegate-target' })
    return peer
  }

  static requestEnvelope(cfg: PeerConfig, rec: RunRecord, d: Delegation, request: string, original: string | null): Extract<Envelope, { type: 'request' }> {
    const body: RequestBody = {
      delegation: d.uid,
      parent: { project: rec.project, workflow: rec.workflow, run: rec.run, creation: creationOf(rec), node: d.node },
      target: { project: d.target.project, workflow: d.target.workflow },
      accepts: d.accepts, requester: d.requester, onBehalfOf: d.onBehalfOf,
      request: { text: request, sha256: sha256(request) },
      original: original === null ? null : { text: original, sha256: sha256(original) },
      capabilities: [...CAPABILITIES],
    }
    const id = requestIdOf(cfg.self, d.uid)
    return envelope('request', { id: `${id}:request`, from: cfg.self, to: d.target.instance!, request: id, body })
  }

  // An envelope as it travels (the HTTP body); its length is the message bound.
  static wire(e: Envelope): string { return JSON.stringify(e) }

  // The request message of a remote delegation, queued once (by its id).
  // Called at dispatch and again by every pass for open, unanswered remote
  // delegations, so a crash between the dispatch and the queueing is
  // repaired from the record.
  async ensureRequest(workspace: string, rec: RunRecord, d: Delegation): Promise<boolean> {
    const cfg = needPeerConfig(this.ctx.area)
    const id = requestIdOf(cfg.self, d.uid)
    if (this.one('SELECT 1 FROM outbox WHERE id = ?', `${id}:request`)) return false
    const { request, original } = await this.delegate.requestOf({ workspace, workflow: rec.workflow, run: rec.run }, d.id)
    const e = PeerStore.requestEnvelope(cfg, rec, d, request, original)
    this.tx(() => {
      this.run(`INSERT OR IGNORE INTO outbound (request, peer, delegation, parent_ws, parent_workflow, parent_run, d, target, state, updated, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, 'http')`,
        id, d.target.instance!, d.uid, workspace, rec.workflow, rec.run, d.id, `${d.target.project}/${d.target.workflow}`, this.now())
      this.queue({ id: e.id, peer: e.to, request: id, type: 'request', envelope: e })
    })
    return true
  }

  // Every message travels over HTTP; the row carries the envelope itself.
  // (`topic` is a column of the retired Zulip link; new rows leave it empty.)
  // `again`: a message already sent is sent again under its identity.
  queue(o: { id: string; peer: string; request: string; type: string; envelope: Envelope }, again = false): void {
    const content = PeerStore.wire(o.envelope)
    if (content.length > MAX_MESSAGE) throw new RequestError(413, `the ${o.type} message for ${o.request} is ${content.length} characters; the link carries at most ${MAX_MESSAGE}`, { code: 'peer-message-size' })
    const r = this.run(`INSERT OR IGNORE INTO outbox (id, peer, request, type, topic, content, payload, state, created, expects, route) VALUES (?, ?, ?, ?, '', ?, ?, 'ready', ?, ?, 'http')`, o.id, o.peer, o.request, o.type, content, o.envelope.payload, this.now(), EXPECTS_ANSWER.has(o.type) ? 1 : 0)
    // One the retired Zulip link held in any state goes over HTTP now; an HTTP one only once sent.
    if (!r.changes && again) this.requeue(o.id, { states: this.one<{ route: string }>('SELECT route FROM outbox WHERE id = ?', o.id)?.route === 'http' ? ['sent'] : ['ready', 'sent', 'failed', 'refused'] })
  }
  // A sent message posted again under its identity (a repeated answer, a
  // replay, a retry). One the retired Zulip link carried goes over HTTP now,
  // with the envelope its post held; one whose post holds none stays history.
  requeue(id: string, o: { repost?: boolean; unanswered?: boolean; states?: OutboxRow['state'][] } = {}): number {
    const row = this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id)
    if (!row || !(o.states ?? ['sent']).includes(row.state) || (o.unanswered && row.answered)) return 0
    let content = row.content
    if (row.route !== 'http') {
      const p = storedPostEnvelope(row.content)
      if ('problem' in p) return 0
      content = PeerStore.wire(p.envelope)
    }
    return Number(this.run('UPDATE outbox SET state = \'ready\', route = \'http\', content = ?, retry_at = NULL, reposts = reposts + ? WHERE id = ?', content, o.repost ? 1 : 0, id).changes)
  }
  // The envelope an outbox row carries: the JSON itself, or (a row of the retired Zulip link) its post's block.
  static rowEnvelope(row: Pick<OutboxRow, 'route' | 'content'>): ReturnType<typeof parseEnvelope> {
    if (row.route !== 'http') return storedPostEnvelope(row.content)
    try { return parseEnvelope(JSON.parse(row.content)) } catch (e) { return { problem: (e as Error).message } }
  }
  answered(id: string) { this.run('UPDATE outbox SET answered = coalesce(answered, ?), next_retry = NULL WHERE id = ?', this.now(), id) }

  // ---- operations (A → B) ----------------------------------------------------------------------

  // The operation message of one recorded answer, instruction, correction or
  // cancellation: its id is stable from the record (n), its body is what B
  // applies. Rendered for the size check before the record is written.
  static operationEnvelope(cfg: PeerConfig, d: Delegation, kind: OperationKind, n: number | null, body: Operation['body']): Operation {
    const request = requestIdOf(cfg.self, d.uid)
    return envelope(kind, { id: `${request}:${kind}${n === null ? '' : `:${n}`}`, from: cfg.self, to: d.target.instance!, request, body: body as never }) as Operation
  }
  static checkSize(e: Envelope, what: string) {
    const content = PeerStore.wire(e)
    if (content.length > MAX_MESSAGE) throw new RequestError(413, `${what} would be a ${content.length}-character link message; the agdev link carries at most ${MAX_MESSAGE} (shorten it, or put the details in a file of a repository the other installation can fetch and name it); nothing was recorded or sent`, { code: 'peer-message-size' })
    return content
  }

  // The operations of a delegation's record that have no message yet: what
  // the dispatch path does for the request, for every answer, instruction
  // and correction (the record is the send intent). A peer that does not
  // apply one gets nothing; the problem is shown.
  ensureOperations(cfg: PeerConfig, d: Delegation): string[] {
    if (!d.target.instance || !d.child || !isOpenDelegation(d)) return []
    const peer = peerOf(cfg, d.target.instance)
    if (!peer) return []
    const caps = this.capabilitiesOf(peer.instance).capabilities
    const notes: string[] = []
    const want: { kind: OperationKind; n: number; body: Operation['body']; seq: number }[] = [
      ...d.answers.map(a => ({ kind: 'answer' as const, n: a.n, seq: a.seq, body: { run: d.child!.uid, question: a.question, answer: a.n, text: a.text, from: a.from, by: a.by } })),
      ...d.instructions.map(i => ({ kind: 'instruction' as const, n: i.n, seq: i.seq, body: { run: d.child!.uid, instruction: i.n, text: i.text, from: i.from, by: i.by } })),
      ...(d.revisions ?? []).map(r => ({ kind: 'correction' as const, n: r.n, seq: r.seq, body: { run: d.child!.uid, revision: r.n, result: { seq: r.childSeq, manifest: r.manifest }, instruction: r.instruction, reason: r.reason, from: r.from, by: r.by } })),
    ].sort((x, y) => x.seq - y.seq)
    for (const w of want) {
      const e = PeerStore.operationEnvelope(cfg, d, w.kind, w.n, w.body)
      if (this.one('SELECT 1 FROM outbox WHERE id = ?', e.id)) continue
      if (!caps.includes(w.kind)) { notes.push(`${e.id}: not sent — ${peer.label} has not said it applies ${w.kind}`); continue }
      const size = PeerStore.wire(e).length
      if (size > MAX_MESSAGE) { notes.push(`${e.id}: not sent — ${size} characters, over the link's ${MAX_MESSAGE}`); continue }
      this.queue({ id: e.id, peer: peer.instance, request: e.request, type: w.kind, envelope: e })
      notes.push(`${e.id} queued for ${peer.label}`)
    }
    return notes
  }

  // A cancellation of the remote run, asked by A's agent: recorded here
  // (nothing on A's run records it), then posted until B's receipt says what
  // happened. One per delegation.
  cancelRemote(cfg: PeerConfig, d: Delegation, o: { reason: string; by: string }): { id: string; duplicate: boolean; state: string } {
    const peer = peerOf(cfg, d.target.instance!)
    if (!peer) throw new RequestError(409, `instance ${d.target.instance} is not a configured peer`, { code: 'delegate-target' })
    PeerStore.needCapability(this, peer, 'cancel')
    const body: CancelBody = { run: d.child?.uid ?? null, reason: o.reason, by: o.by }
    const e = PeerStore.operationEnvelope(cfg, d, 'cancel', null, body)
    const prior = this.one<OpRow>('SELECT * FROM ops WHERE id = ? AND dir = \'out\'', e.id)
    if (prior) return { id: e.id, duplicate: true, state: prior.state }
    PeerStore.checkSize(e, 'the cancellation')
    this.tx(() => {
      this.run('INSERT INTO ops (id, dir, request, kind, payload, body, state, created, updated) VALUES (?, \'out\', ?, \'cancel\', ?, ?, \'queued\', ?, ?)', e.id, e.request, e.payload, JSON.stringify(body), this.now(), this.now())
      this.queue({ id: e.id, peer: peer.instance, request: e.request, type: 'cancel', envelope: e })
    })
    return { id: e.id, duplicate: false, state: 'queued' }
  }

  // ---- settling what was received -------------------------------------------------------------

  // p2: one settle pass at a time across the service's HTTP loop and `wfe
  // peer process` (a durable lease; a dead holder on this host is
  // replaced, another host's expires). A busy pass settles nothing and says so.
  holder() { return `${hostname()}:${process.pid}` }
  takeLease(name: string): { ok: true } | { ok: false; holder: string; until: string } {
    const me = this.holder()
    return this.tx(() => {
      const row = this.one<{ holder: string; until: string }>('SELECT holder, until FROM lease WHERE name = ?', name)
      if (row && row.holder !== me && row.until > this.now()) {
        const [host, pid] = [row.holder.slice(0, row.holder.lastIndexOf(':')), Number(row.holder.slice(row.holder.lastIndexOf(':') + 1))]
        if (!(host === hostname() && Number.isInteger(pid) && !alive(pid))) return { ok: false as const, holder: row.holder, until: row.until }
      }
      this.run('INSERT INTO lease (name, holder, until) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, until = excluded.until', name, me, new Date(this.ms() + LEASE_MS).toISOString())
      return { ok: true as const }
    })
  }
  releaseLease(name: string) { this.run('DELETE FROM lease WHERE name = ? AND holder = ?', name, this.holder()) }

  async process(o: { quietWhenBusy?: boolean } = {}): Promise<string[]> {
    const c = loadPeerConfig(this.ctx.area)
    if ('disabled' in c) return []
    if ('problems' in c) return c.problems
    const lease = this.takeLease('process')
    if (!lease.ok) return o.quietWhenBusy ? [] : [`another pass is settling the link (${lease.holder}, until ${lease.until}); nothing settled by this one`]
    try { return await this.settle(c.config) } finally { this.releaseLease('process') }
  }

  private async settle(cfg: PeerConfig): Promise<string[]> {
    const notes: string[] = [...this.announce(cfg)]
    // HTTP deliveries, in arrival order.
    for (const row of this.all<HInboxRow>('SELECT * FROM hinbox WHERE state IN (\'received\', \'failed\', \'waiting\') ORDER BY received, id')) {
      const at = `HTTP ${row.peer} ${row.id}`
      try {
        const dv: Delivery = { route: 'http', prior: row.state, peer: row.peer, id: row.id, at: row.received, envelope: JSON.parse(row.envelope), credential: row.credential }
        const r = await this.apply(cfg, dv)
        const waitingSince = r.state === 'waiting' ? row.waiting_since ?? this.now() : null
        this.run('UPDATE hinbox SET state = ?, note = ?, updated = ?, waiting_since = ? WHERE peer = ? AND id = ?', r.state, r.note, this.now(), waitingSince, row.peer, row.id)
        if (!(r.state === 'waiting' && row.state === 'waiting' && row.note === r.note)) notes.push(`${at}: ${r.state} — ${r.note}`)
      } catch (e) {
        this.run('UPDATE hinbox SET state = \'failed\', note = ?, attempts = attempts + 1, updated = ? WHERE peer = ? AND id = ?', (e as Error).message.slice(0, 500), this.now(), row.peer, row.id)
        if (row.note !== (e as Error).message.slice(0, 500)) notes.push(`${at}: failed (retried) — ${(e as Error).message}`)
      }
    }
    notes.push(...await this.repairRequests(cfg))
    notes.push(...await this.repairOperations(cfg))
    notes.push(...await this.relay(cfg))
    notes.push(...this.retryDue())
    notes.push(...await this.queryDue(cfg))
    notes.push(...this.manage.pass(cfg))
    return notes
  }

  private async apply(cfg: PeerConfig, row: Delivery): Promise<Applied & { type?: string; request?: string; id?: string }> {
    const parsed = parseEnvelope(row.envelope)
    if ('problem' in parsed) return { state: 'ignored', note: `not a link message: ${parsed.problem}` }
    const e = parsed.envelope
    const base = { type: e.type, request: e.request, id: e.id }
    // The credential's holder authenticates; the envelope must agree with it.
    const auth = authorizeHttp(cfg, row.peer, e)
    // A configured peer asking for what this installation does not run for
    // it is told so explicitly; anybody else is not answered at all.
    if (!auth.ok && auth.reason === 'not-permitted' && e.type === 'request') {
      const peer = peerOf(cfg, row.peer)!
      return { ...base, ...this.declineRequest(cfg, peer, e, row, 'not-permitted', auth.detail) }
    }
    if (!auth.ok) return { ...base, state: 'ignored', note: `${auth.reason}: ${auth.detail}` }
    const caps = (e.body as { capabilities?: unknown }).capabilities
    if (caps !== undefined) this.heardCapabilities(auth.peer.instance, caps, null)
    switch (e.type) {
      case 'request': return { ...base, ...await this.applyRequest(cfg, auth.peer, e, row) }
      case 'hello': {
        if (e.body.relation) this.manage.heardRelation(auth.peer.instance, e.body.relation)
        // p4: the latest hello's identity replaces the kept one (none: unknown).
        this.run('UPDATE peers SET identity = ?, identity_seen = ? WHERE instance = ?', e.body.identity ? JSON.stringify(e.body.identity) : null, e.body.identity ? this.now() : null, auth.peer.instance)
        return { ...base, state: 'done', note: `${auth.peer.label} speaks ${e.body.capabilities.join(', ') || 'nothing beyond peer/1'}${e.body.relation ? `; sees this installation as its ${e.body.relation.you}` : ''}${e.body.identity ? `; names itself ${e.body.identity.name ?? '(no name)'} on ${e.body.identity.host ?? '(unknown host)'}` : ''}` }
      }
      case 'update': case 'update-receipt': case 'update-status': case 'observe': case 'installation': {
        // p4: a management delivery is applied only while the credential it
        // came with is still a management credential and the relationship
        // still allows it (revocation after storing is not bypassed).
        const cred = row.credential ? this.one<{ revoked: string | null; scope: string }>('SELECT revoked, scope FROM credentials WHERE id = ?', row.credential) : undefined
        if (!cred || cred.revoked || cred.scope !== 'manage') return { ...base, state: 'ignored', note: `revoked: ${row.credential ?? 'no credential'} ${!cred ? 'is unknown here' : cred.revoked ? `was revoked ${cred.revoked}` : 'is not a management credential'}; not applied` }
        const why = this.manageIngress(auth.peer, e)
        if (why) return { ...base, state: 'ignored', note: `not-permitted: ${why}` }
        return { ...base, ...await this.manage.apply(cfg, auth.peer, e, row) }
      }
      case 'answer': case 'instruction': case 'correction': case 'cancel': return { ...base, ...await this.applyOperation(cfg, auth.peer, e, row) }
      case 'query': return { ...base, ...await this.applyQuery(cfg, auth.peer, e, row) }
      default: return { ...base, ...await this.applyAnswer(auth.peer, e, row) }
    }
  }

  // ---- the receiving side --------------------------------------------------------------------

  // The delivery a row came from (inbound.delivery; `zulip:…` on rows of the retired link).
  private static deliveryOf(row: Delivery): string { return `http:${row.peer}/${row.id}` }

  private async applyRequest(cfg: PeerConfig, peer: PeerEntry, e: Extract<Envelope, { type: 'request' }>, row: Delivery): Promise<Applied> {
    let existing = this.one<InboundRow>('SELECT * FROM inbound WHERE request = ?', e.request)
    // A cancellation came first (p2): the request is refused, told as such.
    if (existing?.state === 'cancelled') {
      this.run('UPDATE inbound SET payload = ?, delegation = ?, project = ?, workflow = ?, message = NULL, updated = ?, delivery = ? WHERE request = ?', e.payload, e.body.delegation, e.body.target.project, e.body.target.workflow, this.now(), PeerStore.deliveryOf(row), e.request)
      return this.declineRequest(cfg, peer, e, row, 'cancelled', `${peer.label} cancelled ${e.request} before it arrived here; no run was created`)
    }
    if (existing && existing.payload !== e.payload) {
      if (existing.state !== 'conflict') this.run('UPDATE inbound SET problem = ?, updated = ? WHERE request = ?', `${PeerStore.deliveryOf(row)} reused ${e.request} with another payload (${e.payload.slice(0, 19)}…); not applied`, this.now(), e.request)
      return { state: 'ignored', note: `conflict: ${e.request} was received with payload ${existing.payload.slice(0, 19)}…, this post carries ${e.payload.slice(0, 19)}…; nothing is applied` }
    }
    if (existing?.state === 'accepted' && existing.run) {
      // A redelivery (a lost acceptance, a retry, an operator's resend): the same run, told again.
      this.requeue(`${e.request}:accepted`)
      return { state: 'done', note: `${e.request} again: already ${existing.project} ${existing.run_workflow}/${existing.run}; acceptance repeated` }
    }
    if (existing?.state === 'declined') {
      this.requeue(`${e.request}:declined`)
      return { state: 'done', note: `${e.request} again: declined before (${existing.problem}); told again` }
    }
    if (!existing) this.run(`INSERT INTO inbound (request, peer, payload, delegation, project, workflow, state, message, topic, updated, route, delivery) VALUES (?, ?, ?, ?, ?, ?, 'received', NULL, '', ?, 'http', ?)`, e.request, peer.instance, e.payload, e.body.delegation, e.body.target.project, e.body.target.workflow, this.now(), PeerStore.deliveryOf(row))
    existing = undefined
    const b = e.body
    const decline = (code: string, reason: string) => this.declineRequest(cfg, peer, e, row, code, reason)
    // The target here: the project's workspace (never guessed), its
    // workflow as published, accepting requests.
    let ws: Workspace
    try { ws = await this.delegate.targetWorkspace(b.target.project) } catch (err) { return decline('target', (err as Error).message) }
    const exec = this.ctx.exec
    const access = exec.ctx.gitea ? exec.accessContext() : undefined
    try {
      const published = access ? await (await import('./published.ts')).publishedWorkspace(access, ws.reg, { fresh: true }) : null
      const summary = (await (published ?? ws).workflowSummaries()).list.find(s => s.id === b.target.workflow)
      if (!summary) return decline('target', `project ${b.target.project} has no workflow ${b.target.workflow}${published ? ' on its published default branch' : ''}`)
      if (!summary.intake) return decline('target', `${b.target.project}/${b.target.workflow} opts out of requests`)
    } catch (err) {
      if (err instanceof RequestError && err.status < 500) return decline('target', err.message)
      throw err
    }
    const receipt = `peer:${peer.instance}:${e.request}`
    let ref = await findRunByReceipt(ws, b.target.workflow, receipt)
    if (!ref) {
      try {
        const env = exec.ctx.gitea ? await exec.ctx.gitea.gitEnv() : {}
        ref = (await createRunInCopy(ws, {
          workflow: b.target.workflow, receipt, executor: { host: exec.executor }, by: b.requester, via: 'peer', area: this.ctx.area, ...(access ? { access } : {}),
          input: {
            from: 'agent', text: b.request.text, requester: b.requester, ...(b.onBehalfOf ? { onBehalfOf: b.onBehalfOf } : {}),
            entrustedBy: { kind: 'delegation', delegation: b.delegation, parent: b.parent, accepts: b.accepts, peer: { instance: peer.instance, request: e.request } },
            ...(b.original ? { original: b.original.text } : {}),
            source: { kind: 'peer', route: 'http', peer: row.peer, message: e.id, at: row.at },
          },
        }, env)).ref
      } catch (err) {
        if (err instanceof RequestError && err.status >= 400 && err.status < 500 && !/already exists/.test(err.message)) return decline('create', err.message)
        throw err
      }
    }
    const space = await runSpace(ws, ref)
    const child = (await readRun(space, ref)).record
    if (!child) throw new Error(`the run ${runKey(ref)} cannot be read after its creation`)
    if (!child.cancelled && child.control.attempts === 0) exec.enqueue(ws.reg.id, ref, 'start', `peer:${e.request}`, `start: a request from ${peer.label} (agdev link ${e.request})`)
    const uid = uidOf(child)
    const url = this.viewOf(cfg, ws.reg.id, ref)
    const a = envelope('accepted', { id: `${e.request}:accepted`, from: cfg.self, to: peer.instance, request: e.request, body: { run: { uid, project: child.project, workflow: child.workflow, run: child.run, created: child.created, url }, capabilities: [...CAPABILITIES] } })
    this.tx(() => {
      this.run('UPDATE inbound SET state = \'accepted\', workspace = ?, run_workflow = ?, run = ?, run_uid = ?, problem = NULL, updated = ? WHERE request = ?', ws.reg.id, ref!.workflow, ref!.run, uid, this.now(), e.request)
      this.queue({ id: a.id, peer: peer.instance, request: e.request, type: 'accepted', envelope: a }, true)
    })
    return { state: 'done', note: `${e.request} from ${peer.label}: run ${child.project} ${runKey(ref)} (${uid}), start queued` }
  }

  private viewOf(cfg: PeerConfig, ws: string, ref: RunRef): string | null {
    return cfg.viewBase ? `${cfg.viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(ref.workflow)}/${encodeURIComponent(ref.run)}` : null
  }

  // An explicit refusal, recorded and told once per request id; a repeated
  // request is told again (applyRequest).
  private declineRequest(cfg: PeerConfig, peer: PeerEntry, e: Extract<Envelope, { type: 'request' }>, row: Delivery, code: string, reason: string): { state: 'done'; note: string } {
    const prior = this.one<InboundRow>('SELECT * FROM inbound WHERE request = ?', e.request)
    if (prior && prior.payload !== e.payload) return { state: 'done', note: `conflict: ${e.request} was received with another payload; nothing is applied` }
    if (prior && !['received', 'declined', 'cancelled'].includes(prior.state)) return { state: 'done', note: `${e.request} is ${prior.state} already` }
    const d = envelope('declined', { id: `${e.request}:declined`, from: cfg.self, to: peer.instance, request: e.request, body: { code, reason } })
    this.tx(() => {
      if (!prior) this.run(`INSERT INTO inbound (request, peer, payload, delegation, project, workflow, state, message, topic, updated, route, delivery) VALUES (?, ?, ?, ?, ?, ?, 'received', NULL, '', ?, 'http', ?)`, e.request, peer.instance, e.payload, e.body.delegation, e.body.target.project, e.body.target.workflow, this.now(), PeerStore.deliveryOf(row))
      this.run('UPDATE inbound SET state = \'declined\', problem = ?, updated = ? WHERE request = ?', `${code}: ${reason}`, this.now(), e.request)
      this.queue({ id: d.id, peer: peer.instance, request: e.request, type: 'declined', envelope: d }, true)
    })
    return { state: 'done', note: `${e.request} declined (${code}): ${reason}` }
  }

  // The run an accepted request created, read from this installation's own records.
  private async inboundRun(row: InboundRow): Promise<{ ws: Workspace; space: Workspace; ref: RunRef; child: RunRecord }> {
    const regs = (await loadRegistry(this.ctx.registryFile)).workspaces
    const reg = recordedWorkspace(regs, row.workspace!)
    if (!reg) throw new Error(`workspace ${row.workspace} is not registered`)
    const ws = new Workspace(reg)
    const ref = { workflow: row.run_workflow!, run: row.run! }
    const space = await runSpace(ws, ref)
    const child = (await readRun(space, ref)).record
    if (!child) throw new Error(`run ${runKey(ref)} cannot be read`)
    if (uidOf(child) !== row.run_uid) throw new Error(`run ${runKey(ref)} is ${uidOf(child)} now, not ${row.run_uid}; nothing is done to another run`)
    return { ws, space, ref, child }
  }

  // One operation of the requesting side, applied to the run it was given
  // through the operation a local delivery uses (p2). Checked in order:
  // whose request, accepted yet, which run, still permitted, seen before.
  // Applied with the receipt `peer-op:<id>`, so a crash before the receipt
  // repeats nothing; the receipt says applied, requested or refused.
  private async applyOperation(cfg: PeerConfig, peer: PeerEntry, e: Operation, row: Delivery): Promise<Applied> {
    const ib = this.one<InboundRow>('SELECT * FROM inbound WHERE request = ?', e.request)
    if (ib && ib.peer !== peer.instance) return { state: 'ignored', note: `unauthorized: ${e.request} was asked by ${ib.peer}, not ${peer.label}` }
    const prior = this.one<OpRow>('SELECT * FROM ops WHERE id = ? AND dir = \'in\'', e.id)
    if (prior) {
      if (prior.payload !== e.payload) return { state: 'ignored', note: `conflict: ${e.id} was applied with payload ${prior.payload.slice(0, 19)}…, this post carries ${e.payload.slice(0, 19)}…; nothing is applied, the first stands` }
      this.requeue(`${e.id}:receipt`)
      return { state: 'done', note: `${e.id} again: ${prior.state}${prior.code ? ` (${prior.code})` : ''} before; receipt repeated` }
    }
    const receipt = (outcome: ReceiptBody['outcome'], code: string | null, reason: string, seq: number | null): Applied => {
      const body: ReceiptBody = { op: e.id, kind: e.type, payload: e.payload, outcome, code, reason: reason.length > 2000 ? `${reason.slice(0, 2000)}… (cut at 2000 characters)` : reason, seq, capabilities: [...CAPABILITIES] }
      const m = envelope('receipt', { id: `${e.id}:receipt`, from: cfg.self, to: peer.instance, request: e.request, body })
      this.tx(() => {
        this.run('INSERT INTO ops (id, dir, request, kind, payload, body, state, code, reason, seq, message, created, updated) VALUES (?, \'in\', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)', e.id, e.request, e.type, e.payload, JSON.stringify(e.body), outcome, code, reason.slice(0, 2000), seq, this.now(), this.now())
        this.queue({ id: m.id, peer: peer.instance, request: e.request, type: 'receipt', envelope: m })
      })
      return { state: 'done', note: `${e.id} from ${peer.label}: ${outcome}${code ? ` (${code})` : ''} — ${reason}` }
    }
    // A cancellation before the request arrived is kept: the request is then refused.
    if (!ib) {
      if (e.type !== 'cancel') return { state: 'waiting', note: `waits for the request ${e.request} (not received yet)` }
      this.run(`INSERT INTO inbound (request, peer, payload, delegation, project, workflow, state, problem, message, topic, updated, route, delivery) VALUES (?, ?, '', '', '', '', 'cancelled', ?, NULL, '', ?, 'http', ?)`, e.request, peer.instance, `cancelled by ${peer.label} before the request arrived: ${e.body.reason}`, this.now(), PeerStore.deliveryOf(row))
      return receipt('applied', null, `no request ${e.request} had arrived; it is refused if it comes (declined: cancelled), and no run is created for it`, null)
    }
    if (ib.state === 'received') return { state: 'waiting', note: `waits for the acceptance of ${e.request} here` }
    if (ib.state === 'cancelled') return receipt('applied', null, `${e.request} was cancelled before it arrived`, null)
    if (ib.state !== 'accepted' || !ib.run) return e.type === 'cancel' ? receipt('applied', null, `${e.request} was ${ib.state} here; there is no run to cancel`, null) : receipt('refused', 'not-accepted', `${e.request} is ${ib.state} here; there is no run`, null)
    const target = (e.body as { run: string | null }).run
    if (target !== null && target !== ib.run_uid) return receipt('refused', 'wrong-run', `${e.request} created ${ib.run_uid}, not ${target}; nothing is applied to another run`, null)
    if (!peer.accept.includes(`${ib.project}/${ib.workflow}`)) return receipt('refused', 'not-permitted', `${peer.label} may no longer ask for ${ib.project}/${ib.workflow} here (peers.json accept)`, null)
    const { ws, space, ref, child } = await this.inboundRun(ib)
    const rc = `peer-op:${e.id}`
    const ctx = { by: (e.body as { by: string }).by, via: 'peer' }
    const exec = this.ctx.exec
    const at = (rec: RunRecord) => rec.history.find(h => h.receipt === rc)
    const codeOf = (err: unknown) => (err as RequestError).detail && typeof (err as RequestError).detail === 'object' ? ((err as RequestError).detail as { code?: string }).code : undefined
    const refusal = (err: unknown): Applied => {
      const code = codeOf(err)
      if (!(err instanceof RequestError) || err.status >= 500) throw err
      return receipt('refused', code && ['question-closed', 'run-completed', 'run-cancelled', 'result-superseded', 'correction-state', 'question-unknown'].includes(code) ? code : 'invalid', err.message, null)
    }
    const done = child.execution.state === 'completed' && !openCorrections(child).length
    if (e.type === 'cancel') {
      const dup = at(child)
      if (dup) return receipt('applied', null, `cancelled at seq ${dup.seq}`, dup.seq)
      if (child.cancelled) return receipt('applied', null, `already cancelled (${child.cancelled.reason})`, null)
      if (done) {
        const last = [...child.history].reverse().find(h => h.change.execution?.[1] === 'completed')
        return receipt('refused', 'run-completed', `${child.project} ${runKey(ref)} completed at seq ${last?.seq ?? child.seq} before the cancellation arrived; its result stands`, null)
      }
      try {
        const r = await exec.cancel(ws, ref, ctx.by, `cancelled by its requester ${ctx.by} on ${peer.label} (delegation ${ib.delegation}): ${e.body.reason}`, 'peer', { receipt: rc })
        const h = at(r.record)
        return receipt(r.record.control.attempt ? 'requested' : 'applied', null, r.record.control.attempt ? `cancellation recorded; attempt ${r.record.control.attempt.id} is being stopped` : 'cancelled', h?.seq ?? null)
      } catch (err) { return refusal(err) }
    }
    if (child.cancelled) return receipt('refused', 'run-cancelled', `${child.project} ${runKey(ref)} is cancelled (${child.cancelled.reason})`, null)
    if (e.type === 'answer') {
      if (done) return receipt('refused', 'run-completed', `${child.project} ${runKey(ref)} is completed; an answer is not applied to a completed run`, null)
      try {
        const r = at(child) ? { record: child } : await runOp(space, ref, { op: 'question.answer', question: e.body.question, text: e.body.text, from: e.body.from, delegation: { uid: ib.delegation, answer: e.body.answer }, receipt: rc } as never, ctx)
        await exec.afterAnswer(ws, ref, e.body.question)
        return receipt('applied', null, `answer to ${e.body.question} recorded`, at(r.record)?.seq ?? null)
      } catch (err) { return refusal(err) }
    }
    if (e.type === 'instruction') {
      if (done) return receipt('refused', 'run-completed', `${child.project} ${runKey(ref)} is completed; an instruction is not applied to a completed run (a correction reopens it)`, null)
      try {
        const r = at(child) ? { record: child } : await runOp(space, ref, { op: 'instruction.receive', text: e.body.text, from: e.body.from, receipt: rc } as never, ctx)
        const h = at(r.record)
        const id = h?.change.instruction?.[1]
        if (id) await exec.afterInstruction(ws, ref, id)
        return receipt('applied', null, `recorded as instruction ${id ?? '?'}`, h?.seq ?? null)
      } catch (err) { return refusal(err) }
    }
    // A correction returns one result: the completion it names must be the
    // latest here, and its manifest the one this side sent with it.
    if (!at(child)) {
      const sent = this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', `delegation:${ib.delegation}:${e.body.result.seq}:completed`)
      const ev = sent ? PeerStore.rowEnvelope(sent) : null
      const manifest = ev && 'envelope' in ev && ev.envelope.type === 'event' ? (ev.envelope.body.event.manifest as ResultManifest | undefined)?.digest ?? null : null
      if (!sent) return receipt('refused', 'result-superseded', `no result of ${runKey(ref)} at seq ${e.body.result.seq} was sent from here`, null)
      if (e.body.result.manifest !== null && manifest !== e.body.result.manifest) return receipt('refused', 'result-superseded', `the result at seq ${e.body.result.seq} was sent with manifest ${manifest ?? 'none'}, not ${e.body.result.manifest}`, null)
    }
    try {
      const r = at(child) ? { record: child } : await runOp(space, ref, { op: 'correction.receive', delegation: { uid: ib.delegation, revision: e.body.revision }, result: { seq: e.body.result.seq }, text: e.body.instruction, reason: e.body.reason, from: e.body.from, receipt: rc } as never, ctx)
      const h = at(r.record)
      const id = h?.change.correction?.[1]
      if (id) await exec.afterCorrection(ws, ref, id)
      return receipt('applied', null, `recorded as correction ${id ?? '?'}; the run is open for it again`, h?.seq ?? null)
    } catch (err) { return refusal(err) }
  }

  // The facts of every accepted request's run, from this installation's
  // own record, each queued once under the requester's relay receipt. A
  // fact that cannot be carried is kept unsent and named to the requester.
  private async relay(cfg: PeerConfig): Promise<string[]> {
    const notes: string[] = []
    for (const row of this.all<InboundRow>('SELECT * FROM inbound WHERE state = \'accepted\' AND run IS NOT NULL')) {
      try {
        const { space, child } = await this.inboundRun(row)
        if (child.seq <= row.relayed) continue
        for (const f of childFacts(row.delegation, child, row.relayed)) {
          if (this.one('SELECT 1 FROM outbox WHERE id = ?', f.receipt)) continue
          const event: Record<string, unknown> = f.event.type === 'completed' ? { ...f.event, manifest: await this.remoteManifest(cfg, space, child, row) } : { ...f.event }
          const m = envelope('event', { id: f.receipt, from: cfg.self, to: row.peer, request: row.request, body: { receipt: f.receipt, event } })
          const size = PeerStore.wire(m).length
          if (size > MAX_MESSAGE) { notes.push(...this.oversize(cfg, row, m, size)); continue }
          this.queue({ id: m.id, peer: row.peer, request: row.request, type: 'event', envelope: m })
          notes.push(`${row.request}: ${f.event.type} (seq ${f.event.child.seq}) queued for ${row.peer}`)
        }
        this.run('UPDATE inbound SET relayed = ?, problem = NULL, updated = ? WHERE request = ?', child.seq, this.now(), row.request)
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500)
        if (row.problem !== msg) notes.push(`${row.request}: relay failed (retried) — ${msg}`)
        this.run('UPDATE inbound SET problem = ?, updated = ? WHERE request = ?', msg, this.now(), row.request)
      }
    }
    return notes
  }

  // A fact too large for one message: kept (outbox state `oversize`, the
  // full message as it would be), and a `problem` naming it is sent.
  private oversize(cfg: PeerConfig, row: InboundRow, m: Extract<Envelope, { type: 'event' }>, size: number): string[] {
    const ev = m.body.event as { type: string; child: { seq: number } }
    const url = row.workspace && row.run_workflow && row.run ? this.viewOf(cfg, row.workspace, { workflow: row.run_workflow, run: row.run }) : null
    const p = envelope('problem', { id: `${m.id}:oversize`, from: cfg.self, to: row.peer, request: row.request, body: { fact: factId(ev.child.seq, ev.type), type: ev.type, size, limit: MAX_MESSAGE, url } })
    this.tx(() => {
      this.run(`INSERT OR IGNORE INTO outbox (id, peer, request, type, topic, content, payload, state, created, route) VALUES (?, ?, ?, 'event', '', ?, ?, 'oversize', ?, 'http')`, m.id, row.peer, row.request, JSON.stringify(m), m.payload, this.now())
      this.queue({ id: p.id, peer: row.peer, request: row.request, type: 'problem', envelope: p })
    })
    return [`${row.request}: ${ev.type} (seq ${ev.child.seq}) is ${size} characters, over the link's ${MAX_MESSAGE}; kept unsent, the requester is told`]
  }

  // The ordinary result manifest, plus where the work is: the run copy's
  // repository and commit, whether that commit is on the run branch as
  // published there, and the run's view.
  private async remoteManifest(cfg: PeerConfig, space: Workspace, child: RunRecord, row: InboundRow): Promise<ResultManifest> {
    const { digest: _d, ...body } = await this.delegate.manifest(space, child)
    const env = this.ctx.exec.ctx.gitea ? await this.ctx.exec.ctx.gitea.gitEnv() : {}
    const origin = (await git(space.root, ['remote', 'get-url', 'origin'])).stdout.trim()
    const repository = origin ? origin.replace(/\/\/[^@/]+@/, '//') : null
    const commit = (await git(space.root, ['rev-parse', 'HEAD'])).stdout.trim() || null
    const branch = child.storage?.branch ?? null
    let published: boolean | null = null
    if (origin && branch && commit) {
      const r = await git(space.root, ['ls-remote', '--heads', 'origin', branch], { env, timeoutMs: 30_000 })
      published = r.code === 0 ? r.stdout.split(/\s+/)[0] === commit : null
    }
    const url = this.viewOf(cfg, row.workspace!, child)
    // cluster_teamwork p2: the outputs the run published to a share by the
    // time it completed, from its own record (never from its outcome text):
    // what the requester verifies against its own mount. Part of the digest.
    const done = [...child.history].reverse().find(h => h.change.execution?.[1] === 'completed')
    const outputs = Object.values(child.outputs ?? {}).filter(o => !done || o.published.at <= done.at).map(o => ({
      id: o.id, ref: o.ref, manifest: o.digest, count: o.count, bytes: o.bytes, title: o.title, candidate: o.candidate, at: o.published.at,
      producer: { instance: cfg.self, project: child.project, workflow: child.workflow, run: uidOf(child) },
    }))
    const full = { ...body, remote: { instance: cfg.self, run: uidOf(child), url, repository, commit, published, integrated: !!child.integrations?.length, outputs } }
    return { digest: `sha256:${sha256(canonicalJson(full))}`, ...full }
  }

  // A's question about the run (p2): a snapshot, B's list of the run's
  // facts in the window A asked about, the replay of the ones A lacks (the
  // messages sent then, unchanged) and what became of the operations A has
  // no receipt for.
  private async applyQuery(cfg: PeerConfig, peer: PeerEntry, e: Extract<Envelope, { type: 'query' }>, _row: Delivery): Promise<Applied> {
    const ib = this.one<InboundRow>('SELECT * FROM inbound WHERE request = ?', e.request)
    if (!ib) return { state: 'waiting', note: `waits for the request ${e.request} (not received yet)` }
    if (ib.peer !== peer.instance) return { state: 'ignored', note: `unauthorized: ${e.request} was asked by ${ib.peer}, not ${peer.label}` }
    if (ib.state === 'received') return { state: 'waiting', note: `waits for the acceptance of ${e.request} here` }
    let run: RunSnapshot | null = null
    let facts: { id: string; seq: number; receipt: string }[] = []
    if (ib.state === 'accepted' && ib.run && ib.run_uid === e.body.run) {
      const { child } = await this.inboundRun(ib)
      run = {
        uid: ib.run_uid, seq: child.seq, execution: child.execution.state, cancelled: !!child.cancelled, attempt: !!child.control.attempt, hold: child.control.hold?.kind ?? null,
        questions: Object.values(child.questions).filter(q => ['open', 'answered'].includes(questionState(q))).map(q => q.id),
        corrections: openCorrections(child).map(c => c.id),
      }
      facts = childFacts(ib.delegation, child, 0).map(f => ({ id: factId(f.event.child.seq, f.event.type), seq: f.event.child.seq, receipt: f.receipt }))
    }
    const from = e.body.facts.from, to = e.body.facts.to
    const window = facts.filter(f => f.seq > from && (to === null || f.seq <= to))
    const have = new Set(e.body.facts.have)
    const ops: StateBody['ops'] = {}
    for (const id of e.body.unacknowledged.slice(0, 50)) {
      if (!id.startsWith(`${e.request}:`)) continue
      const o = this.one<OpRow>('SELECT * FROM ops WHERE id = ? AND dir = \'in\'', id)
      ops[id] = o ? o.state as 'applied' | 'requested' | 'refused' : 'unknown'
      if (o) this.requeue(`${id}:receipt`)
    }
    // Which facts A lacks are replayed (the messages sent then), within
    // the bound; the fact list is cut where the message would not fit.
    let through = to === null ? Math.max(from, run?.seq ?? from) : to
    let shown = window
    let replayed: string[] = [], pending: string[] = []
    const plan = () => {
      replayed = []; pending = []
      for (const f of shown.filter(x => !have.has(x.id))) {
        if (replayed.length < REPLAYS_PER_QUERY && this.one('SELECT 1 FROM outbox WHERE id = ?', f.receipt)) replayed.push(f.id)
        else pending.push(f.id)
      }
    }
    const build = () => envelope('state', { id: `${e.id}:state`, from: cfg.self, to: peer.instance, request: e.request, body: { query: e.id, at: this.now(), run, facts: { from, through, all: shown.map(f => f.id), replayed, pending, more: shown.length < window.length }, ops, capabilities: [...CAPABILITIES] } })
    plan()
    while (shown.length && PeerStore.wire(build()).length > MAX_MESSAGE) {
      shown = shown.slice(0, Math.floor(shown.length / 2))
      through = shown.at(-1)?.seq ?? from
      plan()
    }
    for (const id of replayed) {
      const f = shown.find(x => x.id === id)!
      const o = this.one<OutboxRow>('SELECT state FROM outbox WHERE id = ?', f.receipt)!
      this.requeue(o.state === 'oversize' ? `${f.receipt}:oversize` : f.receipt)
    }
    const m = build()
    this.queue({ id: m.id, peer: peer.instance, request: e.request, type: 'state', envelope: m })
    return { state: 'done', note: `${e.id}: state told${replayed.length ? `, ${replayed.length} fact(s) replayed` : ''}${pending.length ? `, ${pending.length} pending` : ''}` }
  }

  // ---- answers on the requesting side ---------------------------------------------------------

  private async parentOf(ob: OutboundRow): Promise<{ space: Workspace; ref: RunRef; rec: RunRecord; d: Delegation }> {
    const ws = await this.delegate.workspace(ob.parent_ws)
    const ref = { workflow: ob.parent_workflow, run: ob.parent_run }
    const space = await runSpace(ws, ref)
    const rec = (await readRun(space, ref)).record
    if (!rec) throw new Error(`the delegating run ${runKey(ref)} cannot be read`)
    const d = rec.delegations?.[ob.d]
    if (!d || d.uid !== ob.delegation) throw new Error(`the delegating run ${runKey(ref)} has no delegation ${ob.delegation}`)
    return { space, ref, rec, d }
  }

  // What this side holds of the remote run's facts: the receipts recorded
  // on the delegating run and the facts kept here.
  private have(request: string, rec: RunRecord, d: Delegation): Set<string> {
    const prefix = `delegation:${d.uid}:`
    const out = new Set<string>()
    for (const h of rec.history) if (h.receipt?.startsWith(prefix)) out.add(h.receipt.slice(prefix.length))
    for (const f of this.all<FactRow>('SELECT fact FROM facts WHERE request = ?', request)) out.add(f.fact)
    return out
  }
  private keepFact(request: string, fact: string, receipt: string, state: FactRow['state'], note: string) {
    this.run('INSERT OR IGNORE INTO facts (request, fact, receipt, state, note, at) VALUES (?, ?, ?, ?, ?, ?)', request, fact, receipt, state, note, this.now())
  }

  private async applyAnswer(peer: PeerEntry, e: Exclude<Envelope, { type: 'request' | 'hello' | Operation['type'] | 'query' | typeof MANAGE_TYPES[number] }>, row: Delivery): Promise<Applied> {
    const ob = this.one<OutboundRow>('SELECT * FROM outbound WHERE request = ?', e.request)
    if (!ob) return { state: 'ignored', note: `unknown request ${e.request}: this installation sent no such request` }
    if (ob.peer !== peer.instance) return { state: 'ignored', note: `unauthorized: ${e.request} was sent to ${ob.peer}, not ${peer.instance}` }
    // Heard from the remote side: a new post, not one settled again while it waits.
    if (row.prior !== 'waiting') this.run('UPDATE outbound SET heard = ? WHERE request = ?', this.now(), e.request)
    if (e.type === 'accepted' || e.type === 'declined') this.answered(`${e.request}:request`)
    const { space, ref, rec, d } = await this.parentOf(ob)
    const closed = rec.cancelled || d.closed ? (rec.cancelled ? 'run cancelled' : d.closed!.reason) : null
    const ctx = { by: peer.label, via: 'peer' }
    if (e.type === 'receipt') return this.applyReceipt(peer, e, ob, { space, ref, rec, d, closed })
    if (e.type === 'state') return this.applyState(e, ob, rec, d)
    if (e.type === 'problem') {
      this.keepFact(e.request, e.body.fact, `${e.id}`, 'oversize', `${e.body.type} is ${e.body.size} characters (the link carries ${e.body.limit}); read it on ${peer.label}${e.body.url ? `: ${e.body.url}` : ''}`)
      return { state: 'done', note: `${runKey(ref)} ${d.id}: ${peer.label} cannot carry ${e.body.type} ${e.body.fact} (${e.body.size} characters)` }
    }
    if (e.type === 'accepted') {
      const r = e.body.run
      if (closed) {
        // The delegation is closed here: the acceptance is kept as an observation, the run not reopened.
        this.run('UPDATE outbound SET state = \'accepted\', remote_run = ?, remote_url = ?, updated = ? WHERE request = ?', r.uid, r.url, this.now(), e.request)
        return { state: 'done', note: `${runKey(ref)} ${d.id} is closed (${closed}); the acceptance as ${r.uid} is kept, nothing recorded on the run` }
      }
      if (r.project !== d.target.project || r.workflow !== d.target.workflow) {
        this.run('UPDATE outbound SET problem = ?, updated = ? WHERE request = ?', `accepted as ${r.project}/${r.workflow}, not the requested ${d.target.project}/${d.target.workflow}`, this.now(), e.request)
        return { state: 'ignored', note: `conflict: accepted as ${r.project}/${r.workflow}, not ${d.target.project}/${d.target.workflow}` }
      }
      if (d.child && d.child.uid !== r.uid) {
        this.run('UPDATE outbound SET problem = ?, updated = ? WHERE request = ?', `a second acceptance names ${r.uid}; bound to ${d.child.uid}`, this.now(), e.request)
        return { state: 'ignored', note: `conflict: already bound to ${d.child.uid}, this acceptance names ${r.uid}` }
      }
      if (!d.child) {
        const transport = { route: 'http', peer: row.peer, message: e.id, at: row.at }
        await runOp(space, ref, { op: 'delegation.bind', delegation: d.id, child: { uid: r.uid, workspace: `peer:${peer.instance}`, project: r.project, workflow: r.workflow, run: r.run, created: r.created, instance: peer.instance, ...(r.url ? { url: r.url } : {}) }, transport, receipt: `delegation-bind:${d.uid}` } as never, ctx)
      }
      this.run('UPDATE outbound SET state = \'accepted\', remote_run = ?, remote_url = ?, problem = NULL, updated = ? WHERE request = ?', r.uid, r.url, this.now(), e.request)
      return { state: 'done', note: `${runKey(ref)} ${d.id}: accepted by ${peer.label} as ${r.project} ${r.workflow}/${r.run}` }
    }
    if (e.type === 'declined') {
      this.run('UPDATE outbound SET state = \'declined\', problem = ?, updated = ? WHERE request = ?', `${e.body.code}: ${e.body.reason}`, this.now(), e.request)
      if (closed) return { state: 'done', note: `${runKey(ref)} ${d.id} is closed (${closed}); the refusal (${e.body.code}) is kept, nothing recorded on the run` }
      if (d.child) return { state: 'ignored', note: `conflict: ${d.id} is bound to ${d.child.uid}; a refusal after the acceptance is not recorded` }
      const r = await runOp(space, ref, { op: 'delegation.event', delegation: d.id, event: { type: 'declined', child: { seq: 0, at: this.now(), by: peer.label }, text: `${peer.label} declined (${e.body.code}): ${e.body.reason}` }, receipt: `peer:${e.request}:declined` } as never, ctx)
      if (!r.duplicate) await this.delegate.continuation(space, ref)
      return { state: 'done', note: `${runKey(ref)} ${d.id}: declined by ${peer.label} (${e.body.code})` }
    }
    // A fact of the remote run, under the relay receipt it was sent with.
    const ev = e.body.event
    if (!e.body.receipt.startsWith(`delegation:${d.uid}:`) || e.body.receipt !== e.id) return { state: 'ignored', note: `conflict: receipt ${e.body.receipt} does not belong to ${d.uid}` }
    if (!(EVENT_TYPES as readonly string[]).includes(String(ev.type)) || ev.type === 'declined' || ev.type === 'answer-refused') return { state: 'ignored', note: `unsupported fact ${String(ev.type)}` }
    const seq = Number((ev.child as { seq?: unknown } | undefined)?.seq ?? 0)
    const fact = factId(seq, String(ev.type))
    if (rec.history.some(h => h.receipt === e.body.receipt)) return { state: 'done', note: `${e.body.receipt} again: recorded once` }
    if (this.one('SELECT 1 FROM facts WHERE request = ? AND fact = ?', e.request, fact)) return { state: 'done', note: `${fact} again: kept once` }
    if (closed) {
      // After the delegation closed: an observation of the remote run, not a fact of the parent (it is not reopened and nothing continues).
      this.keepFact(e.request, fact, e.body.receipt, 'closed', `${String(ev.type)} after the delegation closed (${closed})`)
      return { state: 'done', note: `${runKey(ref)} ${d.id} is closed (${closed}); ${String(ev.type)} from ${peer.label} kept as an observation` }
    }
    if (!d.child) return { state: 'waiting', note: `waits for the acceptance of ${e.request} (${String(ev.type)} came first)` }
    if (ev.type === 'completed') {
      const m = ev.manifest as ResultManifest | undefined
      if (!m?.remote || m.remote.instance !== peer.instance || m.child !== d.child.uid) return { state: 'ignored', note: `conflict: the result's manifest does not name ${d.child.uid} on ${peer.instance}` }
      // An older completion arriving after a newer one (a late replay) is
      // not made the latest result: it would end an open correction.
      const latest = latestResult(d)
      if (latest && latest.child.seq > seq) {
        this.keepFact(e.request, fact, e.body.receipt, 'superseded', `the result at child seq ${seq} arrived after the result at child seq ${latest.child.seq} (event ${latest.n}); not recorded as the latest`)
        return { state: 'done', note: `${runKey(ref)} ${d.id}: an older result (child seq ${seq}) after event ${latest.n} (child seq ${latest.child.seq}) — kept as superseded` }
      }
    }
    // A withdrawal before its question waits for the question.
    if (ev.type === 'withdrawn' && typeof ev.question === 'string' && !d.events.some(x => x.type === 'question' && x.question === ev.question)) return { state: 'waiting', note: `waits for the question ${ev.question} (its withdrawal came first)` }
    const r = await runOp(space, ref, { op: 'delegation.event', delegation: d.id, event: ev, receipt: e.body.receipt } as never, ctx)
    if (!r.duplicate && WAKING.has(String(ev.type))) await this.delegate.continuation(space, ref)
    return { state: 'done', note: `${runKey(ref)} ${d.id}: ${String(ev.type)} from ${peer.label}${r.duplicate ? ' (already recorded)' : ''}` }
  }

  // B's receipt for one of A's operations: its outcome kept here; a refusal
  // told to the parent as the existing `answer-refused` fact (it wakes it).
  private async applyReceipt(peer: PeerEntry, e: Extract<Envelope, { type: 'receipt' }>, _ob: OutboundRow, p: { space: Workspace; ref: RunRef; rec: RunRecord; d: Delegation; closed: string | null }): Promise<Applied> {
    const b = e.body
    const sent = this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', b.op)
    if (!sent) return { state: 'ignored', note: `unknown operation ${b.op}: this installation sent no such operation` }
    if (sent.payload !== b.payload) return { state: 'ignored', note: `conflict: the receipt for ${b.op} names payload ${b.payload.slice(0, 19)}…, the operation sent was ${sent.payload.slice(0, 19)}…` }
    this.answered(b.op)
    this.run(`INSERT INTO ops (id, dir, request, kind, payload, body, state, code, reason, seq, message, created, updated) VALUES (?, 'out', ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id, dir) DO UPDATE SET state = excluded.state, code = excluded.code, reason = excluded.reason, seq = excluded.seq, updated = excluded.updated`, b.op, e.request, b.kind, b.payload, b.outcome, b.code, b.reason, b.seq, sent.message, this.now(), this.now())
    const { space, ref, d, closed } = p
    if (b.outcome !== 'refused') return { state: 'done', note: `${runKey(ref)} ${d.id}: ${b.kind} ${b.op.split(':').slice(2).join('') || ''} ${b.outcome} by ${peer.label}${b.seq ? ` at seq ${b.seq}` : ''}`.replace(/  +/g, ' ') }
    if (closed) return { state: 'done', note: `${runKey(ref)} ${d.id} is closed (${closed}); the refusal of ${b.op} (${b.code}) is kept` }
    const n = Number(b.op.split(':')[2] ?? 0)
    const answer = b.kind === 'answer' ? d.answers.find(a => a.n === n) : undefined
    const text = b.kind === 'cancel'
      ? `the cancellation was not applied to the child: ${b.reason}`
      : `${b.kind === 'correction' ? 'correction request' : b.kind} ${n} was not applied to the child: ${b.code ? `${b.code}: ` : ''}${b.reason}`
    const extra = b.kind === 'correction' ? { revision: n } : b.kind === 'cancel' ? {} : { answer: n, ...(answer ? { question: answer.question } : {}) }
    const r = await runOp(space, ref, { op: 'delegation.event', delegation: d.id, event: { type: 'answer-refused', child: { seq: 0, at: this.now(), by: peer.label }, text, ...extra }, receipt: `peer-op:${b.op}:refused` } as never, { by: peer.label, via: 'peer' })
    if (!r.duplicate) await this.delegate.continuation(space, ref)
    return { state: 'done', note: `${runKey(ref)} ${d.id}: ${b.kind} refused by ${peer.label} (${b.code})${r.duplicate ? ' (already recorded)' : ''}` }
  }

  // B's state: the observation (kept here only, with its time), the
  // watermark when nothing is missing, and operations B never received
  // posted again at once.
  private applyState(e: Extract<Envelope, { type: 'state' }>, ob: OutboundRow, rec: RunRecord, d: Delegation): Applied {
    const b = e.body
    if (!this.one('SELECT 1 FROM outbox WHERE id = ?', b.query)) return { state: 'ignored', note: `unknown query ${b.query}` }
    this.answered(b.query)
    if (b.run && ob.remote_run && b.run.uid !== ob.remote_run) {
      this.run('UPDATE outbound SET problem = ?, updated = ? WHERE request = ?', `the remote state names ${b.run.uid}, not the bound ${ob.remote_run}`, this.now(), e.request)
      return { state: 'ignored', note: `conflict: state of ${b.run.uid}, bound ${ob.remote_run}` }
    }
    const have = this.have(e.request, rec, d)
    const missing = b.facts.all.filter(f => !have.has(f))
    const advance = !missing.length && !b.facts.pending.length && b.facts.through > ob.verified
    this.run('UPDATE outbound SET observed = ?, observed_at = ?, heard = ?, verified = ?, updated = ? WHERE request = ?', b.run ? JSON.stringify({ ...b.run, told: b.at }) : null, this.now(), this.now(), advance ? b.facts.through : ob.verified, this.now(), e.request)
    let again = 0
    for (const [id, st] of Object.entries(b.ops)) if (st === 'unknown') again += this.requeue(id, { repost: true, unanswered: true })
    return { state: 'done', note: `${e.request}: state of the remote run — ${b.run ? `${b.run.execution}${b.run.cancelled ? ', cancelled' : ''}, seq ${b.run.seq}` : 'no run'}; ${missing.length ? `${missing.length} fact(s) missing here (${b.facts.replayed.length} replayed${b.facts.pending.length ? `, ${b.facts.pending.length} pending` : ''})` : `facts complete through ${b.facts.through}`}${again ? `; ${again} operation(s) posted again` : ''}` }
  }

  // ---- reconciliation (p2) ---------------------------------------------------------------------

  // Open remote delegations whose request was never queued (a crash after
  // the dispatch): queued from the record.
  private async repairRequests(cfg: PeerConfig): Promise<string[]> {
    const notes: string[] = []
    for (const row of this.delegate.rows().filter(r => r.state === 'open' && r.target_ws.startsWith('peer:') && !r.child_uid)) {
      try {
        const id = requestIdOf(cfg.self, row.uid)
        if (this.one('SELECT 1 FROM outbox WHERE id = ?', `${id}:request`)) continue
        const ws = await this.delegate.workspace(row.parent_ws)
        const ref = { workflow: row.parent_workflow, run: row.parent_run }
        const rec = (await readRun(await runSpace(ws, ref), ref)).record
        const d = rec?.delegations?.[row.delegation]
        if (!rec || !d || !isOpenDelegation(d) || d.child || rec.cancelled) continue
        if (await this.ensureRequest(row.parent_ws, rec, d)) notes.push(`${d.uid}: request queued from the record`)
      } catch (e) { notes.push(`${row.uid}: request not queued — ${(e as Error).message}`) }
    }
    return notes
  }

  // Recorded operations of open remote delegations without a message (a
  // crash between the record and the queueing): queued from the record.
  private async repairOperations(cfg: PeerConfig): Promise<string[]> {
    const notes: string[] = []
    const open = new Set(this.delegate.rows().filter(r => r.state === 'open' && r.target_ws.startsWith('peer:') && r.child_uid).map(r => r.uid))
    for (const ob of this.all<OutboundRow>('SELECT * FROM outbound WHERE state = \'accepted\'')) {
      if (!open.has(ob.delegation)) continue
      try {
        const { d } = await this.parentOf(ob)
        const before = this.one<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE request = ?', ob.request)!.n
        const out = this.ensureOperations(cfg, d)
        const after = this.one<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE request = ?', ob.request)!.n
        if (after > before || out.some(n => n.includes('not sent'))) notes.push(...out.filter(n => after > before || n.includes('not sent')))
      } catch (e) { notes.push(`${ob.request}: operations not checked — ${(e as Error).message}`) }
    }
    return [...new Set(notes)]
  }

  // Messages that expect an answer and have none, posted again with their
  // stable id on a bounded backoff. A request of a delegation closed here
  // is not retried (nothing waits on it); operations are, until answered.
  private retryDue(): string[] {
    const notes: string[] = []
    const open = new Set(this.delegate.rows().filter(r => r.state === 'open').map(r => r.uid))
    const due = this.all<OutboxRow & { delegation: string | null }>(`SELECT o.*, b.delegation FROM outbox o LEFT JOIN outbound b ON b.request = o.request
      WHERE o.expects = 1 AND o.answered IS NULL AND o.state = 'sent' AND o.next_retry IS NOT NULL AND o.next_retry <= ? ORDER BY o.next_retry LIMIT ?`, this.now(), REPOSTS_PER_PASS * 2)
    let n = 0
    for (const r of due) {
      if (r.type === 'request' && r.delegation && !open.has(r.delegation)) { this.run('UPDATE outbox SET next_retry = NULL WHERE id = ?', r.id); continue }
      if (n >= REPOSTS_PER_PASS) break
      if (!this.requeue(r.id, { repost: true })) { this.run('UPDATE outbox SET next_retry = NULL WHERE id = ?', r.id); continue }
      notes.push(`${r.id}: no answer since ${r.sent}; posted again (${r.reposts + 1}${r.reposts ? ' reposts' : ' repost'})`)
      n++
    }
    return notes
  }

  // A state query per bound remote delegation, on its interval: open ones
  // every QUERY_OPEN_MS, closed ones whose run was last seen unfinished
  // every QUERY_CLOSED_MS, never after it was seen finished.
  private async queryDue(cfg: PeerConfig): Promise<string[]> {
    const notes: string[] = []
    const index = new Map(this.delegate.rows().map(r => [r.uid, r.state]))
    for (const ob of this.all<OutboundRow>('SELECT * FROM outbound WHERE state = \'accepted\' AND remote_run IS NOT NULL')) {
      const peer = peerOf(cfg, ob.peer)
      if (!peer || !this.capabilitiesOf(peer.instance).capabilities.includes('query')) continue
      const seen = ob.observed ? JSON.parse(ob.observed) as RunSnapshot : null
      const finished = !!seen && !seen.attempt && !seen.corrections.length && (seen.cancelled || seen.execution === 'completed')
      const last = Math.max(ob.query_at ? Date.parse(ob.query_at) : 0, ob.heard ? Date.parse(ob.heard) : 0)
      if (this.ms() - last < QUERY_OPEN_MS || (index.get(ob.delegation) === 'closed' && finished)) continue
      try {
        const { rec, d } = await this.parentOf(ob)
        // Open: judged or closed delegations are only observed, less often, until the run is seen finished.
        const open = isOpenDelegation(d) && !rec.cancelled
        if (!open && finished) continue
        if (!open && this.ms() - last < QUERY_CLOSED_MS) continue
        const have = [...this.have(ob.request, rec, d)].filter(f => Number(f.split(':')[0]) > ob.verified).sort((x, y) => Number(x.split(':')[0]) - Number(y.split(':')[0]))
        const unacknowledged = this.all<{ id: string }>('SELECT id FROM outbox WHERE request = ? AND expects = 1 AND answered IS NULL AND type != \'request\' ORDER BY created LIMIT 50', ob.request).map(r => r.id)
        const k = ob.queries + 1
        let list = have, to: number | null = null
        const build = () => envelope('query', { id: `${ob.request}:query:${k}`, from: cfg.self, to: ob.peer, request: ob.request, body: { run: ob.remote_run!, facts: { from: ob.verified, to, have: list }, unacknowledged, capabilities: [...CAPABILITIES] } })
        while (PeerStore.wire(build()).length > MAX_MESSAGE && list.length) { list = list.slice(0, Math.floor(list.length / 2)); to = list.length ? Number(list.at(-1)!.split(':')[0]) : ob.verified }
        const q = build()
        this.tx(() => {
          this.queue({ id: q.id, peer: ob.peer, request: ob.request, type: 'query', envelope: q })
          this.run('UPDATE outbound SET queries = ?, query_at = ? WHERE request = ?', k, this.now(), ob.request)
        })
        notes.push(`${ob.request}: state asked of ${peer.label} (${q.id})`)
      } catch (e) { notes.push(`${ob.request}: no query — ${(e as Error).message}`) }
    }
    return notes
  }
}

export interface LinkView {
  request: string; peer: string; route: PeerRoute | null; delivery: string; acceptance: string; remoteRun: string | null; remoteUrl: string | null; problem: string | null
  operations: { id: string; kind: string; delivery: string; outcome: string }[]
  observed: (RunSnapshot & { at: string | null; told?: string }) | null
  freshness: string; waiting: string[]; kept: string[]; capabilities: string[]
}
