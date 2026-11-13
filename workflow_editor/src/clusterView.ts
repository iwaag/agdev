// Cluster (improve_multinodes p4, #/cluster; docs/management.md, Display
// identity and the Cluster view): this installation, its operational parent
// and its directly configured children, as this installation knows them —
// its own peers.json and what each peer last told it (GET api/manage). Not a
// discovery of the whole cluster: the page asks no peer, and a read enqueues
// nothing. Relationship agreement (enrollment), observation freshness and
// service state are shown apart; nothing old is shown as current, nothing
// silent as stopped. Read-only: no update, enrollment or unlink controls.
import type { ManageLocal, ManagePeer, ManageResponse, ManageSample } from '../shared/api.ts'
import { api } from './api.ts'
import { h, when } from './dom.ts'
import type { ViewHandle } from './main.ts'
import { siteLinks } from './site.ts'

const POLL_MS = 30_000
const SELF = '__self__'

// Only an http(s) destination without credentials becomes a link.
export function dashboardHref(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    const x = new URL(u)
    return (x.protocol === 'http:' || x.protocol === 'https:') && !x.username && !x.password ? x.href : null
  } catch { return null }
}

const ago = (at: string | null | undefined, now: number): string => {
  if (!at) return 'never'
  const s = Math.round((now - Date.parse(at)) / 1000)
  if (!Number.isFinite(s)) return at
  if (s < 90) return `${Math.max(0, s)} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
const shortId = (id: string) => id.length > 16 ? `${id.slice(0, 14)}…` : id
const list = (xs: string[]) => xs.length ? xs.join(', ') : 'nothing'
const nameOf = (p: ManagePeer) => p.identity?.name ?? p.label ?? p.instance

type Tone = 'ok' | 'warn' | 'error' | 'muted'
const EDGE_TONE: Record<ManagePeer['enrollment']['state'], Tone> = { mutual: 'ok', pending: 'warn', partial: 'warn', none: 'muted', contradictory: 'error', cycle: 'error' }

// What the card says about current state, kept apart from the relationship.
function peerState(p: ManagePeer, now: number): { label: string; tone: Tone; title: string } {
  const o = p.observation
  if (!o) return { label: `not observed · heard ${ago(p.capabilitiesSeen ?? p.heardAt, now)}`, tone: 'muted', title: 'This installation does not observe this peer: its health is not known here, only when it last posted on the link.' }
  if (o.state === 'fresh') {
    const svc = o.body?.sample?.services ?? {}
    const down = Object.entries(svc).filter(([, v]) => v !== 'running').map(([k, v]) => `${k} ${v}`)
    return down.length ? { label: `observed · ${down.join(', ')}`, tone: 'warn', title: o.detail } : { label: `observed · services running · ${ago(o.received, now)}`, tone: 'ok', title: o.detail }
  }
  if (o.state === 'stale') return { label: `stale · last reported ${ago(o.received, now)}`, tone: 'warn', title: `${o.detail}. Not current: shown as last reported.` }
  return { label: 'observation unknown', tone: 'muted', title: o.detail }
}

function localState(l: ManageLocal, now: number): { label: string; tone: Tone; title: string } {
  const lc = l.lifecycle
  if (!lc.sample) return { label: 'lifecycle not reporting', tone: 'warn', title: lc.problem ?? 'no status record' }
  if (lc.problem) return { label: `stale · lifecycle reported ${ago(lc.sample.at, now)}`, tone: 'warn', title: lc.problem }
  const down = Object.entries(lc.sample.services).filter(([, v]) => v !== 'running').map(([k, v]) => `${k} ${v}`)
  if (lc.sample.update) return { label: `updating · ${lc.sample.update.state}`, tone: 'warn', title: `update ${lc.sample.update.id} ${lc.sample.update.state} since ${lc.sample.update.since}` }
  return down.length ? { label: down.join(', '), tone: 'warn', title: `sampled ${lc.sample.at}` } : { label: `services running · ${ago(lc.sample.at, now)}`, tone: 'ok', title: `lifecycle sampled ${lc.sample.at}` }
}

function edgeLabel(p: ManagePeer): string {
  const e = p.enrollment
  const what = p.parentage === 'child' ? `manages ${list(p.manage)}` : p.parentage === 'parent' ? `granted ${list(p.grant)}` : ''
  return e.state === 'mutual' ? `mutual · ${what}` : `${e.state}${what ? ` · ${what}` : ''}`
}

export function renderClusterView(root: HTMLElement): ViewHandle {
  let data: ManageResponse | null = null
  let loadError = ''
  let readAt = 0
  let selected = SELF
  let disposed = false
  let ctrl = new AbortController()

  const stamp = h('span.muted.small.cl-stamp')
  const header = h('header.topbar', h('div.crumbs', h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'Cluster')),
    h('div.top-actions', h('a.button', { href: '#/', title: 'Back to this installation\'s dashboard' }, '← Dashboard'), ...siteLinks(), stamp,
      h('button', { onclick: () => void load(), title: 'Read this installation\'s management facts again (asks no peer)' }, 'Refresh')))
  const main = h('main.dashboard.cluster-view')
  root.append(header, main)

  async function load() {
    ctrl.abort(); ctrl = new AbortController()
    const mine = ctrl
    try { data = await api.manage(mine.signal); loadError = ''; readAt = Date.now() } catch (e) { if (mine.signal.aborted) return; loadError = (e as Error).message }
    if (!disposed) render()
  }

  const select = (id: string) => { selected = id; render(); main.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.focus() }

  function nodeCard(o: { id: string; name: string; instance: string | null; host: string | null; relation: string; state: { label: string; tone: Tone; title: string }; self?: boolean; warn?: boolean }): HTMLElement {
    return h(`button.cl-node${o.self ? '.cl-self' : ''}${o.warn ? '.cl-warn' : ''}${selected === o.id ? '.selected' : ''}`, {
      type: 'button', dataset: { node: o.id }, 'aria-pressed': selected === o.id ? 'true' : 'false',
      title: o.instance ?? undefined, onclick: () => select(o.id),
    },
    h('span.cl-rel.small', o.relation),
    h('strong.cl-name', o.name),
    h('code.cl-id.small', o.instance ? shortId(o.instance) : 'instance id unknown'),
    h('span.cl-host.small', o.host ? `on ${o.host}` : 'host unknown'),
    h(`span.cl-state.small.${o.state.tone}`, { title: o.state.title }, h(`span.cl-dot.${o.state.tone}`), o.state.label))
  }

  // The parent above: a vertical edge. A child: a branch off the spine below
  // this installation. Solid = mutual; dashed = not agreed; red = conflict.
  const edgeClass = (p: ManagePeer) => `${EDGE_TONE[p.enrollment.state]}${p.enrollment.state === 'mutual' ? '' : '.dashed'}`
  function edge(p: ManagePeer): HTMLElement {
    return h(`div.cl-edge.${edgeClass(p)}`, { title: p.enrollment.detail },
      h('span.cl-edge-line', { 'aria-hidden': 'true' }), h('span.cl-edge-label.small', edgeLabel(p)))
  }
  function branch(p: ManagePeer, now: number): HTMLElement {
    return h(`div.cl-branch.${edgeClass(p)}`, { title: p.enrollment.detail },
      h('span.cl-edge-label.small', edgeLabel(p)), h('span.cl-branch-line', { 'aria-hidden': 'true' }), peerCard(p, now))
  }

  function peerCard(p: ManagePeer, now: number): HTMLElement {
    const relation = p.parentage === 'parent' ? 'parent of this installation' : p.parentage === 'child' ? 'child of this installation' : 'peer · no operational relationship'
    return nodeCard({ id: p.instance, name: nameOf(p), instance: p.instance, host: p.identity?.host ?? null, relation, state: peerState(p, now), warn: EDGE_TONE[p.enrollment.state] === 'error' })
  }

  function tree(d: ManageResponse, now: number): HTMLElement {
    const parent = d.peers.find(p => p.parentage === 'parent') ?? null
    const children = d.peers.filter(p => p.parentage === 'child')
    const others = d.peers.filter(p => p.parentage === 'none')
    const above = d.ancestry.slice(parent ? 1 : 0)
    const l = d.local
    const self = nodeCard({ id: SELF, name: l.name ?? 'Unnamed agdev', instance: l.instance, host: l.host, relation: 'this installation', state: localState(l, now), self: true })
    return h('section.card.cl-tree-card',
      h('div.card-head', h('h2', 'Management relationships'), h('span.muted.small', `as known to ${l.name ?? 'this installation'}`)),
      h('div.cl-tree', { role: 'group', 'aria-label': 'Installations known here' },
        above.length ? h('div.cl-ancestry.small.muted', { title: 'Reported by the parent; this installation has no details of these' },
          'Reported ancestry: ', ...above.map((id, i) => [i ? ' → ' : '', h('code', id)]), ' (details unavailable)') : null,
        parent ? [peerCard(parent, now), edge(parent)] : h('p.muted.small.cl-none', 'No operational parent configured.'),
        self,
        children.length ? h('div.cl-children', ...children.map(c => branch(c, now)))
          : h('p.muted.small.cl-none', 'No child installation configured.')),
      others.length ? h('div.cl-others', h('h3', 'Other configured peers'),
        h('p.muted.small', 'Peers given or managing administrative access without a parentage: not part of the tree. Peers configured only for ordinary work are not listed.'),
        h('div.cl-children.flat', ...others.map(o => peerCard(o, now)))) : null)
  }

  const row = (k: string, v: HTMLElement | string | null | (HTMLElement | string)[]) => [h('dt', k), h('dd', v ?? h('span.muted', 'unknown'))]

  function services(s: ManageSample | null, current: boolean): HTMLElement | string {
    if (!s) return h('span.muted', 'no sample')
    const items = Object.entries(s.services)
    return h(`span.cl-services${current ? '' : '.old'}`, ...items.map(([k, v]) => h(`span.chip${current ? (v === 'running' ? '.ok' : '.warn') : '.muted'}`, `${k} ${v}`)),
      s.draining ? h('span.chip.warn', 'draining') : null, current ? null : h('span.muted.small', ` as last reported ${when(s.at)}, not current`))
  }

  function dashboardButton(href: string | null, name: string, self: boolean): HTMLElement {
    if (self) return h('a.button.primary', { href: '#/' }, 'Open dashboard')
    return href ? h('a.button.primary', { href, target: '_blank', rel: 'noopener', title: `Open ${name}'s dashboard (${href})` }, 'Open dashboard ↗')
      : h('p.muted.small', 'No dashboard address known: the peer has not told one (an older release, or none configured there).')
  }

  function selfDetail(d: ManageResponse, now: number): HTMLElement {
    const l = d.local, s = l.lifecycle.sample
    return h('section.card.cl-detail', { 'aria-live': 'polite' },
      h('div.card-head', h('h2', l.name ?? 'Unnamed agdev'), h('span.chip.ok', 'this installation')),
      h('dl.cl-dl',
        row('Instance', l.instance ? h('code', l.instance) : null),
        row('Host', l.host ? [l.host, h('span.muted.small', ' (OS host name of this service)')] : null),
        row('Parent', d.ancestry[0] ? h('code', d.ancestry[0]) : 'none'),
        row('Children', String(d.peers.filter(p => p.parentage === 'child').length)),
        row('Release (running)', l.release ? [h('code', l.release.commit.slice(0, 12)), l.release.built ? h('span.muted.small', ` built ${when(l.release.built)}`) : ''] : 'no release record'),
        row('Selected (lifecycle)', s?.release.active ? h('code', s.release.active.slice(0, 12)) : null),
        row('Serving', s?.serving?.release ? h('code', s.serving.release.slice(0, 12)) : s ? 'not answering' : null),
        row('Services', services(s, !l.lifecycle.problem)),
        row('Lifecycle sample', s ? `${when(s.at)} (${ago(s.at, now)})${l.lifecycle.problem ? ` — ${l.lifecycle.problem}` : ''}` : l.lifecycle.problem),
        row('Update', s?.update ? `${s.update.id} ${s.update.state} since ${s.update.since}` : s ? 'none running' : null),
        row('Read', when(d.at))),
      dashboardButton(null, l.name ?? '', true))
  }

  function peerDetail(p: ManagePeer, d: ManageResponse, now: number): HTMLElement {
    const o = p.observation, s = o?.body?.sample ?? null
    const op = p.operations[0]
    const heardGrants = p.heard ? list(p.heard.grants) : null
    const authority = p.parentage === 'child'
      ? `This installation may ${list(p.manage)} it; it told it grants ${heardGrants ?? '(not told)'}.`
      : p.parentage === 'parent'
        ? `It may ${list(p.grant)} this installation (granted here); this installation has no authority over it.`
        : `Grants here: ${list(p.grant)}; manages: ${list(p.manage)}.`
    return h('section.card.cl-detail', { 'aria-live': 'polite' },
      h('div.card-head', h('h2', nameOf(p)), h(`span.chip.${EDGE_TONE[p.enrollment.state] === 'muted' ? 'muted' : EDGE_TONE[p.enrollment.state]}`, p.enrollment.state)),
      h('dl.cl-dl',
        row('Instance', h('code', p.instance)),
        row('Name', p.identity?.name ? [p.identity.name, p.identity.name !== p.label ? h('span.muted.small', ` (local label ${p.label})`) : ''] : [p.label, h('span.muted.small', ' (local label; the peer has not told its name)')]),
        row('Host', p.identity?.host ?? null),
        row('Relationship', `${p.parentage === 'parent' ? 'parent of this installation' : p.parentage === 'child' ? 'child of this installation' : 'no parentage'} — ${p.enrollment.state}: ${p.enrollment.detail}`),
        row('Permissions', authority),
        row('Relation told', p.heardAt ? `${when(p.heardAt)} (${ago(p.heardAt, now)})` : 'never'),
        row('Last heard on the link', p.capabilitiesSeen ? `${when(p.capabilitiesSeen)} (${ago(p.capabilitiesSeen, now)}); speaks ${list(p.capabilities)}` : 'never'),
        row('Identity told', p.identity ? `${when(p.identity.received)} (${ago(p.identity.received, now)})` : 'never'),
        ...(o ? [
          row('Observation', `${o.state} — ${o.detail}`),
          row('Selected release', s?.release.active ? h('code', s.release.active.slice(0, 12)) : null),
          row('Serving release', s?.serving?.release ? h('code', s.serving.release.slice(0, 12)) : s ? 'not answering' : null),
          row('Services', services(s, o.state === 'fresh')),
          row('Sampled / received', s ? `${when(s.at)} / ${o.received ? when(o.received) : '—'}` : o.asked ? `asked ${when(o.asked)}, no answer yet` : null),
        ] : [row('Observation', 'not observed by this installation — release and service state are not known here')]),
        row('Last management operation', op ? [h('code', op.id.split(':').slice(1).join(':')), ` ${op.dir === 'out' ? 'asked' : 'received'} ${when(op.created)}: ${op.outcome}`] : 'none')),
      dashboardButton(dashboardHref(p.identity?.dashboard), nameOf(p), false),
      d.local.instance && p.heard?.ancestry.includes(d.local.instance) && p.parentage === 'parent' ? h('div.banner.error', 'This parent reports this installation among its own ancestors: a cycle.') : null)
  }

  function render() {
    const now = readAt || Date.now()
    stamp.textContent = data ? `read ${new Date(data.at).toLocaleTimeString()} · refreshes every ${POLL_MS / 1000} s` : ''
    const parts: (HTMLElement | null)[] = [
      h('p.cl-scope.small.muted',
        'The management relationships this installation knows: its own configuration and what its direct peers last told it over the agdev link. The page asks no peer; it is not a real-time reachability monitor, and installations beyond the direct peers are not discovered.'),
    ]
    if (loadError) parts.push(h('div.banner.error', `The management facts cannot be read: ${loadError}`, data ? ` — showing the read of ${when(data.at)}.` : ''))
    if (!data) { main.replaceChildren(...parts.filter((x): x is HTMLElement => !!x), ...(loadError ? [] : [h("p.muted", "Reading…")])); return }
    const d = data
    if (d.config === 'disabled') parts.push(h('div.banner.warn', 'This installation has no configured peers (no peers.json): only itself is shown.'))
    if (d.config === 'invalid') parts.push(h('div.banner.error', `The peer configuration is not usable: ${d.reason ?? ''}`))
    const warnings = d.peers.filter(p => EDGE_TONE[p.enrollment.state] === 'error')
    if (warnings.length) parts.push(h('div.banner.error', h('ul', warnings.map(p => h('li', `${nameOf(p)} (${p.instance}): ${p.enrollment.state} — ${p.enrollment.detail}`)))))
    if (selected !== SELF && !d.peers.some(p => p.instance === selected)) {
      parts.push(h('div.banner.warn', `${selected} is no longer configured here; showing this installation.`))
      selected = SELF
    }
    const peer = d.peers.find(p => p.instance === selected)
    parts.push(h('div.cl-layout', tree(d, now), peer ? peerDetail(peer, d, now) : selfDetail(d, now)))
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.node
    main.replaceChildren(...parts.filter((x): x is HTMLElement => !!x))
    if (focused) main.querySelector<HTMLElement>(`[data-node="${CSS.escape(focused)}"]`)?.focus()
  }

  // Arrow keys move between cards; Enter/Space select (buttons).
  main.addEventListener('keydown', e => {
    const cards = [...main.querySelectorAll<HTMLElement>('.cl-node')]
    const at = cards.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? at - 1 : null
    if (next === null) return
    e.preventDefault()
    cards[(next + cards.length) % cards.length].focus()
  })

  render()
  void load()
  const timer = setInterval(() => { if (!document.hidden) void load() }, POLL_MS)
  return { dispose: () => { disposed = true; clearInterval(timer); ctrl.abort() }, isDirty: () => false }
}
