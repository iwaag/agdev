// Setting up and changing an installation's link relationships
// (improve_multinodes p3, docs/management.md "Setting up and changing the
// relationship"). Every change of <area>/peers.json is a local act of the
// core account: read, change only what was asked, check it as the link
// would read it, write a temporary file and rename it. The previous file is
// kept beside the journal (`.local/peerlink/peers.previous.json`).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN_ACCESS, parsePeerConfig, PEER_PARENTAGE, type AdminAccess, type Parentage } from '../shared/peers.ts'
import { credentialFile, selfInstance, type PeerStore } from './peerlink.ts'
import { RequestError } from './workspace.ts'

type Raw = Record<string, unknown> & { peers?: Record<string, unknown>[] }
export interface PeerChange {
  instance: string; label?: string; parentage?: Parentage
  accept?: string[]; request?: string[]; grant?: AdminAccess[]; manage?: AdminAccess[]
  replaceParent?: string
  // cluster_teamwork p2/p4: where its WFE API is, its work and management credential files.
  endpoint?: string; credential?: string | null; manageCredential?: string | null
}

const file = (area: string) => join(area, 'peers.json')
const journalDir = (area: string) => join(area, '.local', 'peerlink')

export function readRaw(area: string): Raw | null {
  if (!existsSync(file(area))) return null
  try { return JSON.parse(readFileSync(file(area), 'utf8')) as Raw } catch (e) { throw new RequestError(409, `${file(area)} is not JSON (${(e as Error).message}); fix or move it first — nothing was changed`, { code: 'peer-config' }) }
}

// Checked as the link reads it, then written atomically.
export function writeRaw(area: string, raw: Raw): { changed: boolean } {
  const parsed = parsePeerConfig(raw, selfInstance(area))
  if ('problems' in parsed) throw new RequestError(409, `the result would not be a valid peers.json: ${parsed.problems.join('; ')}; nothing was changed`, { code: 'peer-config' })
  const text = JSON.stringify(raw, null, 2) + '\n'
  const before = existsSync(file(area)) ? readFileSync(file(area), 'utf8') : null
  if (before === text) return { changed: false }
  mkdirSync(journalDir(area), { recursive: true })
  if (before !== null) writeFileSync(join(journalDir(area), 'peers.previous.json'), before)
  const tmp = join(area, `.peers.json.${process.pid}.tmp`)
  writeFileSync(tmp, text, { mode: before !== null ? statSync(file(area)).mode & 0o777 : 0o640 })
  renameSync(tmp, file(area))
  return { changed: true }
}

