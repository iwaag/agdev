// Catalog (user_catalog p1, #/catalog; docs/mycatalog.md): the braindumps of
// the user's catalog grouped by their folder paths, each with its review, the
// projects each grounds, a relation diagram, and every project with its
// grounds (none is said, not hidden). Braindumps and reviews are edited here
// through api/catalog: each change is one commit authored by the name given.
//
// user_catalog p2: the page opens with the index (challenges.md: what is not
// yet real), then braindumps as titles with excerpts (a text and its review
// are read when it is opened), then the owner's challenges by state, each
// linking to its challenge page. Free text is rendered as Markdown. Each
// braindump and challenge says whether it is in the published part.
//
// user_catalog p5: Simple and Detail (src/displayMode.ts), one DOM. Simple
// answers what I want (braindumps as a grid of cards), what of it is not yet
// real (one line per entry of the index) and what I can do next; what serves
// inspection and upkeep (paths, commits, authors, editing, the projects
// table) is marked `.d-only`. Only the diagram is redrawn for a mode.
//
// user_catalog p6: a braindump is archived from its opened card in Detail
// (moved to braindumps/archive/<date>/, out of every because); the archive
// folders are listed at the end of Braindumps; a catalog with no braindump
// says what one is and leads to writing one. Archiving all is a command.
import { api, type CatalogBraindump, type CatalogView } from './api.ts'
import { displayToggle, isSimple, onDisplay, showDetail } from './displayMode.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import type { ViewHandle } from './main.ts'
import { renderMarkdown, type LinkResolver } from './markdown.ts'
import { conversationHref, hangoutHref, siteLinks } from './site.ts'

const SVG = 'http://www.w3.org/2000/svg'
const AUTHOR_KEY = 'wfe.catalog.author'
const readAuthor = () => { try { return localStorage.getItem(AUTHOR_KEY) ?? '' } catch { return '' } }
const keepAuthor = (a: string) => { try { localStorage.setItem(AUTHOR_KEY, a) } catch { /* not kept */ } }
const roleText = (roles: Record<string, string | true>) => Object.entries(roles).map(([k, v]) => v === true ? k : `${k} = ${v}`).join(', ')
const projectHref = (p: { project: string; workspace?: string }) => p.workspace ? `#/ws/${encodeURIComponent(p.workspace)}` : null

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  for (const c of children) el.append(c)
  return el
}

// Braindumps on the left, projects on the right, an edge per `because`.
// Projects are ordered by their first braindump so edges cross little; the
// ungrounded ones come last, drawn as such. In Simple only the projects with
// a ground are drawn and a braindump is one line, so the height follows the
// braindumps.
export function relationDiagram(v: CatalogView, onPick: (kind: 'braindump' | 'project', id: string) => void, simple = false): SVGSVGElement {
  const bIndex = new Map(v.braindumps.map((b, i) => [b.id, i]))
  const projects = v.projects.filter(p => !simple || p.braindumps.length).sort((a, b) => {
    const fa = a.braindumps.length ? Math.min(...a.braindumps.map(x => bIndex.get(x.id) ?? 99)) : 1e3
    const fb = b.braindumps.length ? Math.min(...b.braindumps.map(x => bIndex.get(x.id) ?? 99)) : 1e3
    return fa - fb || a.project.localeCompare(b.project)
  })
  const W = 760, rowP = 26, top = 16
  const bh = simple ? 24 : 40
  const H = Math.max(projects.length * rowP, v.braindumps.length * (bh + (simple ? 4 : 14))) + top * 2
  // Simple shows no path: a title that is the path or that repeats is told apart by the last segment.
  const titles = new Map<string, number>()
  for (const b of v.braindumps) titles.set(b.title, (titles.get(b.title) ?? 0) + 1)
  const label = (b: CatalogView['braindumps'][number]) => simple && b.title !== b.id && titles.get(b.title)! > 1 ? `${b.title} (${b.id.split('/').pop()})` : b.title
  const rowB = (H - top * 2) / Math.max(1, v.braindumps.length)
  const bx = 8, bw = 300, px = 500, pw = 252
  const by = (i: number) => top + rowB * i + rowB / 2
  const py = (i: number) => top + (H - top * 2 - projects.length * rowP) / 2 + rowP * i + rowP / 2
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'catalog-diagram', role: 'img', 'aria-label': 'Braindumps and the projects they ground' })
  const edges = svg('g', { class: 'md-edges' })
  root.append(edges)
  const pRow = new Map(projects.map((p, i) => [p.project, i]))
  for (const p of projects) for (const b of p.braindumps) {
    const i = bIndex.get(b.id)
    if (i === undefined) continue
    const y1 = by(i), y2 = py(pRow.get(p.project)!)
    edges.append(svg('path', { d: `M${bx + bw},${y1} C${bx + bw + 90},${y1} ${px - 90},${y2} ${px},${y2}`, class: 'md-edge', 'data-b': b.id, 'data-p': p.project }))
  }
  const highlight = (attr: 'data-b' | 'data-p' | null, id = '') => {
    root.classList.toggle('focus', !!attr)
    for (const e of edges.querySelectorAll('path')) e.classList.toggle('on', !!attr && e.getAttribute(attr) === id)
    for (const n of root.querySelectorAll<SVGGElement>('g.md-node')) {
      const on = !!attr && (n.dataset.id === id || [...edges.querySelectorAll(`path.on`)].some(e => e.getAttribute(n.dataset.kind === 'b' ? 'data-b' : 'data-p') === n.dataset.id))
      n.classList.toggle('on', on)
    }
  }
  const clip = (t: string, n: number) => t.length > n ? `${t.slice(0, n - 1)}…` : t
  v.braindumps.forEach((b, i) => {
    const g = svg('g', { class: `md-node md-b${b.projects.length ? '' : ' md-none'}`, transform: `translate(${bx},${by(i) - bh / 2})`, tabindex: 0, 'data-id': b.id, 'data-kind': 'b' },
      svg('title', {}, `${b.title}\n${b.projects.length ? `grounds ${b.projects.join(', ')}` : 'grounds no project in this installation\'s plan'}`),
      svg('rect', { width: bw, height: bh, rx: 8 }),
      svg('text', { x: 10, y: simple ? 16 : 17, class: 'md-title' }, clip(label(b), 40)),
      ...(simple ? [] : [svg('text', { x: 10, y: 32, class: 'md-sub' }, `${b.id} · ${b.projects.length} project${b.projects.length === 1 ? '' : 's'}`)]))
    g.addEventListener('mouseenter', () => highlight('data-b', b.id)); g.addEventListener('mouseleave', () => highlight(null))
    g.addEventListener('focus', () => highlight('data-b', b.id)); g.addEventListener('blur', () => highlight(null))
    g.addEventListener('click', () => onPick('braindump', b.id))
    root.append(g)
  })
  projects.forEach((p, i) => {
    const none = !p.braindumps.length
    const g = svg('g', { class: `md-node md-p${none ? ' md-none' : ''}${p.registered ? '' : ' md-unreg'}`, transform: `translate(${px},${py(i) - 11})`, tabindex: 0, 'data-id': p.project, 'data-kind': 'p' },
      svg('title', {}, `${p.project}${p.registered ? '' : ' (not registered)'}${!p.entry ? ' — not in the plan' : none ? ' — no ground' : ''}${p.entry && Object.keys(p.entry.roles).length ? `\nroles: ${roleText(p.entry.roles)}` : ''}`),
      svg('rect', { width: pw, height: 22, rx: 6 }),
      svg('text', { x: 9, y: 15, class: 'md-title' }, p.project),
      svg('text', { x: pw - 8, y: 15, class: 'md-sub', 'text-anchor': 'end' }, !p.entry ? 'not in plan' : none ? 'no ground' : p.entry && Object.keys(p.entry.roles).length ? clip(Object.keys(p.entry.roles).join(', '), 30) : ''))
    g.addEventListener('mouseenter', () => highlight('data-p', p.project)); g.addEventListener('mouseleave', () => highlight(null))
    g.addEventListener('focus', () => highlight('data-p', p.project)); g.addEventListener('blur', () => highlight(null))
    g.addEventListener('click', () => onPick('project', p.project))
    root.append(g)
  })
  return root
}

