// The cluster directory (cluster_teamwork p2, docs/cluster.md).
//
// - Every installation **advertises** what it explicitly offers
//   (<area>/cluster.json `offers`), enriched from the published definitions
//   (name, purpose, source revision, whether it accepts requests), with its
//   identity, API endpoint, protocol capabilities and a bounded activity
//   summary. Built in the background and cached; `GET /api/cluster/advertisement`
//   serves the cache. No credential, workspace path or conversation text.
// - An installation with `directory.collect` (agdev-A) **collects** the
//   advertisements of its peers that have an endpoint, with bounded
//   concurrency and conditional reads, keeping its own fetch time apart from
//   the advertised build time; a failed refresh keeps the last entry, marked
//   stale, never renewed or erased. `GET /api/cluster/directory` serves it.
// - Others **consult** a directory (peers.json `directory`) on demand and
//   keep a cached copy, labelled stale when it cannot be refreshed. `resolve`
//   then asks the destination itself and reports, separately, whether it is
//   registered here, allowed here, confirmed there and permitted there.
//
// Discovery grants nothing: a listing is not an acceptance, an advertised
// endpoint does not enroll a peer, parentage gives no work access.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from '../shared/canonical.ts'
import { CAPABILITIES, sha256, type PeerConfig } from '../shared/peers.ts'
import type { ExecStore } from './exec.ts'
import { credentialFile, loadPeerConfig, readCredential, selfInstance } from './peerlink.ts'
import { localIdentity } from './peermanage.ts'
import { loadRegistry } from './registry.ts'
import { RequestError } from './workspace.ts'

export const CLUSTER_PROTOCOL = 'cluster/1'
export const ADVERTISE_TTL_MS = 10 * 60_000 // own advertisement rebuilt at most this often (or when cluster.json changes)
export const COLLECT_MS = 5 * 60_000 // a collector refreshes its members this often
export const FRESH_MS = 15 * 60_000 // an entry not refreshed for this long is stale
export const CACHE_REFRESH_MS = 10 * 60_000 // a consumer refreshes its cached directory on demand after this
export const FETCH_TIMEOUT_MS = 10_000
export const COLLECT_CONCURRENCY = 4
const MAX_TEXT = 600