// One peer entry changed (or added); every other entry and field kept.
export function applyChange(raw: Raw, c: PeerChange): string[] {
  const notes: string[] = []
  const peers = (raw.peers ??= [])
  if (c.parentage && !(PEER_PARENTAGE as readonly string[]).includes(c.parentage)) throw new RequestError(400, `--parentage is ${PEER_PARENTAGE.join(' | ')}`)
  for (const k of ['grant', 'manage'] as const) if (c[k]?.some(a => !(ADMIN_ACCESS as readonly string[]).includes(a))) throw new RequestError(400, `--${k} is a list of ${ADMIN_ACCESS.join(', ')}`)
  let p = peers.find(x => x.instance === c.instance)
  if (!p) {
    if (!c.endpoint) throw new RequestError(400, `${c.instance} is a new peer: give --endpoint (its WFE API) and --label`)
    p = { instance: c.instance, label: c.label ?? c.instance, parentage: 'none', accept: [], request: [] }
    peers.push(p)
    notes.push(`added ${c.instance}`)
  }
  if (c.parentage === 'parent') {
    const other = peers.find(x => x !== p && x.parentage === 'parent')
    if (other && c.replaceParent !== other.instance) throw new RequestError(409, `${String(other.instance)} is this installation's operational parent; replacing it needs --replace-parent ${String(other.instance)} (its update/observe grants and parentage are removed, its work permissions stay). Nothing was changed`, { code: 'peer-parent' })
    if (other) {
      other.parentage = 'none'; other.grant = []
      notes.push(`${String(other.instance)} is no longer the parent; its grants were removed (accept/request kept)`)
    }
  } else if (c.replaceParent) throw new RequestError(400, '--replace-parent goes with --parentage parent')
  const set = <K extends keyof PeerChange>(k: K, field = k as string) => {
    if (c[k] === undefined) return
    const before = JSON.stringify(p![field] ?? null)
    p![field] = c[k] as unknown
    if (JSON.stringify(c[k]) !== before) notes.push(`${c.instance}.${field}: ${before} → ${JSON.stringify(c[k])}`)
  }
  set('label'); set('parentage'); set('accept'); set('request'); set('grant'); set('manage'); set('endpoint'); set('credential'); set('manageCredential')
  for (const k of ['credential', 'manageCredential'] as const) if (p[k] === null) delete p[k]
  // Administrative access that the new parentage no longer allows is removed, said so.
  const parentage = p.parentage as Parentage
  const grant = (p.grant ?? []) as AdminAccess[], manage = (p.manage ?? []) as AdminAccess[]
  if (parentage !== 'parent' && grant.includes('update') && c.grant === undefined) { p.grant = grant.filter(a => a !== 'update'); notes.push(`${c.instance}.grant: update removed (only the parent may update)`) }
  if (parentage !== 'child' && manage.includes('update') && c.manage === undefined) { p.manage = manage.filter(a => a !== 'update'); notes.push(`${c.instance}.manage: update removed (only a child is updated)`) }
  return notes
}

// cluster_teamwork p2: the cluster directory this installation consults (null: none).
export function setDirectory(area: string, url: string | null): { notes: string[]; changed: boolean } {
  const raw = readRaw(area) ?? fresh(area)
  const before = raw.directory ?? null
  if (url === null) delete raw.directory
  else raw.directory = url
  return { notes: before === url ? [] : [`directory: ${JSON.stringify(before)} → ${JSON.stringify(url)}`], ...writeRaw(area, raw) }
}

// A new peers.json (none yet): this installation and no peers.
function fresh(area: string): Raw {
  const self = selfInstance(area)
  if (!self) throw new RequestError(409, `${join(area, 'instance.json')} names no instance id: this area is not initialized (agdevctl init / area-init); nothing was changed`, { code: 'peer-config' })
  return { version: 1, self, peers: [] }
}

export function setPeer(area: string, c: PeerChange): { notes: string[]; changed: boolean } {
  const existed = readRaw(area)
  const raw = existed ?? fresh(area)
  const notes = [...(existed ? [] : [`${file(area)} created for ${String(raw.self)}`]), ...applyChange(raw, c)]
  return { notes, ...writeRaw(area, raw) }
}

// Administrative relationship ended; ordinary work permissions kept unless
// the entry is removed. Admitted updates are the lifecycle's and continue.
export function unlinkPeer(area: string, store: PeerStore, instance: string, o: { remove?: boolean; force?: boolean } = {}): { notes: string[]; changed: boolean } {
  const raw = readRaw(area)
  const p = raw?.peers?.find(x => x.instance === instance)
  if (!raw || !p) throw new RequestError(404, `${instance} is not in ${file(area)}`, { code: 'peer-unknown' })
  const notes: string[] = []
  const inflight = store.all<{ id: string; state: string; lifecycle: string | null }>('SELECT id, state, lifecycle FROM mops WHERE peer = ? AND dir = \'in\' AND state IN (\'admitting\', \'accepted\') AND (status IS NULL OR json_extract(status, \'$.terminal\') = 0)', instance)
  for (const r of inflight) notes.push(`${r.id} (lifecycle ${r.lifecycle}) was admitted and continues; its statuses are still told to ${instance}`)
  if (o.remove) {
    const open = store.all<{ request: string }>('SELECT request FROM outbound WHERE peer = ? AND state != \'declined\' UNION SELECT request FROM inbound WHERE peer = ? AND state IN (\'received\', \'accepted\')', instance, instance)
    if (open.length && !o.force) throw new RequestError(409, `${instance} has requests in this link journal (${open.map(r => r.request).slice(0, 5).join(', ')}); removing the entry stops their messages from being read. Unlink without --remove, or add --force. Nothing was changed`, { code: 'peer-open' })
    raw.peers = raw.peers!.filter(x => x !== p)
    notes.push(`removed ${instance} from peers.json`)
  } else {
    p.parentage = 'none'; p.grant = []; p.manage = []
    notes.push(`${instance}: parentage none, no grants, no management; accept/request kept`)
  }
  return { notes, ...writeRaw(area, raw) }
}

