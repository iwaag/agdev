// Cross-installation delegation (improve_multinodes p1, docs/peers.md): the
// peer configuration, the link envelope and who may send what. Pure: no
// files, stores or clocks. The file layer is server/peerlink.ts.
//
// cluster_teamwork p5: envelopes travel over HTTP only, authenticated by the
// bearer credential the receiving installation issued to the sender; the
// envelope's claimed identity must merely agree with it. The former Zulip
// link (a fenced `agdev-peer` block in a post of a shared realm) is retired;
// rows it left in the journal are history (`route` zulip) and are only read.
import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.ts'
import { ID_PATTERN, INSTANCE_ID } from './model.ts'

export const PEER_PROTOCOL = 'peer/1'
export const PEER_PROTOCOL_2 = 'peer/2'
export const PEER_PARENTAGE = ['parent', 'child', 'none'] as const
export type Parentage = typeof PEER_PARENTAGE[number]

// One other installation as this one knows it.
// - `parentage`: the installations' operational relationship — `parent`
//   means that peer is this installation's parent. It grants nothing by
//   itself: requests are `accept`, updates and recovery are not in P1.
// - `accept`: `<project>/<workflow>` this installation runs for that peer.
// - `request`: `<project>/<workflow>` this installation may ask of it.
// - `grant` (p3, docs/management.md): administrative access this
//   installation gives that peer (`observe`, `update`); `update` only to the
//   operational parent and only with `observe`.
// - `manage` (p3): administrative access this installation may use on that
//   peer; `update` only toward a child.
export const ADMIN_ACCESS = ['observe', 'update'] as const
export type AdminAccess = typeof ADMIN_ACCESS[number]
// cluster_teamwork p2 (HTTP delivery): `endpoint` is the peer's WFE API base
// (…/wfe/api), required; `credential` the file holding the bearer token that
// peer issued to this installation; p4 `manageCredential` the file of the
// management-scope token. Work and management both travel over HTTP.
// `PeerRoute` is the route a journal row travelled: `zulip` only on rows the
// retired link left (history), `http` for everything since.
export type PeerRoute = 'zulip' | 'http'
export interface PeerEntry { instance: string; label: string; parentage: Parentage; accept: string[]; request: string[]; grant: AdminAccess[]; manage: AdminAccess[]; endpoint: string; credential: string | null; manageCredential: string | null }
// `directory`: the cluster directory this installation consults (Step 4).
export interface PeerConfig { self: string; viewBase: string | null; peers: PeerEntry[]; directory: string | null }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const TARGET = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/