type Bd = CatalogView['braindumps'][number]
const challengeHref = (id: string) => `${hangoutHref()}?challenge=${encodeURIComponent(id)}`
const publishedChip = (published: boolean) => h(`span.chip.d-only.${published ? 'ok' : 'muted'}`, { title: published ? 'In the published part of the catalog (publication/github.toml selects it)' : 'Internal: not selected by publication/github.toml' }, published ? 'published' : 'internal')
// user_catalog p4: what a conversation or a request starts from — a braindump
// (cited) or a challenge (attached). The two kinds stay two kinds.
type Subject = { kind: 'braindump' | 'challenge'; id: string }
// A new conversation in aghangout with the subject already chosen in its composer.
const talkHref = (s: Subject) => `${hangoutHref()}?${s.kind === 'braindump' ? 'cite' : 'attach'}=${encodeURIComponent(s.id)}`
const lastSegment = (id: string) => id.split('/').pop()!
// A challenge that is neither resolved nor withdrawn is shown in Simple.
const liveState = (kind: string) => kind !== 'resolved' && kind !== 'withdrawn'
const firstLine = (text: string) => text.split('\n').map(l => l.trim()).find(l => l && !/^#{1,6}\s/.test(l)) ?? ''
type Editing = { kind: 'new' } | { kind: 'new-preference' } | { kind: 'braindump' | 'review' | 'preference'; id: string } | null

export function renderCatalogView(root: HTMLElement): ViewHandle {
  let data: Awaited<ReturnType<typeof api.catalog>> | null = null
  let loadError = ''
  let applied: Awaited<ReturnType<typeof api.summon>> | null = null
  let disposed = false
  let editing: Editing = null
  let message: HTMLElement | null = null
  const open = new Set<string>() // braindumps shown in full
  const openEntries = new Set<string>() // entries of the index opened in Simple
  const openPrefs = new Set<string>() // preferences opened in Simple
  let redrawDiagram: (() => void) | null = null
  const full = new Map<string, CatalogBraindump>() // texts and reviews, read when a braindump is opened
  let asked: HTMLElement | null = null // the answer to the last request to the summoner
  // Request work (user_catalog p4): one form, shown where it was asked for.
  let requesting: (Subject & { at: 'card' | 'index' }) | null = null
  let reqOut: HTMLElement | null = null
  let reqReceipt = ''
  let reqProjects: { id: string; label: string }[] | null = null
  const reqWs = h('select', { 'aria-label': 'Project' })
  const reqWf = h('select', { 'aria-label': 'Workflow' })
  const reqText = h('textarea', { rows: 5, placeholder: 'What you ask for. The braindump is given to the run as the ground of your request, not as the request itself.', 'aria-label': 'Request text' })
  const loadWorkflows = async () => {
    reqWf.replaceChildren(h('option', { value: '' }, 'reading…'))
    try {
      const ws = (await api.published(reqWs.value)).workflows.filter(w => w.id && !w.problem)
      reqWf.replaceChildren(...ws.map(w => h('option', { value: w.id! }, `${w.name || w.id}${w.errors ? ' — has validation errors' : ''}`)))
    } catch (e) { reqWf.replaceChildren(h('option', { value: '' }, `cannot be read: ${(e as Error).message}`)) }
  }
  reqWs.addEventListener('change', () => void loadWorkflows())
  const startRequest = async (s: Subject, at: 'card' | 'index') => {
    if (requesting && requesting.kind === s.kind && requesting.id === s.id && requesting.at === at) { requesting = null; render(); return }
    if (at === 'index') openEntries.add(`${s.kind}:${s.id}`)
    requesting = { ...s, at }; reqOut = null; reqReceipt = ''
    render()
    if (!reqProjects) {
      try { reqProjects = (await api.workspaces()).workspaces.filter(w => w.observed.available).map(w => ({ id: w.id, label: w.observed.projectName || w.label || w.id })) } catch (e) { reqOut = h('div.banner.error', (e as Error).message); reqProjects = null; render(); return }
      reqWs.replaceChildren(...reqProjects.map(w => h('option', { value: w.id }, w.label === w.id ? w.id : `${w.id} — ${w.label}`)))
      await loadWorkflows()
      render()
    }
  }
  const isRequesting = (s: Subject, at: 'card' | 'index') => !!requesting && requesting.kind === s.kind && requesting.id === s.id && requesting.at === at
  // The two actions of a braindump card and of an entry of the index.
  const startActions = (s: Subject, at: 'card' | 'index'): HTMLElement[] => [
    h(at === 'index' ? 'a.button.small' : 'a.button', { href: talkHref(s), target: '_blank', rel: 'noopener', title: s.kind === 'braindump' ? 'A new conversation in aghangout with this braindump cited: you write the words, whoever they reach is given the braindump with its review' : 'A new conversation in aghangout with this challenge attached' }, 'Talk about this'),
    h(at === 'index' ? 'button.small' : 'button', { 'aria-pressed': String(isRequesting(s, at)), title: s.kind === 'braindump' ? 'Ask a workflow of a project for work that stands on this braindump: the run is given your words and, beside them, the braindump as it is now' : 'Ask a workflow of a project for work on this challenge', onclick: () => void startRequest(s, at) }, 'Request work'),
  ]
  function requestForm(s: Subject): HTMLElement {
    const send = h('button.primary', { onclick: async function submit() {
      if (!haveAuthor('request', () => void submit())) return
      if (!reqWs.value || !reqWf.value || !reqText.value.trim()) { reqOut = h('div.banner.error', 'Choose a project and a workflow, and write what you ask for.'); render(); return }
      reqReceipt ||= `catalog-${Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')}`
      send.disabled = true
      try {
        const ws = reqWs.value
        const r = await api.requestRun(ws, { workflow: reqWf.value, text: reqText.value, author: author.value.trim(), receipt: reqReceipt, ...(s.kind === 'braindump' ? { cites: [s.id] } : { challenges: [s.id] }) })
        reqOut = h('div.banner.ok', `${r.duplicate ? 'Already requested' : 'Requested'}: `, h('a', { href: `#/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(r.ref.workflow)}/${encodeURIComponent(r.ref.run)}` }, `${ws}/${r.ref.workflow}/${r.ref.run}`), s.kind === 'braindump' ? ` — with ${s.id} cited.` : ` — with ${s.id} attached.`)
        reqText.value = ''; reqReceipt = ''
        if (s.kind === 'braindump') full.delete(s.id)
      } catch (e) { reqOut = h('div.banner.error', `Not requested: ${(e as Error).message}`) }
      if (s.kind === 'braindump' && open.has(s.id)) await need(s.id)
      render()
    } }, 'Request')
    return h('div.catalog-editor.catalog-request',
      h('strong.small', s.kind === 'braindump' ? `Request work that stands on ${s.id}` : `Request work on ${s.id}`),
      h('div.row', h('label.small', 'Project ', reqWs), h('label.small', 'Workflow ', reqWf)),
      reqText,
      authorSlot('request'),
      h('div.row', send, h('button', { onclick: () => { requesting = null; render() } }, 'Cancel'),
        h('span.small.muted', s.kind === 'braindump' ? 'Your words are the request. The braindump is given beside them as it is now, with its review and the projects grounded on it: the ground you stand on, not an instruction to carry out in full.' : 'Your words are the request. The challenge is given beside them as it is now.')),
      reqOut)
  }

  const author = h('input', { value: readAuthor(), placeholder: 'your name', 'aria-label': 'Author of changes', size: 14, onchange: () => keepAuthor(author.value.trim()) })
  // The name is remembered per browser. Simple does not show its field: an
  // action that needs a name not yet given asks for it where it was started
  // (a slot of that place), without a render, so a draft beside it stays.
  let authorAsk: { place: string; again: () => void } | null = null
  const authorIn = h('input', { placeholder: 'your name', 'aria-label': 'Your name', size: 16 })
  const authorPrompt = () => h('form.catalog-author-ask', { onsubmit: (e: Event) => {
    e.preventDefault()
    const name = authorIn.value.trim()
    if (!name || !authorAsk) return
    author.value = name; keepAuthor(name)
    const { again } = authorAsk
    authorAsk = null
    for (const el of main.querySelectorAll('[data-author-slot]')) el.replaceChildren()
    again()
  } }, h('label.small', 'Your name (this is done in your name; asked once per browser) ', authorIn), h('button.primary', { type: 'submit' }, 'Continue'))
  const authorSlot = (place: string) => h('div.catalog-author-slot', { dataset: { authorSlot: place } }, authorAsk?.place === place ? authorPrompt() : null)
  function haveAuthor(place: string, again: () => void): boolean {
    if (author.value.trim()) { keepAuthor(author.value.trim()); return true }
    authorAsk = { place, again }
    for (const el of main.querySelectorAll<HTMLElement>('[data-author-slot]')) el.replaceChildren()
    const slot = [...main.querySelectorAll<HTMLElement>('[data-author-slot]')].find(el => el.dataset.authorSlot === place && !!el.parentElement?.checkVisibility())
    if (slot) { slot.append(authorPrompt()); slot.scrollIntoView({ block: 'nearest' }); authorIn.focus({ preventScroll: true }) } else showDetail(() => author.focus())
    return false
  }

  const header = h('header.topbar', h('div.crumbs', h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'Catalog')),
    h('div.top-actions', h('a.button', { href: '#/' }, '← Dashboard'), ...siteLinks(),
      h('button', { onclick: () => void load(true), title: 'Read the catalog from Gitea now' }, 'Refresh'), displayToggle()))
  const main = h('main.dashboard.catalog-view')
  root.append(header, main)
  const offDisplay = onDisplay(() => redrawDiagram?.())

  async function load(refresh = false) {
    try { data = await api.catalog(refresh); loadError = '' } catch (e) { loadError = (e as Error).message }
    // summoner p2: whether each plan entry is applied here (docs/summon.md); its absence only hides the indicator.
    applied = data?.configured && data.plan ? await api.summon().catch(() => null) : null
    if (data && data.configured && !author.value && data.person) author.value = data.person
    // What is open is read again; the rest is read when opened.
    if (refresh) { const ids = [...full.keys()]; full.clear(); await Promise.all(ids.map(id => api.catalogBraindump(id).then(b => { full.set(id, b) }, () => { open.delete(id) }))) }
    if (!disposed) render()
  }
  async function need(id: string): Promise<CatalogBraindump | null> {
    if (!full.has(id)) try { full.set(id, await api.catalogBraindump(id)) } catch (e) { message = h('div.banner.error', (e as Error).message); return null }
    return full.get(id)!
  }
  const toggle = async (id: string, to?: boolean) => {
    if (to ?? !open.has(id)) { if (await need(id)) open.add(id) } else open.delete(id)
    render()
  }
  // Links inside the catalog's texts: a braindump opens here, a challenge on its page, anything else on Gitea.
  const linker = (v: CatalogView, base: string): LinkResolver => target => {
    if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(target)) return null
    const segs: string[] = target.startsWith('/') ? [] : base.split('/').filter(Boolean)
    for (const seg of target.replace(/[#?].*$/, '').split('/')) { if (seg === '..') segs.pop(); else if (seg && seg !== '.') segs.push(seg) }
    const path = segs.join('/')
    const bd = /^braindumps\/episodes\/(.+?)(\/(braindump|review)\.md)?$/.exec(path)
    if (bd && v.braindumps.some(b => b.id === bd[1])) return { href: '#/catalog', onclick: e => { e.preventDefault(); void toggle(bd[1], true).then(() => pick('braindump', bd[1])) }, data: { braindump: bd[1] } as Record<string, string> }
    const ch = /^challenges\/([^/]+)/.exec(path)
    if (ch) return { href: challengeHref(ch[1]), external: true, data: { challenge: ch[1] } as Record<string, string> }
    return { href: `${v.web}/src/branch/${v.branch}/${path}`, external: true }
  }
  const ask = async (what: string, f: () => Promise<{ href: string; workspace: string; workflow: string }>) => {
    if (!haveAuthor('index', () => void ask(what, f))) return
    asked = h('p.muted.small', 'Requesting…'); render()
    try { const r = await f(); asked = h('div.banner.ok', `Asked the summoner for ${what} (${r.workspace}/${r.workflow}). `, h('a', { href: r.href }, 'Open the run'), ' It writes to the catalog when it is done; refresh then.') } catch (e) { asked = h('div.banner.error', (e as Error).message) }
    render()
  }

  const pick = (kind: 'braindump' | 'project', id: string) => {
    const el = main.querySelector<HTMLElement>(`[data-${kind}="${CSS.escape(id)}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200)
  }

  const go = (section: string) => main.querySelector<HTMLElement>(`[data-section="${section}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  // `place` names the slot where the name is asked when it is not known yet.
  async function change(place: string, f: () => Promise<{ message: string }>) {
    if (!haveAuthor(place, () => void change(place, f))) return
    try { const r = await f(); message = h('div.banner.ok', r.message); editing = null } catch (e) { message = h('div.banner.error', (e as Error).message) }
    await load(true)
  }
  const cancel = () => h('button', { onclick: () => { editing = null; render() } }, 'Cancel')
  const newBraindump = () => h('button', { title: 'Write what you want and why, as a new braindump of the catalog', onclick: () => { editing = { kind: 'new' }; render(); go('new') } }, icon('plus', 'icon small'), 'New braindump')

  // Archive (user_catalog p6): asked first without changing anything, so that
  // the confirmation names the projects that lose this ground.
  async function archive(b: Bd) {
    const place = `bd:${b.id}`
    if (!haveAuthor(place, () => void archive(b))) return
    let d: Awaited<ReturnType<typeof api.catalogArchive>>
    try { d = await api.catalogArchive(b.id, author.value.trim(), true) } catch (e) { message = h('div.banner.error', (e as Error).message); render(); return }
    const losing = d.because.map(x => `  ${x.entry} (${x.file})${x.after.length ? '' : ': left with no ground'}`)
    if (!confirm([`Archive braindump ${b.id}${b.review ? ' and its review' : ''}?`,
      `It moves to ${d.moves[0]?.to ?? d.folder}/ and is no braindump any more: it grounds nothing, is not reviewed or indexed, and cannot be cited. It stays readable in the repository; what cited it keeps the text it cited.`,
      losing.length ? `These lose this ground:\n${losing.join('\n')}` : 'No project names it.',
      ...d.warnings].join('\n\n'))) return
    open.delete(b.id); full.delete(b.id)
    await change(place, () => api.catalogArchive(b.id, author.value.trim()))
  }

  function editor(b?: Bd): HTMLElement {
    const id = h('input', { value: '', placeholder: 'folder path: a-thought, or group/phase', 'aria-label': 'Braindump path', size: 40 })
    const text = h('textarea', { rows: 16, value: b ? full.get(b.id)?.text ?? '' : '# Title\n\nWhat I want, and why.\n', 'aria-label': 'Braindump text' })
    return h('div.catalog-editor',
      b ? null : h('label.small', 'Path below braindumps/episodes/ (it is the identity) ', id),
      text,
      authorSlot(b ? `bd:${b.id}` : 'new'),
      h('div.row', h('button.primary', { onclick: () => void change(b ? `bd:${b.id}` : 'new', () => b ? api.catalogEdit(b.id, text.value, author.value.trim(), b.updated?.commit) : api.catalogAdd(id.value.trim().replace(/^\/+|\/+$/g, ''), text.value, author.value.trim())) }, b ? 'Commit the change' : 'Add the braindump'),
        cancel(),
        h('span.small.muted', b ? `Refused if someone changed it after ${b.updated?.commit.slice(0, 7) ?? 'its last commit'}.` : 'One commit in the catalog. Group braindumps in folders as you like.')))
  }

  // The review sits below its braindump and is edited in the same place.
  function reviewBlock(b: Bd, v: CatalogView): HTMLElement {
    const r = b.review
    const text = full.get(b.id)?.review?.text ?? ''
    const askButton = h('button.small.d-only', { title: 'The summoner reads the braindump, the projects that name it and their records, and writes review.md as its own author', onclick: () => void ask(`a review of ${b.id}`, () => api.catalogReviewRequest(author.value.trim(), b.id)) }, 'Ask for a review')
    if (editing?.kind === 'review' && editing.id === b.id) {
      const area = h('textarea', { rows: 10, value: text, placeholder: 'Free text: what of this became real, where, and what did not.', 'aria-label': 'Review text' })
      return h('div.catalog-review.catalog-editor', h('strong.small', 'Review'), area,
        h('div.row', h('button.primary', { onclick: () => void change(`bd:${b.id}`, () => api.catalogReviewPut(b.id, area.value, author.value.trim(), r?.updated?.commit)) }, 'Commit the review'), cancel(),
          h('span.small.muted', 'Free text about the braindump; no form is required. You sign it as the author.')))
    }
    if (!r) return h('div.catalog-review.none', h('span.small.muted', 'No review yet. '), askButton, h('button.small.d-only', { onclick: () => { editing = { kind: 'review', id: b.id }; render() } }, 'Write a review'))
    return h('div.catalog-review',
      h('div.entry-head', h('strong.small', 'Review'), r.updated ? h('span.muted.small.d-only', `${r.updated.author} · ${when(r.updated.at)} · ${r.updated.commit.slice(0, 7)}`) : null, publishedChip(r.published),
        b.changedAfterReview ? h('span.small.stale.d-only', { title: `The braindump's last change (${b.updated?.commit.slice(0, 7)}) is newer than this review.` }, 'The braindump changed after this review') : null),
      renderMarkdown(text, linker(v, `braindumps/episodes/${b.id}`)),
      h('div.row.d-only', askButton, h('button.small', { onclick: () => { editing = { kind: 'review', id: b.id }; render() } }, 'Edit review')))
  }

  // Closed: the title, an excerpt and whether it is reviewed. Opened: the
  // text and the review, read then (api/catalog/braindumps/<path>).
  // Cited by (user_catalog p4): the conversations and runs that cited the
  // braindump, newest first, from the records written when each was made.
  function citedByBlock(b: Bd): HTMLElement | null {
    const list = full.get(b.id)?.citedBy ?? []
    return h('div.catalog-cited.d-only',
      h('strong.small', 'Cited by'),
      list.length ? h('ul', list.map(c => h('li.small',
        c.where.kind === 'conversation'
          ? h('a', { href: conversationHref(c.where.conversation), target: '_blank', rel: 'noopener' }, `conversation ${c.where.conversation}, message #${c.where.message}`)
          : h('a', { href: c.href ?? '#/' }, c.label),
        h('span.muted', ` · ${c.by} · ${when(c.at)} · at ${c.commit.slice(0, 7)}`),
        c.changed ? h('span.chip.warn', { title: 'The braindump\'s text is not what it was at the cited commit. What was cited stays as it was.' }, 'changed since') : null)))
        : h('span.small.muted', ' Nothing yet. A message or a request that cites this braindump is listed here.'))
  }
  // Titles that repeat within one folder (the two "思索") are told apart in
  // Simple by the last segment of the path, which Simple otherwise leaves out.
  let repeated = new Set<string>()
  const titleKey = (b: Bd) => `${b.id.split('/').slice(0, -1).join('/')}|${b.title}`
  function braindumpCard(b: Bd, v: CatalogView): HTMLElement {
    const edit = editing?.kind === 'braindump' && editing.id === b.id
    const whole = open.has(b.id) && full.has(b.id)
    const subject: Subject = { kind: 'braindump', id: b.id }
    const reviewNote = !b.review ? h('span.chip.muted.d-only', 'not reviewed') : b.changedAfterReview ? h('span.chip.warn.d-only', 'changed after its review') : h('span.chip.d-only', { title: b.review.updated ? `${b.review.updated.author} · ${when(b.review.updated.at)}` : '' }, 'reviewed')
    // Simple: one mark for the state, its words in the title text.
    const [markIcon, markTone, markText] = !b.review ? ['pending', 'muted', 'Not reviewed'] : b.changedAfterReview ? ['alert', 'warn', 'Changed after its review'] : ['check', 'ok', 'Reviewed']
    const pathTitle = b.title === b.id
    return h(`article.catalog-bd${whole ? '.open' : ''}${pathTitle ? '' : '.titled'}`, { dataset: { braindump: b.id } },
      h('div.entry-head', h('a.catalog-bd-title', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); void toggle(b.id) }, title: whole ? 'Close' : 'Open the text and its review' },
        h('strong', h('span.d-only', whole ? '▾ ' : '▸ '), pathTitle && b.id.includes('/') ? [h('span.d-only', b.id), h('span.s-only', lastSegment(b.id))] : b.title)),
        !pathTitle && repeated.has(titleKey(b)) ? h('code.s-only', lastSegment(b.id)) : null,
        h('code.d-only', b.id),
        reviewNote, publishedChip(b.published),
        b.cited ? h('span.chip.d-only', { title: 'Messages and requests that cited this braindump; open it to see them' }, `cited ${b.cited}`) : null,
        b.updated ? h('span.muted.small.d-only', `${b.updated.author} · ${when(b.updated.at)} · ${b.updated.commit.slice(0, 7)}`) : null,
        h('a.small.d-only', { href: `${v.web}/src/branch/${v.branch}/${b.path}`, target: '_blank', rel: 'noopener' }, 'on Gitea'),
        h(`span.catalog-mark.s-only.${markTone}`, { title: markText, role: 'img', 'aria-label': markText }, icon(markIcon, 'icon small')),
        whole ? h('button.icon-btn.catalog-close.s-only', { title: 'Close', 'aria-label': 'Close', onclick: () => void toggle(b.id, false) }, icon('close', 'icon small')) : null),
      h('div.chips', h('span.small.muted.d-only', 'grounds '), b.projects.length
        ? b.projects.map(id => { const p = v.projects.find(x => x.project === id); const href = p && projectHref(p); return href ? h('a.chip', { href }, id) : h('span.chip', id) })
        : h('span.chip.muted.d-only', `no project in ${v.plan || 'the plan'}`)),
      edit ? editor(b) : whole ? renderMarkdown(full.get(b.id)!.text ?? '', linker(v, `braindumps/episodes/${b.id}`)) : h('div.catalog-excerpt', b.excerpt),
      edit ? null : authorSlot(`bd:${b.id}`),
      !whole || edit ? null : h('div.row.d-only',
        h('button', { onclick: () => { editing = { kind: 'braindump', id: b.id }; render() } }, 'Edit'),
        h('button', { title: 'Move this braindump and its review to braindumps/archive/<date>/ and take it out of every because: it stays readable in the repository and is no braindump any more', onclick: () => void archive(b) }, 'Archive'),
        h('button.danger', { title: 'Delete the files; they stay only in the repository\'s history. To keep the text readable, archive instead.', onclick: () => { if (confirm(`Remove braindump ${b.id}${b.review ? ' and its review' : ''}? They stay in the repository's history.${b.projects.length ? `\nIt grounds ${b.projects.join(', ')}: the plan's because lists must drop it first.` : ''}`)) void change(`bd:${b.id}`, () => api.catalogRemove(b.id, author.value.trim())) } }, 'Remove')),
      whole ? reviewBlock(b, v) : null,
      !whole || edit ? null : h('div.row.catalog-bd-actions', ...startActions(subject, 'card')),
      whole && !edit && isRequesting(subject, 'card') ? requestForm(subject) : null,
      whole ? citedByBlock(b) : null)
  }

  // The index's text with the two actions on each entry (a list item that
  // links to a braindump or to a challenge): an entry of a challenge attaches
  // the challenge, an entry of a braindump cites it. Each entry also gets a
  // compact head for Simple (kind, title, the rest on one line) that opens
  // it; what is not an entry (the opening paragraph, headings) is Detail's.
  function indexText(v: CatalogView, text: string): { el: HTMLElement; entries: number } {
    const md = renderMarkdown(text, linker(v, ''))
    const done = new Set<Element>()
    const lead = /^[\s,:;—–-]+/
    for (const a of md.querySelectorAll<HTMLAnchorElement>('a[data-braindump], a[data-challenge]')) {
      const li = a.closest('li')
      if (!li || done.has(li)) continue
      done.add(li)
      const s: Subject = a.dataset.braindump ? { kind: 'braindump', id: a.dataset.braindump } : { kind: 'challenge', id: a.dataset.challenge! }
      const key = `${s.kind}:${s.id}`
      const b = s.kind === 'braindump' ? v.braindumps.find(x => x.id === s.id) : undefined
      const title = (s.kind === 'braindump' ? b && b.title !== b.id ? b.title : s.id : v.challenges.items.find(x => x.id === s.id)?.title) || s.id
      const all = li.textContent ?? '', linkText = a.textContent ?? ''
      let rest = all.slice(all.indexOf(linkText) + linkText.length).replace(lead, '')
      if (rest.startsWith(`"${title}"`)) rest = rest.slice(title.length + 2).replace(lead, '')
      const whole = h('div.nyr-full')
      whole.append(...li.childNodes)
      const head = h('a.nyr-head.s-only', { href: '#/catalog', title: 'Open this entry', onclick: (e: Event) => {
        e.preventDefault()
        if (openEntries.delete(key)) li.classList.remove('open'); else { openEntries.add(key); li.classList.add('open') }
        head.setAttribute('aria-expanded', String(openEntries.has(key)))
      } }, icon(s.kind === 'braindump' ? 'doc' : 'flag', 'icon small'), h('strong.nyr-title', title), h('span.nyr-rest', rest))
      head.setAttribute('aria-expanded', String(openEntries.has(key)))
      li.classList.add('nyr-entry')
      li.classList.toggle('open', openEntries.has(key))
      li.append(head, whole, h('span.catalog-entry-actions', ...startActions(s, 'index')))
      if (isRequesting(s, 'index')) li.append(requestForm(s))
    }
    if (done.size) {
      md.classList.add('has-entries')
      for (const c of md.children) if (!c.querySelector('.nyr-entry')) c.classList.add('d-only')
      for (const li of md.querySelectorAll('li:not(.nyr-entry)')) if (!li.querySelector('.nyr-entry')) li.classList.add('d-only')
    }
    return { el: md, entries: done.size }
  }

  // The index (challenges.md): what is not yet real, written by the summoner's workflow index.
  const askIndex = () => void ask('the index', () => api.catalogIndexRequest(author.value.trim()))
  function indexCard(v: CatalogView, body: HTMLElement | null): HTMLElement {
    const x = v.index
    return h('section.card.catalog-index', { dataset: { section: 'index' } },
      h('div.card-head', h('h2', 'Not yet real'),
        h('span.muted.small.d-only', x.updated ? `${x.path} · ${x.updated.author} · ${when(x.updated.at)} · ${x.updated.commit.slice(0, 7)}` : x.path)),
      h('p.muted.small.d-only', 'The index of what is not yet real, from both origins: a braindump that was not carried out, and a challenge (a problem found during work) that is not resolved. An agent writes it by reading the braindumps with their reviews and the challenges; it is a reading, not a state kept by hand.'),
      x.text === null ? h('p.muted', 'No index yet.') : null,
      x.stale.length ? h('div.banner.warn.d-only', x.note) : null,
      x.stale.length ? h('p.small.muted.catalog-stale.s-only', icon('history', 'icon small'), 'The catalog changed after this list was written.', h('button.small', { title: 'Ask the summoner to write the list again', onclick: askIndex }, 'Refresh')) : null,
      h(`div.row${x.text === null ? '' : '.d-only'}`, h('button', { title: 'The summoner reads every braindump with its review and every challenge that is not resolved or withdrawn, and rewrites challenges.md', onclick: askIndex }, x.text === null ? 'Write the index' : 'Refresh the index'),
        h('button.d-only', { title: 'The summoner reviews every braindump with no review or changed after its review', onclick: () => void ask('reviews of the braindumps that need one', () => api.catalogReviewRequest(author.value.trim())) }, 'Ask for the reviews that are due')),
      authorSlot('index'),
      asked,
      body)
  }

  // Preferences (user_catalog p3): how the owner wants work done; every file
  // is given to every run as system context (system/preference/<name>).
  function preferenceEditor(p?: CatalogView['preferences'][number]): HTMLElement {
    const name = h('input', { value: '', placeholder: 'name: documents, handing-over', 'aria-label': 'Preference name', size: 32 })
    const text = h('textarea', { rows: 10, value: p ? p.text : '# Subject\n\nHow I want this done, in every project.\n', 'aria-label': 'Preference text' })
    return h('div.catalog-editor',
      p ? null : h('label.small', 'File name below preferences/ (without .md) ', name),
      text,
      authorSlot(p ? `pref:${p.name}` : 'pref-new'),
      h('div.row', h('button.primary', { onclick: () => void change(p ? `pref:${p.name}` : 'pref-new', () => api.catalogPreferencePut(p ? p.name : name.value.trim().replace(/\.md$/, ''), text.value, author.value.trim(), p?.updated?.commit)) }, p ? 'Commit the change' : 'Add the preference'),
        cancel(),
        h('span.small.muted', p ? `Refused if someone changed it after ${p.updated?.commit.slice(0, 7) ?? 'its last commit'}. The next attempt of every run is prepared with the new text.` : 'One commit in the catalog. One file per subject.')))
  }
  // Detail shows each text whole; Simple a title and the first line, the text when opened.
  function preferencesCard(v: CatalogView): HTMLElement {
    return h('section.card.catalog-preferences', { dataset: { section: 'preferences' } },
      h('div.card-head', h('h2', 'Preferences'), h('span.muted.small.d-only', `${v.preferences.length} · preferences/<name>.md`)),
      h('p.muted.small.d-only', 'How you want work done, in every project: the language of documents, how results are handed over, what a report starts with. Every file here is given whole to every run and every authoring session (the context\'s system sources). What you want and why is a braindump; facts about machines stay in the system context.'),
      h('div.row.d-only', h('button', { onclick: () => { editing = { kind: 'new-preference' }; render() } }, 'New preference')),
      editing?.kind === 'new-preference' ? preferenceEditor() : null,
      v.preferences.length ? v.preferences.map(p => {
        const edit = editing?.kind === 'preference' && editing.id === p.name
        const card: HTMLElement = h(`article.catalog-bd.catalog-pref${openPrefs.has(p.name) ? '.open' : ''}`, { dataset: { preference: p.name } },
          h('div.entry-head', h('a.catalog-bd-title', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); if (!openPrefs.delete(p.name)) openPrefs.add(p.name); card.classList.toggle('open', openPrefs.has(p.name)) } }, h('strong', p.title)),
            p.title === p.name ? null : h('code.d-only', p.name), publishedChip(p.published),
            p.updated ? h('span.muted.small.d-only', `${p.updated.author} · ${when(p.updated.at)} · ${p.updated.commit.slice(0, 7)}`) : null,
            h('a.small.d-only', { href: `${v.web}/src/branch/${v.branch}/${p.path}`, target: '_blank', rel: 'noopener' }, 'on Gitea')),
          edit ? preferenceEditor(p) : [h('div.catalog-excerpt.pref-first.s-only', firstLine(p.text)), h('div.pref-text', renderMarkdown(p.text, linker(v, 'preferences')))],
          edit ? null : authorSlot(`pref:${p.name}`),
          edit ? null : h('div.row.d-only',
            h('button', { onclick: () => { editing = { kind: 'preference', id: p.name }; render() } }, 'Edit'),
            h('button.danger', { onclick: () => { if (confirm(`Remove preference ${p.name}? It stays in the repository's history; runs are no longer given it.`)) void change(`pref:${p.name}`, () => api.catalogPreferenceRemove(p.name, author.value.trim())) } }, 'Remove')))
        return card
      }) : h('p.muted', 'No preferences yet.'))
  }

  // The owner's challenges, by state; a challenge is read and written on its own page.
  function challengesCard(v: CatalogView): HTMLElement {
    const c = v.challenges
    const order = ['open', 'custom', 'unspecified', 'resolved', 'withdrawn']
    const groups = order.map(k => ({ kind: k, items: c.items.filter(i => i.stateKind === k) })).filter(g => g.items.length)
    return h('section.card.catalog-challenges', { dataset: { section: 'challenges' } },
      h('div.card-head', h('h2', 'Challenges'), h('span.muted.small.d-only', c.available ? Object.entries(c.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ') || 'none' : '')),
      h('p.muted.small.d-only', 'Problems found during work, with the trials made on them. They stay a kind of their own: a challenge is not turned into a braindump, nor a braindump into a challenge.'),
      !c.available ? h('p.muted', c.reason) : null,
      c.available && !c.inCatalog ? h('div.banner.warn.d-only', `These challenges are not in this catalog: ${c.reason}.`) : null,
      groups.map(g => h(`div.catalog-ch-group${liveState(g.kind) ? '' : '.d-only'}`, h('div.catalog-folder-name.d-only', g.kind),
        g.items.map(i => h('div.catalog-ch', { dataset: { challenge: i.id } },
          h('a', { href: challengeHref(i.id), target: '_blank', rel: 'noopener' }, icon('flag', 'icon small s-only'), h('code.d-only', i.id), ' ', i.title || '(no summary)'),
          g.kind === 'custom' && i.state ? h('span.chip', i.state) : null,
          i.projects.map(p => h('span.chip', p)),
          i.trials ? h('span.small.muted.d-only', `${i.trials} trial${i.trials === 1 ? '' : 's'}`) : null,
          publishedChip(i.published),
          h('span.muted.small.d-only', `${i.updated.by} · ${when(i.updated.at)}`))))),
      c.available && c.items.length && !c.items.some(i => liveState(i.stateKind)) ? h('p.muted.s-only', 'No open challenge.') : null,
      c.available && !c.items.length ? h('p.muted', 'No challenges yet.') : null)
  }

  // Braindumps grouped by their folder paths: a folder that holds several is
  // shown as a group; a braindump whose folder has braindumps below it comes
  // first, with those indented under it.
  // Those with nothing below come before the folders, so that in Simple's grid
  // a folder's heading is followed only by its own.
  function tree(items: Bd[], v: CatalogView, depth = 0): HTMLElement[] {
    const groups = [...new Set(items.map(b => b.id.split('/')[depth]))].map(seg => {
      const here = items.filter(b => b.id.split('/')[depth] === seg)
      const own = here.find(b => b.id.split('/').length === depth + 1)
      return { own, below: here.filter(b => b !== own) }
    })
    const out: HTMLElement[] = groups.filter(g => g.own && !g.below.length).map(g => braindumpCard(g.own!, v))
    for (const { own, below } of groups.filter(g => g.below.length)) {
      if (own) out.push(braindumpCard(own, v))
      out.push(h('div.catalog-folder', own ? null : h('div.catalog-folder-name', `${below[0].id.split('/').slice(0, depth + 1).join('/')}/`), tree(below, v, depth + 1)))
    }
    return out
  }

  // One indicator per plan entry: its applied state here (wfe summon status).
  function appliedChip(project: string): HTMLElement | null {
    const e = applied?.entries.find(x => x.project === project)
    if (!e) return null
    const kind = e.applied === 'applied' || e.applied === 'adopted' || e.applied === 'ahead' ? 'ok' : 'warn'
    return h(`span.chip.${kind}`, { title: `${e.detail}${e.upstream ? `\nupstream ${e.upstream.url} @ ${e.upstream.commit.slice(0, 10)}` : ''}${e.roles.inEffect.length ? `\nroles in effect: ${e.roles.inEffect.join(', ')}` : ''}` }, e.applied)
  }

  function render() {
    main.replaceChildren()
    if (loadError) { main.append(h('div.banner.error', loadError)); return }
    if (!data) { main.append(h('p.muted', 'Reading the catalog…')); return }
    if (!data.configured) {
      main.append(h('section.card', h('h2', 'Catalog'), h('p', data.reason), h('p.muted.small', 'Your catalog (<owner>/mycatalog) holds your braindumps (what you want and why), their reviews, and the summonplans that say which projects make them concrete here (docs/mycatalog.md).')))
      return
    }
    const v = data
    const count = new Map<string, number>()
    for (const b of v.braindumps) count.set(titleKey(b), (count.get(titleKey(b)) ?? 0) + 1)
    repeated = new Set([...count].filter(([, n]) => n > 1).map(([k]) => k))
    const index = v.index.text === null ? null : indexText(v, v.index.text)
    const live = v.challenges.items.filter(i => liveState(i.stateKind)).length
    const trouble = v.problems.length + v.issues.length
    main.append(h('section.card.catalog-head',
      h('div.card-head', h('h2', v.title || 'Catalog'),
        h('div.row', h('a.small.d-only', { href: v.web, target: '_blank', rel: 'noopener' }, `${v.repository} @ ${v.head.slice(0, 7)}`),
          h('label.small.d-only', 'Author of changes ', author),
          newBraindump())),
      h('p.muted.small.d-only', `Braindumps are free text on what you want and why: the grounds of the projects here. A review is free text about a braindump: what became real, where, what did not. Which projects each braindump grounds is recorded in this installation's summonplan (${v.plan ? `summonplans/${v.plan}.yaml` : 'none named'}), not in the projects.`),
      message,
      trouble ? h('p.small.s-only.catalog-trouble', icon('alert', 'icon small'), h('a', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); showDetail(() => window.scrollTo(0, 0)) } }, `${trouble} problem${trouble === 1 ? '' : 's'} with the catalog: see Detail`)) : null,
      ...v.problems.map(p => h('div.banner.warn.d-only', p)),
      v.issues.length ? h('ul.issues.d-only', v.issues.map(x => h(`li.${x.issue.severity}`, `${x.where}: ${x.issue.message}`))) : null))
    // The summary: four counts, each a way to its part.
    const stat = (name: string, n: string | number, label: string, section: string) => h('a.catalog-stat', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); go(section) } }, icon(name), h('strong', String(n)), h('span', label))
    main.append(h('nav.catalog-summary', { 'aria-label': 'What the catalog holds' },
      stat('doc', v.braindumps.length, v.braindumps.length === 1 ? 'braindump' : 'braindumps', 'braindumps'),
      !index ? h('div.catalog-stat', icon('pending'), h('span', 'no index of what is not yet real'), h('button.small', { onclick: () => { go('index'); askIndex() } }, 'Write the index'))
        : stat('pending', index.entries || '', index.entries ? 'not yet real' : 'what is not yet real', 'index'),
      stat('flag', live, live === 1 ? 'open challenge' : 'open challenges', 'challenges'),
      stat('settings', v.preferences.length, v.preferences.length === 1 ? 'preference' : 'preferences', 'preferences')))
    if (editing?.kind === 'new') main.append(h('section.card', { dataset: { section: 'new' } }, h('h2', 'New braindump'), editor()))
    const reviewed = v.braindumps.filter(b => b.review).length
    main.append(h('section.card', { dataset: { section: 'braindumps' } }, h('div.card-head', h('h2', 'Braindumps'), h('span.muted.small.d-only', `${reviewed} of ${v.braindumps.length} reviewed · ${v.braindumps.filter(b => b.published).length} published`)), v.braindumps.length ? h('div.catalog-bds', tree(v.braindumps, v))
      : h('div.catalog-empty', h('p', 'No braindumps yet. A braindump is free text on what you want and why: it is what the projects here stand on.'), editing?.kind === 'new' ? null : h('div.row', newBraindump())),
      v.archived.length ? h('p.small.muted.d-only.catalog-archived', { title: 'Archived braindumps are kept in the repository to be read. They ground nothing, are not reviewed or indexed, and cannot be cited.' }, 'Archived: ',
        v.archived.map((a, i) => [i ? ' · ' : '', h('a', { href: a.web, target: '_blank', rel: 'noopener' }, a.name), ` (${a.braindumps} braindump${a.braindumps === 1 ? '' : 's'}, on Gitea)`])) : null))
    main.append(indexCard(v, index?.el ?? null))
    const grounded = v.projects.filter(p => p.braindumps.length).length
    const diagram = h('div.catalog-diagram-wrap')
    // Simple has no projects table: a project of the diagram leads to its page.
    const picked = (kind: 'braindump' | 'project', id: string) => {
      const p = kind === 'project' ? v.projects.find(x => x.project === id) : undefined
      const href = p && projectHref(p)
      if (kind === 'project' && isSimple()) { if (href) location.hash = href } else pick(kind, id)
    }
    redrawDiagram = () => { diagram.className = `catalog-diagram-wrap${isSimple() ? ' compact' : ''}`; diagram.replaceChildren(relationDiagram(v, picked, isSimple())) }
    redrawDiagram()
    // With no braindump there is nothing to relate: Detail still shows the projects, Simple nothing.
    main.append(h(`section.card.catalog-relations${v.braindumps.length ? '' : '.d-only'}`, { dataset: { section: 'relations' } },
      h('div.card-head', h('h2', 'Braindumps and projects'), h('span.muted.small.d-only', `${v.braindumps.length} braindumps · ${grounded} of ${v.projects.length} projects grounded`)),
      h('p.muted.small.d-only', 'Hover or focus a box to follow its edges; click to jump to it below.'),
      diagram))
    // Side by side in Simple where there is room.
    main.append(h('div.catalog-pair', challengesCard(v), preferencesCard(v)))
    main.append(h('section.card.d-only', h('h2', 'Projects and why they are here'),
      h('table.catalog-projects', h('thead', h('tr', h('th', 'Project'), h('th', 'Grounds'), h('th', 'Roles'), h('th', 'Entry'))),
        h('tbody', v.projects.map(p => h('tr', { dataset: { project: p.project } },
          h('td', projectHref(p) ? h('a', { href: projectHref(p)! }, p.project) : p.project, p.registered ? null : h('span.chip.warn', 'not registered')),
          h('td', !p.entry ? h('span.muted', 'not in the plan') : p.braindumps.length ? h('div.chips', p.braindumps.map(b => h('a.chip', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); pick('braindump', b.id) }, title: b.title }, b.id + (b.missing ? ' (missing)' : '')))) : h('span.chip.warn', 'no ground')),
          h('td.small', p.entry ? roleText(p.entry.roles) : ''),
          h('td.small.muted', appliedChip(p.project), p.entry ? `${p.entry.state} · ${p.entry.commit.slice(0, 7)}${p.entry.note ? ` · ${p.entry.note}` : ''}` : '')))))))
    main.append(styleCard())
  }

  // summoner p5 ex1: naming a GitHub user who publishes <user>/mycatalog is
  // enough to import their development style. Checking first shows the
  // catalog; requesting starts summoner/propose, which asks before applying.
  const styleUser = h('input', { placeholder: 'GitHub user', 'aria-label': 'GitHub user', size: 16 })
  let styleOut: HTMLElement | null = null
  function styleCard() {
    const run = (dry: boolean) => {
      const user = styleUser.value.trim()
      if (!user) return
      if (!dry && !haveAuthor('style', () => run(false))) return
      styleOut = h('p.muted.small', dry ? 'Reading the catalog…' : 'Requesting…'); render()
      void api.summonStyle(user, author.value.trim(), dry).then(r => {
        styleOut = h('div',
          h('p.small', h('a', { href: r.catalog, target: '_blank', rel: 'noopener' }, r.catalog), ` @ ${r.commit.slice(0, 7)}: `, r.projects.map(p => p.project).join(', ')),
          dry ? h('div.row', h('button.primary', { onclick: () => run(false) }, `Ask the summoner to propose ${r.user}'s style`))
            : h('p.small', 'Requested. ', r.href ? h('a', { href: r.href }, 'Open the summoner\'s run') : null, ' — it writes a proposal and asks you before anything is applied.'))
        render()
      }, e => { styleOut = h('div.banner.error', (e as Error).message); render() })
    }
    return h('section.card.catalog-style.d-only', h('h2', 'Import a development style'),
      h('p.muted.small', 'Name a GitHub user who publishes their catalog as <user>/mycatalog. The summoner proposes the projects of that catalog that are not here yet, and asks you before anything is applied.'),
      h('div.row', styleUser, h('button', { onclick: () => run(true) }, 'Read the catalog')),
      authorSlot('style'),
      styleOut)
  }

  render()
  void load()
  return { dispose: () => { disposed = true; offDisplay() }, isDirty: () => editing !== null || (requesting !== null && !!reqText.value.trim()) }
}