// What is verified now, per peer — never more than what the peer told.
export interface PeerCheck { instance: string; label: string; heard: string | null; speaks: string[]; enrollment: { state: string; detail: string }; complete: boolean; http: { endpoint: string; credential: boolean; last: { ok: boolean; at: string; error: string | null } | null; state: 'no-credential' | 'not-tried' | 'ok' | 'failing' } | null }
// The parent shown on Home (site.json, from instance.toml [display.parent]) is
// display only; it is compared with the operational parent and the
// difference said, never used as authority or changed from here.
export function displayParent(area: string, parent: string | null): string {
  let shown: string | null = null
  try { const p = (JSON.parse(readFileSync(join(area, 'site.json'), 'utf8')) as { parent?: { name?: string } }).parent; shown = p?.name ?? null } catch { /* none */ }
  if (shown === parent) return parent ? `Home shows the parent ${parent}, as configured` : 'no parent, none shown'
  if (!shown) return `the operational parent is ${parent}; Home shows none (optional: [display.parent] in instance.toml, then agdevctl display)`
  return `Home shows the parent ${shown}, but the operational parent is ${parent ?? 'none'} (display only; fix [display.parent] in instance.toml, then agdevctl display)`
}
export function check(area: string, store: PeerStore): { ok: boolean; summary: string; peers: PeerCheck[]; display?: string } {
  const raw = readRaw(area)
  const parsed = raw ? parsePeerConfig(raw, selfInstance(area)) : { problems: [`${file(area)} does not exist`] }
  if ('problems' in parsed) return { ok: false, summary: `configuration: ${parsed.problems.join('; ')}`, peers: [] }
  const cfg = parsed.config
  const st = store.status()
  const peers = cfg.peers.map(p => {
    const caps = store.capabilitiesOf(p.instance)
    const en = store.manage.enrollment(cfg, p)
    const needs = p.parentage !== 'none' || p.grant.length > 0 || p.manage.length > 0
    // cluster_teamwork p2: a peer's readiness is its endpoint, the
    // credential it issued and the last HTTP result.
    const h = st.http.peers.find(x => x.peer === p.instance)
    const cred = existsSync(credentialFile(area, p))
    const http = { endpoint: p.endpoint, credential: cred, last: h ? { ok: !!h.ok, at: h.at, error: h.error } : null, state: (!cred ? 'no-credential' : !h ? 'not-tried' : h.ok ? 'ok' : 'failing') as 'no-credential' | 'not-tried' | 'ok' | 'failing' }
    return { instance: p.instance, label: p.label, heard: caps.seen, speaks: caps.capabilities, enrollment: en, complete: (!needs || en.state === 'mutual') && (http.state === 'ok' || http.state === 'not-tried'), http }
  })
  const ok = peers.every(p => p.complete)
  return {
    ok, peers, display: displayParent(area, cfg.peers.find(p => p.parentage === 'parent')?.label ?? null),
    summary: `${ok ? 'complete' : 'not complete'}: ${peers.map(p => `${p.label} ${p.enrollment.state} (HTTP ${p.http.state})`).join(', ') || 'no peers'}`,
  }
}