// peers.json → a checked configuration, or every problem found.
export function parsePeerConfig(raw: unknown, selfId: string | null): { config: PeerConfig } | { problems: string[] } {
  const problems: string[] = []
  if (!isObj(raw)) return { problems: ['peers.json is not an object'] }
  if (raw.version !== 1) problems.push(`peers.json version is ${String(raw.version)}; this release reads version 1`)
  const self = typeof raw.self === 'string' ? raw.self : ''
  if (!INSTANCE_ID.test(self)) problems.push('self is this installation\'s instance id')
  else if (selfId && self !== selfId) problems.push(`self is ${self}, but this installation is ${selfId}`)
  if (raw.link !== undefined && raw.link !== null) problems.push('link: the Zulip link is retired (peers are reached over HTTP); remove the link block')
  const peers: PeerEntry[] = []
  const seen = new Set<string>()
  for (const [i, p] of (Array.isArray(raw.peers) ? raw.peers : []).entries()) {
    const at = `peers[${i}]`
    if (!isObj(p)) { problems.push(`${at} is not an object`); continue }
    const instance = typeof p.instance === 'string' ? p.instance : ''
    if (!INSTANCE_ID.test(instance)) problems.push(`${at}.instance is an instance id`)
    if (instance === self) problems.push(`${at} is this installation`)
    if (seen.has(instance)) problems.push(`${at}: ${instance} is listed twice`)
    seen.add(instance)
    if (p.sender !== undefined && p.sender !== null) problems.push(`${at}.sender: Zulip senders are retired (the peer is authenticated by its HTTP credential); remove it`)
    // `route` / `manageRoute` may still say http; nothing else is a route now.
    for (const k of ['route', 'manageRoute'] as const) if (p[k] !== undefined && p[k] !== 'http') problems.push(`${at}.${k} is ${String(p[k])}; peers are reached over HTTP only (route http, or leave it out)`)
    const endpoint = p.endpoint ?? null
    if (typeof endpoint !== 'string' || !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(endpoint)) problems.push(`${at}.endpoint is the peer's WFE API base URL (http://host:port/wfe/api)`)
    const credential = p.credential ?? null
    if (credential !== null && (typeof credential !== 'string' || !credential)) problems.push(`${at}.credential is the file of the token that peer issued to this installation`)
    const manageCredential = p.manageCredential ?? null
    if (manageCredential !== null && (typeof manageCredential !== 'string' || !manageCredential)) problems.push(`${at}.manageCredential is the file of the management token that peer issued to this installation`)
    const parentage = (p.parentage ?? 'none') as Parentage
    if (!(PEER_PARENTAGE as readonly string[]).includes(parentage)) problems.push(`${at}.parentage is ${PEER_PARENTAGE.join(' | ')}`)
    const list = (k: 'accept' | 'request') => {
      const v = p[k] ?? []
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !TARGET.test(x))) { problems.push(`${at}.${k} is a list of <project>/<workflow>`); return [] }
      return v as string[]
    }
    const admin = (k: 'grant' | 'manage'): AdminAccess[] => {
      const v = p[k] ?? []
      if (!Array.isArray(v) || v.some(x => !(ADMIN_ACCESS as readonly string[]).includes(x as string))) { problems.push(`${at}.${k} is a list of ${ADMIN_ACCESS.join(', ')}`); return [] }
      return [...new Set(v as AdminAccess[])].sort()
    }
    const grant = admin('grant'), manage = admin('manage')
    if (grant.includes('update') && parentage !== 'parent') problems.push(`${at}.grant: update is granted only to this installation's operational parent (parentage parent)`)
    if (grant.includes('update') && !grant.includes('observe')) problems.push(`${at}.grant: update needs observe too (the parent must be able to see the outcome)`)
    if (manage.includes('update') && parentage !== 'child') problems.push(`${at}.manage: update is asked only of a child (parentage child)`)
    peers.push({ instance, label: typeof p.label === 'string' && p.label ? p.label : instance, parentage, accept: list('accept'), request: list('request'), grant, manage, endpoint: typeof endpoint === 'string' ? endpoint : '', credential: credential as string | null, manageCredential: manageCredential as string | null })
  }
  const parents = peers.filter(p => p.parentage === 'parent')
  if (parents.length > 1) problems.push(`more than one operational parent (${parents.map(p => p.instance).join(', ')}); an installation has at most one`)
  const directory = raw.directory ?? null
  if (directory !== null && (typeof directory !== 'string' || !/^https?:\/\/\S+$/.test(directory))) problems.push('directory is the URL of the cluster directory to consult (…/wfe/api/cluster/directory)')
  if (problems.length) return { problems }
  return { config: { self, viewBase: typeof raw.viewBase === 'string' && raw.viewBase ? raw.viewBase : null, peers, directory: directory as string | null } }
}

export const peerOf = (cfg: PeerConfig, instance: string) => cfg.peers.find(p => p.instance === instance)

// ---- identities -------------------------------------------------------------------------

// A request's identity: stable for the delegation's life on the
// requesting installation, so every redelivery is the same request.
export const requestIdOf = (from: string, delegationUid: string) => `r-${createHash('sha256').update(`${from}\n${delegationUid}`).digest('hex').slice(0, 24)}`
export const REQUEST_ID = /^r-[0-9a-f]{24}$/
// The management channel of one parent–child pair (p3): addressed by
// installation, not by delegation.
export const manageIdOf = (parent: string, child: string) => `m-${createHash('sha256').update(`${parent}\n${child}\nmanage`).digest('hex').slice(0, 24)}`
export const MANAGE_ID = /^m-[0-9a-f]{24}$/
export const UPDATE_OP_ID = /^(m-[0-9a-f]{24}):update:([0-9]{1,6})$/
export const COMMIT = /^[0-9a-f]{40}$/
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// ---- envelopes ---------------------------------------------------------------------------