// The project page's section (#/ws/<workspace>): why this project exists.
export function whySection(project: string): HTMLElement {
  const card = h('section.card.catalog-why', h('h2', 'Why this project exists'), h('p.muted.small', 'Reading the catalog…'))
  void api.catalogWhy(project).then(w => {
    card.replaceChildren(h('div.card-head', h('h2', 'Why this project exists'), h('a.more-link.small', { href: '#/catalog' }, 'Catalog')))
    if (!w.entry) { card.append(h('p.muted.small', `Not in this installation's plan (${w.plan || 'none named'}).`)); return }
    if (!w.braindumps.length) card.append(h('div.banner.warn', `No ground: no braindump says why ${project} is here.${w.entry.note ? ` (${w.entry.note})` : ''}`))
    for (const b of w.braindumps) card.append(h('div.catalog-bd', h('div.entry-head', h('strong', b.title), h('a.small', { href: '#/catalog' }, b.id)), h('div.catalog-text.small', b.excerpt)))
    card.append(h('p.muted.small', `${w.plan}: ${w.entry.state} · ${w.entry.commit.slice(0, 7)}${Object.keys(w.entry.roles).length ? ` · roles ${roleText(w.entry.roles)}` : ''}${w.elsewhere.length ? ` · also in ${w.elsewhere.map(e => e.plan).join(', ')}` : ''}`))
  }, (e: Error) => card.replaceChildren(h('h2', 'Why this project exists'), h('p.muted.small', e.message)))
  return card
}