export interface OfferSetting { project: string; workflow: string; purpose?: string; input?: string; delivery?: string; consult?: string | null }
export interface ClusterSetting { endpoint: string | null; offers: OfferSetting[]; collect: boolean }
export interface Offer {
  project: string; workflow: string; name: string | null; purpose: string; input: string | null; delivery: string | null; consult: string | null
  requests: boolean | null; source: { repository: string; branch: string; commit: string } | null; problem: string | null
}
export interface Advertisement {
  agdev: typeof CLUSTER_PROTOCOL; instance: string; name: string | null; host: string | null; endpoint: string | null; view: string | null
  capabilities: { peer: string[]; transports: string[]; directory: boolean }
  offers: Offer[]; activity: { queued: number; running: number; at: string } | null
  revision: string; built: string
}
export interface DirectoryEntry {
  instance: string; via: string | null; endpoint: string | null; state: 'fresh' | 'stale' | 'unavailable'
  advertised: { revision: string; built: string } | null; fetched: string | null; checked: string | null; error: string | null
  advertisement: Advertisement | null
}
export interface Directory { agdev: 'cluster-directory/1'; instance: string; at: string; entries: DirectoryEntry[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clip = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : ''
const TARGET = /^[a-z0-9][a-z0-9-]*$/

export function loadClusterSetting(area: string): { setting: ClusterSetting; mtime: number } | { problems: string[] } {
  const file = join(area, 'cluster.json')
  if (!existsSync(file)) return { setting: { endpoint: null, offers: [], collect: false }, mtime: 0 }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return { problems: [`${file}: ${(e as Error).message}`] } }
  const problems: string[] = []
  if (!isObj(raw) || raw.version !== 1) return { problems: [`${file}: version 1 is {version: 1, endpoint?, offers: [{project, workflow, purpose?, input?, delivery?, consult?}], directory?: {collect}}`] }
  const endpoint = raw.endpoint ?? null
  if (endpoint !== null && (typeof endpoint !== 'string' || !/^https?:\/\/\S+$/.test(endpoint))) problems.push('endpoint is this installation\'s WFE API base URL')
  const offers: OfferSetting[] = []
  for (const [i, o] of (Array.isArray(raw.offers) ? raw.offers : []).entries()) {
    if (!isObj(o) || typeof o.project !== 'string' || !TARGET.test(o.project) || typeof o.workflow !== 'string' || !TARGET.test(o.workflow)) { problems.push(`offers[${i}] is {project, workflow, …}`); continue }
    offers.push({ project: o.project, workflow: o.workflow, ...(typeof o.purpose === 'string' ? { purpose: o.purpose } : {}), ...(typeof o.input === 'string' ? { input: o.input } : {}), ...(typeof o.delivery === 'string' ? { delivery: o.delivery } : {}), ...(typeof o.consult === 'string' ? { consult: o.consult } : {}) })
  }
  const collect = isObj(raw.directory) && raw.directory.collect === true
  if (problems.length) return { problems: problems.map(p => `${file}: ${p}`) }
  return { setting: { endpoint: endpoint as string | null, offers, collect }, mtime: statSync(file).mtimeMs }
}

// This installation's API base: cluster.json `endpoint`, else peers.json viewBase + "api".
export function selfEndpoint(setting: ClusterSetting, cfg: PeerConfig | null): string | null {
  if (setting.endpoint) return setting.endpoint.replace(/\/+$/, '')
  return cfg?.viewBase ? `${cfg.viewBase.replace(/\/?$/, '/')}api` : null
}

function writeJson(file: string, v: unknown) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(v, null, 1)}\n`)
  renameSync(tmp, file)
}
function readJson<T>(file: string): T | null { try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null } }

async function getJson(url: string, o: { etag?: string | null; token?: string | null; fetch?: typeof fetch } = {}): Promise<{ status: number; body: unknown; etag: string | null }> {
  const res = await (o.fetch ?? fetch)(url, { headers: { accept: 'application/json', ...(o.etag ? { 'if-none-match': o.etag } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const text = res.status === 304 ? '' : await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: res.status, body, etag: res.headers.get('etag') }
}

export function advertisementOk(v: unknown): v is Advertisement {
  return isObj(v) && v.agdev === CLUSTER_PROTOCOL && typeof v.instance === 'string' && Array.isArray(v.offers) && typeof v.revision === 'string' && typeof v.built === 'string'
}

export class Cluster {
  readonly ctx: { area: string; registryFile: string; exec: ExecStore; clock?: () => number }
  constructor(ctx: { area: string; registryFile: string; exec: ExecStore; clock?: () => number }) { this.ctx = ctx }
  private ms() { return this.ctx.clock?.() ?? Date.now() }
  private now() { return new Date(this.ms()).toISOString() }
  private dir() { return join(this.ctx.area, '.local', 'cluster') }
  private file(name: string) { return join(this.dir(), name) }

  // ---- advertising --------------------------------------------------------------------------

  // The cached advertisement, rebuilt when older than ADVERTISE_TTL_MS or
  // cluster.json changed (or `force`). Reads published definitions only.
  async advertisement(o: { force?: boolean; ifStale?: boolean } = {}): Promise<Advertisement> {
    const cached = readJson<{ ad: Advertisement; settingMtime: number; at: number }>(this.file('advertisement.json'))
    const s = loadClusterSetting(this.ctx.area)
    if ('problems' in s) throw new RequestError(409, s.problems.join('; '), { code: 'cluster-config' })
    const fresh = cached && cached.settingMtime === s.mtime && this.ms() - cached.at < ADVERTISE_TTL_MS
    if (cached && !o.force && (fresh || o.ifStale === false)) return cached.ad
    const ad = await this.build(s.setting)
    writeJson(this.file('advertisement.json'), { ad, settingMtime: s.mtime, at: this.ms() })
    return ad
  }
  cachedAdvertisement(): Advertisement | null { return readJson<{ ad: Advertisement }>(this.file('advertisement.json'))?.ad ?? null }

  private async build(setting: ClusterSetting): Promise<Advertisement> {
    const c = loadPeerConfig(this.ctx.area)
    const cfg = 'config' in c ? c.config : null
    const self = cfg?.self ?? selfInstance(this.ctx.area) ?? 'unknown'
    const id = localIdentity(this.ctx.area, cfg)
    const regs = (await loadRegistry(this.ctx.registryFile)).workspaces
    const access = this.ctx.exec.ctx.gitea ? this.ctx.exec.accessContext() : null
    const offers: Offer[] = []
    for (const o of setting.offers) {
      const base: Offer = { project: o.project, workflow: o.workflow, name: null, purpose: clip(o.purpose), input: o.input ? clip(o.input) : null, delivery: o.delivery ? clip(o.delivery) : null, consult: o.consult ?? null, requests: null, source: null, problem: null }
      try {
        const reg = regs.find(r => r.project === o.project)
        if (!reg) { offers.push({ ...base, problem: `project ${o.project} is not registered here` }); continue }
        if (!access) { offers.push({ ...base, problem: 'no Gitea access: the published definition cannot be read' }); continue }
        const { publishedWorkspace } = await import('./published.ts')
        const pub = await publishedWorkspace(access, reg, { discovery: true })
        const sum = (await pub.workflowSummaries()).list.find(x => x.id === o.workflow)
        if (!sum) { offers.push({ ...base, source: { repository: pub.source.repository, branch: pub.source.branch, commit: pub.source.commit }, problem: `${o.project} publishes no workflow ${o.workflow}` }); continue }
        let intent = ''
        try { intent = clip((await pub.workflowResponse(sum.file)).workflow?.intent) } catch { /* the summary is enough */ }
        offers.push({ ...base, name: sum.name ?? null, purpose: base.purpose || intent, requests: sum.intake ?? true, source: { repository: pub.source.repository, branch: pub.source.branch, commit: pub.source.commit } })
      } catch (e) { offers.push({ ...base, problem: clip((e as Error).message) }) }
    }
    const body: Omit<Advertisement, 'activity' | 'revision' | 'built'> = {
      agdev: CLUSTER_PROTOCOL, instance: self, name: id.name, host: id.host, endpoint: selfEndpoint(setting, cfg), view: cfg?.viewBase ?? null,
      capabilities: { peer: [...CAPABILITIES] as string[], transports: ['http'], directory: setting.collect }, offers,
    }
    return { ...body, activity: this.activity(), revision: `sha256:${sha256(canonicalJson(body))}`, built: this.now() }
  }

  // Workload counts only (no run names, no text): queued and running jobs.
  private activity(): Advertisement['activity'] {
    try {
      const rows = this.ctx.exec.db.prepare('SELECT state, count(*) AS n FROM jobs WHERE state IN (\'queued\', \'claimed\') GROUP BY state').all() as { state: string; n: number }[]
      return { queued: rows.find(r => r.state === 'queued')?.n ?? 0, running: rows.find(r => r.state === 'claimed')?.n ?? 0, at: this.now() }
    } catch { return null }
  }

  // ---- collecting (a directory) -------------------------------------------------------------

  // Members: this installation's peers that have an endpoint registered.
  // Each is read conditionally; a failure keeps its last advertisement.
  async collect(o: { fetch?: typeof fetch; force?: boolean } = {}): Promise<{ notes: string[] }> {
    const s = loadClusterSetting(this.ctx.area)
    if ('problems' in s || !s.setting.collect) return { notes: [] }
    const c = loadPeerConfig(this.ctx.area)
    if (!('config' in c)) return { notes: [] }
    const state = readJson<Record<string, { ad: Advertisement | null; etag: string | null; fetched: string | null; checked: string | null; error: string | null; endpoint: string; via: string | null }>>(this.file('members.json')) ?? {}
    const last = readJson<{ at: number }>(this.file('collected.json'))?.at ?? 0
    if (!o.force && this.ms() - last < COLLECT_MS) return { notes: [] }
    const members = c.config.peers.filter(p => p.endpoint)
    const notes: string[] = []
    const one = async (p: typeof members[number]) => {
      const prev = state[p.instance]
      const at = this.now()
      try {
        const r = await getJson(`${p.endpoint}/cluster/advertisement`, { etag: prev?.endpoint === p.endpoint ? prev?.etag : null, fetch: o.fetch })
        if (r.status === 304 && prev?.ad) { state[p.instance] = { ...prev, fetched: at, checked: at, error: null }; return }
        if (r.status !== 200 || !advertisementOk(r.body)) throw new Error(`HTTP ${r.status}${isObj(r.body) && typeof r.body.error === 'string' ? `: ${r.body.error}` : r.status === 200 ? ': not an advertisement' : ''}`)
        if (r.body.instance !== p.instance) throw new Error(`${p.endpoint} advertises ${r.body.instance}, not ${p.instance}; kept apart`)
        state[p.instance] = { ad: r.body, etag: r.etag, fetched: at, checked: at, error: null, endpoint: p.endpoint!, via: null }
        // Descendants a member collects itself, kept with their provenance.
        if (r.body.capabilities.directory) {
          const d = await getJson(`${p.endpoint}/cluster/directory`, { fetch: o.fetch }).catch(() => null)
          if (d?.status === 200 && isObj(d.body) && Array.isArray(d.body.entries)) {
            for (const e of d.body.entries as DirectoryEntry[]) {
              if (!e?.advertisement || e.instance === c.config.self || members.some(m => m.instance === e.instance) || e.instance === p.instance) continue
              state[e.instance] = { ad: e.advertisement, etag: null, fetched: e.fetched, checked: at, error: e.error, endpoint: e.endpoint ?? '', via: p.instance }
            }
          }
        }
      } catch (e) {
        const msg = `${(e as Error).name === 'TimeoutError' ? `no answer within ${FETCH_TIMEOUT_MS / 1000} s` : (e as Error).message}`.slice(0, 300)
        state[p.instance] = { ad: prev?.ad ?? null, etag: prev?.etag ?? null, fetched: prev?.fetched ?? null, checked: at, error: msg, endpoint: p.endpoint!, via: null }
        if (prev?.error !== msg) notes.push(`directory: ${p.label} (${p.instance}) not refreshed — ${msg}; ${prev?.ad ? 'its last advertisement is kept, marked stale' : 'nothing known yet'}`)
      }
    }
    for (let i = 0; i < members.length; i += COLLECT_CONCURRENCY) await Promise.all(members.slice(i, i + COLLECT_CONCURRENCY).map(one))
    writeJson(this.file('members.json'), state)
    writeJson(this.file('collected.json'), { at: this.ms() })
    return { notes }
  }

  // The aggregated directory: this installation's own advertisement first,
  // then each member's as last fetched (freshness by A's fetch time).
  async directory(): Promise<Directory> {
    const s = loadClusterSetting(this.ctx.area)
    if ('problems' in s) throw new RequestError(409, s.problems.join('; '), { code: 'cluster-config' })
    if (!s.setting.collect) throw new RequestError(404, 'this installation does not collect a cluster directory (cluster.json directory.collect); ask the one peers.json `directory` names', { code: 'cluster-no-directory' })
    const own = await this.advertisement({ ifStale: false })
    const state = readJson<Record<string, { ad: Advertisement | null; fetched: string | null; checked: string | null; error: string | null; endpoint: string; via: string | null }>>(this.file('members.json')) ?? {}
    const entries: DirectoryEntry[] = [{ instance: own.instance, via: null, endpoint: own.endpoint, state: 'fresh', advertised: { revision: own.revision, built: own.built }, fetched: own.built, checked: own.built, error: null, advertisement: own }]
    for (const [instance, m] of Object.entries(state).sort(([a], [b]) => a.localeCompare(b))) {
      const age = m.fetched ? this.ms() - Date.parse(m.fetched) : Infinity
      entries.push({ instance, via: m.via, endpoint: m.endpoint || m.ad?.endpoint || null, state: !m.ad ? 'unavailable' : age > FRESH_MS || (m.error && !m.via) ? 'stale' : 'fresh', advertised: m.ad ? { revision: m.ad.revision, built: m.ad.built } : null, fetched: m.fetched, checked: m.checked, error: m.error, advertisement: m.ad })
    }
    return { agdev: 'cluster-directory/1', instance: own.instance, at: this.now(), entries }
  }

  // ---- consulting (B, C) --------------------------------------------------------------------

  // The directory as last fetched from peers.json `directory`, refreshed
  // when older than CACHE_REFRESH_MS (or `refresh`); unreachable → the
  // cache, labelled stale with why.
  async consult(o: { refresh?: boolean; fetch?: typeof fetch } = {}): Promise<{ source: string | null; fetched: string | null; stale: string | null; directory: Directory | null }> {
    const c = loadPeerConfig(this.ctx.area)
    const url = 'config' in c ? c.config.directory : null
    const cache = readJson<{ source: string; fetched: string; directory: Directory }>(this.file('directory-cache.json'))
    if (!url) {
      // A collector consults itself.
      const s = loadClusterSetting(this.ctx.area)
      if (!('problems' in s) && s.setting.collect) return { source: 'this installation', fetched: this.now(), stale: null, directory: await this.directory() }
      return { source: null, fetched: cache?.fetched ?? null, stale: cache ? 'no directory is configured (peers.json directory); this is an old copy' : null, directory: cache?.directory ?? null }
    }
    const due = !cache || cache.source !== url || o.refresh || this.ms() - Date.parse(cache.fetched) > CACHE_REFRESH_MS
    if (!due) return { source: url, fetched: cache!.fetched, stale: null, directory: cache!.directory }
    try {
      const r = await getJson(url, { fetch: o.fetch })
      if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.entries)) throw new Error(`HTTP ${r.status}${isObj(r.body) && typeof r.body.error === 'string' ? `: ${r.body.error}` : ''}`)
      const fetched = this.now()
      writeJson(this.file('directory-cache.json'), { source: url, fetched, directory: r.body })
      return { source: url, fetched, stale: null, directory: r.body as unknown as Directory }
    } catch (e) {
      const why = `${url} not reachable (${(e as Error).name === 'TimeoutError' ? `no answer within ${FETCH_TIMEOUT_MS / 1000} s` : (e as Error).message})`
      return { source: url, fetched: cache?.fetched ?? null, stale: cache ? `${why}; showing the copy fetched ${cache.fetched}` : `${why}; no cached copy`, directory: cache?.directory ?? null }
    }
  }

  static offersOf(d: Directory | null, q?: string): { instance: string; state: DirectoryEntry['state']; via: string | null; endpoint: string | null; fetched: string | null; offer: Offer }[] {
    const out: ReturnType<typeof Cluster.offersOf> = []
    for (const e of d?.entries ?? []) for (const offer of e.advertisement?.offers ?? []) {
      const text = `${e.instance} ${e.advertisement?.name ?? ''} ${offer.project}/${offer.workflow} ${offer.name ?? ''} ${offer.purpose}`.toLowerCase()
      if (q && !q.toLowerCase().split(/\s+/).every(w => text.includes(w))) continue
      out.push({ instance: e.instance, state: e.state, via: e.via, endpoint: e.endpoint, fetched: e.fetched, offer })
    }
    return out
  }

  // Where to ask for <project>/<workflow>: the directory's offers, then the
  // destination itself. Each fact is reported apart; nothing is enrolled.
  async resolve(target: string, o: { instance?: string; refresh?: boolean; fetch?: typeof fetch } = {}): Promise<ResolveResult> {
    const [project, workflow] = target.split('/')
    if (!project || !workflow || !TARGET.test(project) || !TARGET.test(workflow)) throw new RequestError(400, 'resolve <project>/<workflow>')
    const dir = await this.consult({ refresh: o.refresh, fetch: o.fetch })
    const found = Cluster.offersOf(dir.directory).filter(x => x.offer.project === project && x.offer.workflow === workflow && (!o.instance || x.instance === o.instance))
    const base = { target, directory: { source: dir.source, fetched: dir.fetched, stale: dir.stale } }
    if (!found.length) return { ...base, state: 'not-offered', candidates: [], detail: `${dir.directory ? 'the directory lists' : 'no directory is available to list'} no offer of ${target}${o.instance ? ` on ${o.instance}` : ''}` }
    if (found.length > 1) return { ...base, state: 'ambiguous', candidates: found.map(f => f.instance), detail: `${target} is offered by ${found.map(f => f.instance).join(', ')}; name one with --instance` }
    const f = found[0]
    const c = loadPeerConfig(this.ctx.area)
    const cfg = 'config' in c ? c.config : null
    const peer = cfg?.peers.find(p => p.instance === f.instance) ?? null
    const local = {
      registered: !!peer, endpoint: peer?.endpoint ?? null, endpointMatches: !!peer?.endpoint && !!f.endpoint && peer.endpoint === f.endpoint,
      route: peer ? 'http' : null, allowed: !!peer && peer.request.includes(target), credential: peer ? !!readCredential(this.ctx.area, peer) : false,
    }
    const endpoint = peer?.endpoint ?? f.endpoint
    // The destination's own word: its advertisement now, and (when connected) what it runs for this installation.
    let confirmed: ResolveResult['confirmed'] = null, permitted: ResolveResult['permitted'] = null
    if (endpoint) {
      try {
        const r = await getJson(`${endpoint}/cluster/advertisement`, { fetch: o.fetch })
        if (r.status !== 200 || !advertisementOk(r.body)) confirmed = { ok: false, detail: `HTTP ${r.status}` }
        else if (r.body.instance !== f.instance) confirmed = { ok: false, detail: `${endpoint} is ${r.body.instance}, not ${f.instance}` }
        else {
          const offer = r.body.offers.find(x => x.project === project && x.workflow === workflow)
          confirmed = offer ? { ok: !offer.problem && offer.requests !== false, detail: offer.problem ?? (offer.requests === false ? 'it no longer accepts requests' : `offered now (${offer.source ? `${offer.source.repository}@${offer.source.commit.slice(0, 10)}` : 'source unknown'}; advertisement ${r.body.revision.slice(0, 19)}…)`), revision: r.body.revision } : { ok: false, detail: `${f.instance} no longer offers ${target}` }
        }
      } catch (e) { confirmed = { ok: false, detail: `unavailable: ${(e as Error).name === 'TimeoutError' ? 'no answer' : (e as Error).message}` } }
      const token = peer ? readCredential(this.ctx.area, peer) : null
      if (token) {
        try {
          const r = await getJson(`${endpoint}/peers/self`, { token, fetch: o.fetch })
          permitted = r.status === 200 && isObj(r.body) && Array.isArray(r.body.accept) ? { ok: (r.body.accept as string[]).includes(target), detail: (r.body.accept as string[]).includes(target) ? `${f.instance} runs ${target} for this installation` : `${f.instance} does not run ${target} for this installation (it runs ${(r.body.accept as string[]).join(', ') || 'nothing'})` } : { ok: false, detail: `HTTP ${r.status}${isObj(r.body) && typeof r.body.error === 'string' ? `: ${r.body.error}` : ''}` }
        } catch (e) { permitted = { ok: false, detail: `unavailable: ${(e as Error).message}` } }
      }
    }
    const self = cfg?.self ?? '<this instance>'
    const connect = !local.registered || !local.endpoint || !local.credential || !local.allowed ? [
      ...(!local.registered || !local.endpoint || !local.allowed ? [`here: wfe peer set ${f.instance} --endpoint ${f.endpoint ?? '<its API>'} --label <name> --request ${target}${local.registered ? '' : ' (a new peer: a configuration decision of this installation)'}`] : []),
      ...(!local.credential ? [`on ${f.instance}, by its operator: wfe peer set ${self} --endpoint <this API> --accept ${target} (its decision), then wfe peer credential issue ${self} --out <file>; here: wfe peer credential install ${f.instance} --from <file>`] : []),
    ] : []
    const state: ResolveResult['state'] = confirmed && !confirmed.ok ? (confirmed.detail.startsWith('unavailable') ? 'unavailable' : 'not-offered')
      : !local.registered ? 'unregistered' : !local.allowed || !local.credential ? 'not-connected' : permitted && !permitted.ok ? (permitted.detail.startsWith('unavailable') ? 'unavailable' : 'not-permitted') : confirmed?.ok && permitted?.ok ? 'ready' : 'unconfirmed'
    return { ...base, state, instance: f.instance, endpoint, listed: { state: f.state, via: f.via, fetched: f.fetched, offer: f.offer }, local, confirmed, permitted, connect, candidates: [f.instance], detail: '' }
  }
}

export interface ResolveResult {
  target: string; state: 'ready' | 'unconfirmed' | 'unregistered' | 'not-connected' | 'not-permitted' | 'unavailable' | 'not-offered' | 'ambiguous'
  directory: { source: string | null; fetched: string | null; stale: string | null }
  instance?: string; endpoint?: string | null
  listed?: { state: DirectoryEntry['state']; via: string | null; fetched: string | null; offer: Offer }
  local?: { registered: boolean; endpoint: string | null; endpointMatches: boolean; route: string | null; allowed: boolean; credential: boolean }
  confirmed?: { ok: boolean; detail: string; revision?: string } | null
  permitted?: { ok: boolean; detail: string } | null
  connect?: string[]; candidates: string[]; detail: string
}
export { credentialFile }