export interface RequestBody {
  delegation: string // the requesting delegation's uid
  parent: { project: string; workflow: string; run: string; creation: string; node: string }
  target: { project: string; workflow: string }
  accepts: 'person' | 'parent'
  requester: string
  onBehalfOf: string | null
  request: { text: string; sha256: string }
  original: { text: string; sha256: string } | null
  capabilities?: string[] // p2: what the requesting installation applies
}
export interface AcceptedBody { run: { uid: string; project: string; workflow: string; run: string; created: string; url: string | null }; capabilities?: string[] }
export interface DeclinedBody { code: string; reason: string }
// `receipt` is the requesting side's relay receipt for the fact
// (`delegation:<delegation uid>:<child seq>:<type>`, shared/delegation.ts).
export interface EventBody { receipt: string; event: Record<string, unknown> }

// ---- peer/2 (improve_multinodes p2): operations, receipts, state, replay ------------
// Operations from the requesting side to the run it was given; `run` is
// that run's uid as accepted (null: a cancellation before acceptance).
export interface AnswerBody { run: string; question: string; answer: number; text: string; from: string; by: string }
export interface InstructionBody { run: string; instruction: number; text: string; from: string; by: string }
export interface CorrectionBody { run: string; revision: number; result: { seq: number; manifest: string | null }; instruction: string; reason: string; from: string; by: string }
export interface CancelBody { run: string | null; reason: string; by: string }
// `facts.have`: the facts of the run the asking side holds, as
// `<child seq>:<type>`, above `facts.from` (its verified position).
export interface QueryBody { run: string; facts: { from: number; to: number | null; have: string[] }; unacknowledged: string[]; capabilities: string[] }
export const RECEIPT_OUTCOMES = ['applied', 'requested', 'refused'] as const
export interface ReceiptBody { op: string; kind: OperationKind; payload: string; outcome: typeof RECEIPT_OUTCOMES[number]; code: string | null; reason: string; seq: number | null; capabilities: string[] }
export interface RunSnapshot { uid: string; seq: number; execution: string; cancelled: boolean; attempt: boolean; hold: string | null; questions: string[]; corrections: string[] }
export interface StateBody {
  query: string; at: string; run: RunSnapshot | null
  facts: { from: number; through: number; all: string[]; replayed: string[]; pending: string[]; more: boolean }
  ops: Record<string, 'applied' | 'requested' | 'refused' | 'unknown'>
  capabilities: string[]
}
// p3: how the sender sees its relationship with the receiver.
// `you`: the parentage the sender gives the receiver; `ancestry`: the
// sender's chain of operational parents, nearest first, as it knows it.
export interface Relation { you: Parentage; grants: AdminAccess[]; manages: AdminAccess[]; ancestry: string[] }
// p4: how the sender names itself for people (docs/management.md, Display
// identity). Descriptive only: it grants nothing and authenticates nothing —
// the receiver binds it to the sender's configured instance.
export interface PeerIdentity { name: string | null; host: string | null; dashboard: string | null }
export const IDENTITY_LIMITS = { name: 64, host: 253, dashboard: 300 } as const
export interface HelloBody { capabilities: string[]; relation?: Relation; identity?: PeerIdentity }

// ---- management (improve_multinodes p3, docs/management.md) ------------------------
export interface UpdateBody { target: string; commit: string; reason: string; requester: { instance: string; actor: string; run: string | null; attempt: string | null } }
export const UPDATE_OUTCOMES = ['accepted', 'refused'] as const
export interface UpdateReceiptBody { op: string; payload: string; outcome: typeof UPDATE_OUTCOMES[number]; code: string | null; reason: string; update: string | null; capabilities: string[] }
// The lifecycle's states; terminal ones end the operation.
export const LIFECYCLE_STATES = ['requested', 'awaiting-requester', 'building', 'draining', 'stopping', 'starting', 'succeeded', 'failed', 'refused'] as const
export const LIFECYCLE_TERMINAL = ['succeeded', 'failed', 'refused'] as const
export interface UpdateHealth { healthy: boolean | null; api: string | null; instance: string | null; cli: string | null; observer: string | null; running: Record<string, boolean> }
export interface UpdateStatusBody {
  op: string; update: string | null; state: string; terminal: boolean; history: { state: string; at: string }[]; h: number
  release: string | null; previous: string | null; health: UpdateHealth | null; notStarted: Record<string, string> | null; reason: string; at: string
}
export interface ObserveBody { ops: string[]; capabilities: string[] }
// The lifecycle-owned status record of an installation, as sampled.
export interface InstallationSample {
  instance: string; at: string; release: { active: string | null }; serving: { release: string | null; instance: string | null } | null
  services: Record<string, 'running' | 'stopped' | 'unknown'>; draining: boolean; update: { id: string; state: string; since: string } | null; tool: string | null
}
export interface InstallationBody {
  query: string; at: string; refused: string | null; sample: InstallationSample | null; sampleAge: number | null; problem: string | null
  ops: Record<string, UpdateStatusBody | { op: string; state: 'unknown' | 'admitting' | 'refused'; code?: string | null; reason?: string }>
  relation: Relation | null; capabilities: string[]
}
export const MANAGE_TYPES = ['update', 'update-receipt', 'update-status', 'observe', 'installation'] as const
export const isManageType = (t: string) => (MANAGE_TYPES as readonly string[]).includes(t)
export const inverseParentage = (p: Parentage): Parentage => p === 'parent' ? 'child' : p === 'child' ? 'parent' : 'none'

// Enrollment of one peer, from this side's configuration and the relation
// the peer last told (null: not heard). Pure; docs/management.md.
export type Enrollment = 'none' | 'pending' | 'partial' | 'mutual' | 'contradictory' | 'cycle'
export function enrollmentOf(self: string, peer: PeerEntry, heard: Relation | null, capabilities: string[], ownAncestry: string[]): { state: Enrollment; detail: string } {
  if (peer.parentage === 'none' && !peer.grant.length && !peer.manage.length) return { state: 'none', detail: 'no operational relationship' }
  if (peer.parentage === 'child' && ownAncestry.includes(peer.instance)) return { state: 'cycle', detail: `${peer.instance} is configured as this installation's child but is among its ancestors (${ownAncestry.join(' → ')})` }
  if (heard && peer.parentage === 'parent' && heard.ancestry.includes(self)) return { state: 'cycle', detail: `${peer.instance} is configured as this installation's parent but says this installation is among its ancestors (${heard.ancestry.join(' → ')})` }
  if (!heard) return { state: 'pending', detail: 'the peer has not told its side of the relationship (not heard since, or a release without management)' }
  if (heard.you !== inverseParentage(peer.parentage)) return { state: 'contradictory', detail: `this installation says the peer is its ${peer.parentage === 'none' ? 'peer (no parentage)' : peer.parentage}, the peer says this installation is its ${heard.you === 'none' ? 'peer (no parentage)' : heard.you}` }
  // What the managing side asks must be what the managed side grants.
  const asked = peer.parentage === 'parent' ? heard.manages : peer.manage
  const given = peer.parentage === 'parent' ? peer.grant : heard.grants
  const lacking = asked.filter(a => !given.includes(a))
  const unspoken = peer.parentage === 'parent' ? [] : peer.manage.filter(a => !capabilities.includes(a))
  if (lacking.length) return { state: 'partial', detail: `${peer.parentage === 'parent' ? 'the peer manages' : 'this installation manages'} ${lacking.join(', ')}, which ${peer.parentage === 'parent' ? 'this installation does not grant' : 'the peer does not grant'}` }
  if (unspoken.length) return { state: 'partial', detail: `the peer's release does not apply ${unspoken.join(', ')}` }
  return { state: 'mutual', detail: `${peer.parentage === 'child' ? 'child' : peer.parentage === 'parent' ? 'parent' : 'peer'}; ${peer.parentage === 'parent' ? `granted ${peer.grant.join(', ') || 'nothing'}` : `manages ${peer.manage.join(', ') || 'nothing'}`}` }
}
// A fact the sending side cannot carry within the message bound: named,
// never truncated, never pretended delivered.
export interface ProblemBody { fact: string; type: string; size: number; limit: number; url: string | null }

export const OPERATION_KINDS = ['answer', 'instruction', 'correction', 'cancel'] as const
export type OperationKind = typeof OPERATION_KINDS[number]
// What this release applies when another installation sends it.
// `identity` (p4): it records the display identity a hello carries.
export const CAPABILITIES = ['answer', 'instruction', 'correction', 'cancel', 'query', 'observe', 'update', 'identity'] as const
// Messages of the link itself, not of one request (hello).
export const LINK_REQUEST = 'r-000000000000000000000000'
export const factId = (seq: number, type: string) => `${seq}:${type}`
export const FACT_ID = /^[0-9]{1,9}:[a-z-]{1,24}$/
export const OP_ID = /^(r-[0-9a-f]{24}):(answer|instruction|correction|cancel)(?::([0-9]{1,6}))?$/

type B<T extends string, Body> = { type: T } & EnvelopeBase & { body: Body }
export type Envelope =
  | B<'request', RequestBody> | B<'accepted', AcceptedBody> | B<'declined', DeclinedBody> | B<'event', EventBody>
  | B<'answer', AnswerBody> | B<'instruction', InstructionBody> | B<'correction', CorrectionBody> | B<'cancel', CancelBody>
  | B<'query', QueryBody> | B<'receipt', ReceiptBody> | B<'state', StateBody> | B<'hello', HelloBody> | B<'problem', ProblemBody>
  | B<'update', UpdateBody> | B<'update-receipt', UpdateReceiptBody> | B<'update-status', UpdateStatusBody> | B<'observe', ObserveBody> | B<'installation', InstallationBody>
interface EnvelopeBase { agdev: typeof PEER_PROTOCOL | typeof PEER_PROTOCOL_2; id: string; from: string; to: string; request: string; payload: string }
export type Operation = Extract<Envelope, { type: OperationKind }>

// P1's types travel as peer/1, so a P1 installation still reads them;
// everything P2 adds is peer/2, which a P1 installation refuses unapplied.
export const ENVELOPE_TYPES = ['request', 'accepted', 'declined', 'event'] as const
export const ENVELOPE_TYPES_2 = ['answer', 'instruction', 'correction', 'cancel', 'query', 'receipt', 'state', 'hello', 'problem', ...MANAGE_TYPES] as const
export const protocolOf = (type: Envelope['type']) => (ENVELOPE_TYPES as readonly string[]).includes(type) ? PEER_PROTOCOL : PEER_PROTOCOL_2

// The payload identity: what a reuse of the same id must agree with.
export const payloadOf = (type: Envelope['type'], body: unknown) => `sha256:${sha256(canonicalJson({ type, body }))}`

export function envelope<T extends Envelope['type']>(type: T, o: { id: string; from: string; to: string; request: string; body: Extract<Envelope, { type: T }>['body'] }): Extract<Envelope, { type: T }> {
  return { agdev: protocolOf(type), type, id: o.id, from: o.from, to: o.to, request: o.request, payload: payloadOf(type, o.body), body: o.body } as Extract<Envelope, { type: T }>
}

// The envelope of a post the retired Zulip link stored (a journal row with
// route zulip): its fenced `agdev-peer` JSON block. History only — read
// where a stored row is consulted, never produced.
const FENCE = '```agdev-peer'
export function storedPostEnvelope(content: string): { envelope: Envelope } | { problem: string } {
  const at = content.indexOf(`${FENCE}\n`)
  if (at < 0) return { problem: 'no agdev-peer block' }
  const end = content.indexOf('\n```', at + FENCE.length + 1)
  if (end < 0) return { problem: 'the agdev-peer block is not closed' }
  let v: unknown
  try { v = JSON.parse(content.slice(at + FENCE.length + 1, end)) } catch (e) { return { problem: `the agdev-peer block is not JSON: ${(e as Error).message}` } }
  return parseEnvelope(v)
}

// An envelope as an object (an HTTP body): shape only.
export function parseEnvelope(v: unknown): { envelope: Envelope } | { problem: string } {
  if (!isObj(v)) return { problem: 'the envelope is not an object' }
  if (v.agdev !== PEER_PROTOCOL && v.agdev !== PEER_PROTOCOL_2) return { problem: `protocol ${String(v.agdev)} is not supported (this release speaks ${PEER_PROTOCOL} and ${PEER_PROTOCOL_2})` }
  const known = [...ENVELOPE_TYPES, ...ENVELOPE_TYPES_2] as readonly string[]
  if (!known.includes(v.type as string)) return { problem: `unknown envelope type ${String(v.type)}` }
  if (v.agdev !== protocolOf(v.type as Envelope['type'])) return { problem: `${String(v.type)} is a ${protocolOf(v.type as Envelope['type'])} message, not ${String(v.agdev)}` }
  if (![v.id, v.from, v.to, v.request, v.payload].every(x => typeof x === 'string' && x)) return { problem: 'the envelope lacks id, from, to, request or payload' }
  if (isManageType(v.type as string) ? !MANAGE_ID.test(v.request as string) : !REQUEST_ID.test(v.request as string)) return { problem: `request ${String(v.request)} is not a ${isManageType(v.type as string) ? 'management' : 'request'} id` }
  if (!isObj(v.body)) return { problem: 'the envelope has no body' }
  if (payloadOf(v.type as Envelope['type'], v.body) !== v.payload) return { problem: 'the payload digest does not match the body' }
  const b = v.body
  if (v.type === 'request') {
    const r = b as unknown as RequestBody
    if (!isObj(r.target) || !ID_PATTERN.test(String(r.target.project)) || !ID_PATTERN.test(String(r.target.workflow))) return { problem: 'request.target is {project, workflow}' }
    if (!isObj(r.request) || typeof r.request.text !== 'string' || sha256(r.request.text) !== r.request.sha256) return { problem: 'the request text does not match its hash' }
    if (r.original !== null && (!isObj(r.original) || typeof r.original.text !== 'string' || sha256(r.original.text) !== r.original.sha256)) return { problem: 'the original text does not match its hash' }
    if (typeof r.delegation !== 'string' || !isObj(r.parent)) return { problem: 'request names its delegation and parent' }
  }
  if (v.type === 'accepted' && (!isObj((b as unknown as AcceptedBody).run) || typeof (b as unknown as AcceptedBody).run.uid !== 'string')) return { problem: 'accepted names the run' }
  if (v.type === 'event' && (typeof (b as unknown as EventBody).receipt !== 'string' || !isObj((b as unknown as EventBody).event))) return { problem: 'event carries receipt and event' }
  const shape = shapeProblem(v.type as Envelope['type'], v.id as string, v.request as string, b)
  if (shape) return { problem: shape }
  return { envelope: v as unknown as Envelope }
}

const str = (x: unknown) => typeof x === 'string'
const int = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0
const strs = (x: unknown) => Array.isArray(x) && x.every(str)
// eslint-disable-next-line no-control-regex
const plain = (x: unknown, max: number) => x === null || (typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x))
export const identityOk = (r: unknown): r is PeerIdentity => isObj(r) && plain(r.name, IDENTITY_LIMITS.name) && plain(r.host, IDENTITY_LIMITS.host) && plain(r.dashboard, IDENTITY_LIMITS.dashboard)
  && (r.dashboard === null || /^https?:\/\/[^\s/@]+(\/[^\s]*)?$/.test(r.dashboard as string))
const relationOk = (r: unknown) => isObj(r) && (PEER_PARENTAGE as readonly string[]).includes(r.you as string) && strs(r.grants) && strs(r.manages) && strs(r.ancestry) && (r.ancestry as string[]).length <= 8
// The shape of a peer/2 body, and its id's agreement with it.
function shapeProblem(type: Envelope['type'], id: string, request: string, b: Record<string, unknown>): string | null {
  if ((OPERATION_KINDS as readonly string[]).includes(type)) {
    const m = OP_ID.exec(id)
    if (!m || m[1] !== request || m[2] !== type) return `${type} ${id} is not <request>:${type}[:<n>]`
    const n = type === 'answer' ? b.answer : type === 'instruction' ? b.instruction : type === 'correction' ? b.revision : undefined
    if (type === 'cancel' ? m[3] !== undefined : !(int(n) && String(n) === m[3])) return `${type} ${id} does not agree with its number`
  }
  switch (type) {
    case 'answer': return str(b.run) && str(b.question) && str(b.text) && str(b.from) && str(b.by) ? null : 'answer is {run, question, answer, text, from, by}'
    case 'instruction': return str(b.run) && str(b.text) && str(b.from) && str(b.by) ? null : 'instruction is {run, instruction, text, from, by}'
    case 'correction': return str(b.run) && isObj(b.result) && int(b.result.seq) && (b.result.manifest === null || str(b.result.manifest)) && str(b.instruction) && str(b.reason) && str(b.from) && str(b.by) ? null : 'correction is {run, revision, result {seq, manifest}, instruction, reason, from, by}'
    case 'cancel': return (b.run === null || str(b.run)) && str(b.reason) && str(b.by) ? null : 'cancel is {run, reason, by}'
    case 'query': return str(b.run) && id.startsWith(`${request}:query:`) && isObj(b.facts) && int(b.facts.from) && (b.facts.to === null || int(b.facts.to)) && strs(b.facts.have) && strs(b.unacknowledged) && strs(b.capabilities) ? null : 'query is {run, facts {from, have}, unacknowledged, capabilities}'
    case 'receipt': return str(b.op) && OP_ID.test(b.op as string) && id === `${b.op as string}:receipt` && (OPERATION_KINDS as readonly string[]).includes(b.kind as string) && str(b.payload) && (RECEIPT_OUTCOMES as readonly string[]).includes(b.outcome as string) && (b.code === null || str(b.code)) && str(b.reason) && (b.seq === null || int(b.seq)) && strs(b.capabilities) ? null : 'receipt is {op, kind, payload, outcome, code, reason, seq, capabilities}, id <op>:receipt'
    case 'state': return str(b.query) && id === `${b.query as string}:state` && str(b.at) && (b.run === null || isObj(b.run)) && isObj(b.facts) && strs(b.facts.all) && strs(b.facts.replayed) && strs(b.facts.pending) && int(b.facts.from) && int(b.facts.through) && isObj(b.ops) && strs(b.capabilities) ? null : 'state is {query, at, run, facts, ops, capabilities}, id <query>:state'
    case 'hello': return strs(b.capabilities) && (b.relation === undefined || relationOk(b.relation)) && (b.identity === undefined || identityOk(b.identity)) ? null : 'hello is {capabilities, relation?, identity?}'
    case 'update': {
      const m = UPDATE_OP_ID.exec(id)
      if (!m || m[1] !== request) return `update ${id} is not <management id>:update:<n>`
      const r = b.requester as Record<string, unknown> | undefined
      return str(b.target) && str(b.commit) && str(b.reason) && isObj(r) && str(r.instance) && str(r.actor) && (r.run === null || str(r.run)) && (r.attempt === null || str(r.attempt)) ? null : 'update is {target, commit, reason, requester {instance, actor, run, attempt}}'
    }
    case 'update-receipt': return str(b.op) && UPDATE_OP_ID.test(b.op as string) && id === `${b.op as string}:receipt` && str(b.payload) && (UPDATE_OUTCOMES as readonly string[]).includes(b.outcome as string) && (b.code === null || str(b.code)) && str(b.reason) && (b.update === null || str(b.update)) && strs(b.capabilities) ? null : 'update-receipt is {op, payload, outcome, code, reason, update, capabilities}, id <op>:receipt'
    case 'update-status': return str(b.op) && UPDATE_OP_ID.test(b.op as string) && int(b.h) && id === `${b.op as string}:status:${String(b.h)}` && str(b.state) && typeof b.terminal === 'boolean' && Array.isArray(b.history) && str(b.at) ? null : 'update-status is {op, update, state, terminal, history, h, …}, id <op>:status:<h>'
    case 'observe': return strs(b.ops) && strs(b.capabilities) && /^m-[0-9a-f]{24}:observe:[0-9]{1,9}$/.test(id) ? null : 'observe is {ops, capabilities}, id <management id>:observe:<k>'
    case 'installation': return str(b.query) && id === `${b.query as string}:installation` && str(b.at) && (b.refused === null || str(b.refused)) && (b.sample === null || isObj(b.sample)) && isObj(b.ops) && (b.relation === null || relationOk(b.relation)) && strs(b.capabilities) ? null : 'installation is {query, at, refused, sample, ops, relation, capabilities}, id <observe id>:installation'
    case 'problem': return str(b.fact) && str(b.type) && int(b.size) && int(b.limit) ? null : 'problem is {fact, type, size, limit, url}'
    default: return null
  }
}

// Whether an envelope may be acted on here, from the peer it claims to be
// from (as authenticated) and what it asks.
type Authorized = { ok: true; peer: PeerEntry } | { ok: false; reason: 'own' | 'unauthorized' | 'misaddressed' | 'not-permitted'; detail: string }
function addressed(cfg: PeerConfig, peer: PeerEntry, e: Envelope): Authorized {
  if (e.to !== cfg.self) return { ok: false, reason: 'misaddressed', detail: `addressed to ${e.to}, not ${cfg.self}` }
  if (e.type === 'request' && !peer.accept.includes(`${e.body.target.project}/${e.body.target.workflow}`)) return { ok: false, reason: 'not-permitted', detail: `${peer.label} may not request ${e.body.target.project}/${e.body.target.workflow} here` }
  return { ok: true, peer }
}

// cluster_teamwork p2: an envelope delivered over HTTP. The bearer credential
// authenticates `holder` (the instance this installation issued it to); the
// envelope's claims must agree with it.
export function authorizeHttp(cfg: PeerConfig, holder: string, e: Envelope): Authorized {
  if (e.from === cfg.self) return { ok: false, reason: 'own', detail: 'this installation\'s own message' }
  const peer = peerOf(cfg, holder)
  if (!peer) return { ok: false, reason: 'unauthorized', detail: `the credential's holder ${holder} is no longer a configured peer` }
  if (e.from !== holder) return { ok: false, reason: 'unauthorized', detail: `the credential is ${holder}'s, but the envelope claims ${e.from}` }
  return addressed(cfg, peer, e)
}

// ---- HTTP credentials (cluster_teamwork p2) ----------------------------------------------
// A token the receiving installation (issuer) gives one holder installation:
// `agdev-peer1.<issuer>.<holder>.<64 hex>`. The issuer keeps only its sha256.
// cluster_teamwork p4: a management-scope token is `agdev-manage1.…`. The
// issuer's stored scope is what counts; the prefix keeps a holder from
// installing one kind as the other.
export const CREDENTIAL_SCOPES = ['work', 'manage'] as const
export type CredentialScope = typeof CREDENTIAL_SCOPES[number]
export const TOKEN = /^agdev-(peer|manage)1\.([a-z0-9][a-z0-9-]*-[0-9a-f]{12})\.([a-z0-9][a-z0-9-]*-[0-9a-f]{12})\.([0-9a-f]{64})$/
export const tokenPrefix = (scope: CredentialScope) => scope === 'manage' ? 'agdev-manage1' : 'agdev-peer1'
export const tokenHash = (token: string) => `sha256:${sha256(token)}`
export const tokenFingerprint = (token: string) => sha256(token).slice(0, 12)
export function tokenParts(token: string): { issuer: string; holder: string; scope: CredentialScope } | null {
  const m = TOKEN.exec(token.trim())
  return m ? { issuer: m[2], holder: m[3], scope: m[1] === 'manage' ? 'manage' : 'work' } : null
}
