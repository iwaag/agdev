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
import { api, type CatalogBraindump, type CatalogTagProposal, type CatalogView } from './api.ts'
import { EXAMPLE_TAGS, normalizeTag, RECOMMENDED_TAG, sameTag } from '../shared/catalog.ts'
import { composePanel } from './catalogCompose.ts'
import { draftsPanel } from './catalogDrafts.ts'
import { publicationPanel } from './catalogPublication.ts'
import { displayToggle, isSimple, onDisplay, showDetail } from './displayMode.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import type { ViewHandle } from './main.ts'
import { renderMarkdown, type LinkResolver } from './markdown.ts'
import { conversationHref, forgetWaiting, hangoutHref, siteLinks } from './site.ts'

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
  // user_catalog p7: links the summoner suggested and the owner has not answered are drawn dashed.
  const suggested = (v.links.suggestion?.links ?? []).filter(x => x.state === 'suggested' && x.kind === 'add')
  const projects = v.projects.filter(p => !simple || p.braindumps.length || suggested.some(x => x.project === p.project)).sort((a, b) => {
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
  for (const x of suggested) {
    const i = bIndex.get(x.braindump), j = pRow.get(x.project)
    if (i === undefined || j === undefined) continue
    const y1 = by(i), y2 = py(j)
    edges.append(svg('path', { d: `M${bx + bw},${y1} C${bx + bw + 90},${y1} ${px - 90},${y2} ${px},${y2}`, class: 'md-edge md-suggested', 'data-b': x.braindump, 'data-p': x.project }, svg('title', {}, `Suggested: ${x.braindump} → ${x.project}`)))
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
  // user_catalog p8: a project's disclosure as a mark on its node.
  const disc = new Map((v.disclosure?.projects ?? []).map(l => [l.project, l]))
  const mark = (id: string) => { const l = disc.get(id); return !l ? null : l.state === 'private' ? { c: 'private', t: '🔒', w: `kept private${l.decides?.rule ? ` (rule ${l.decides.rule})` : ' (proposed, not answered)'}: “${l.decides?.sentence ?? ''}”` } : l.state === 'to be published' ? { c: 'topublish', t: '↗', w: `to be published (rule ${l.decides?.rule}): “${l.decides?.sentence ?? ''}”` } : l.state === 'public' || l.state === 'public without a statement' ? { c: 'public', t: '🌐', w: `public: ${l.public.map(x => x.destination).join(', ')}` } : null }
  projects.forEach((p, i) => {
    const none = !p.braindumps.length
    const m = mark(p.project)
    const g = svg('g', { class: `md-node md-p${none ? ' md-none' : ''}${p.registered ? '' : ' md-unreg'}`, transform: `translate(${px},${py(i) - 11})`, tabindex: 0, 'data-id': p.project, 'data-kind': 'p' },
      svg('title', {}, `${p.project}${p.registered ? '' : ' (not registered)'}${!p.entry ? ' — not in the plan' : none ? ' — no ground' : ''}${p.entry && Object.keys(p.entry.roles).length ? `\nroles: ${roleText(p.entry.roles)}` : ''}${m ? `\n${m.w}` : ''}`),
      svg('rect', { width: pw, height: 22, rx: 6 }),
      svg('text', { x: 9, y: 15, class: 'md-title' }, m ? `${p.project} ${m.t}` : p.project),
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
type Editing = { kind: 'new' } | { kind: 'new-preference' } | { kind: 'braindump' | 'review' | 'preference' | 'tags'; id: string } | null

// user_catalog p6 ex1: optional tags. The input keeps its own DOM (no render
// while typing); the examples add a tag when clicked and are never preselected.
const TAG_HINTS: Record<string, string> = {
  [RECOMMENDED_TAG]: 'Recommended by agdev: a braindump about how you write, tag and handle braindumps. Agents read it as your stated conventions; it changes no setting.',
  style: 'how you like development to be done', desire: 'a concrete result you want', bounty: 'something you would like someone else to do',
  public: 'you mean it to be published', private: 'you mean it to stay internal',
  todo: 'something you mean to do yourself', mystyle: 'how you develop',
}
// user_catalog p8 decision 18: the tags offered, each with its meaning in a few words and what a rule makes follow from it.
export type TagChoice = { tag: string; meaning: string }
export function tagChoicesOf(v: CatalogView): TagChoice[] {
  const inUse = new Map<string, { tag: string; n: number }>()
  for (const b of v.braindumps) for (const t of b.tags) { const k = t.toLowerCase(); inUse.set(k, { tag: inUse.get(k)?.tag ?? t, n: (inUse.get(k)?.n ?? 0) + 1 }) }
  const order = [...[...inUse.values()].sort((a, b) => b.n - a.n).map(x => x.tag), ...EXAMPLE_TAGS]
  const seen = new Set<string>(), out: TagChoice[] = []
  for (const t of order) {
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    const r = v.rules.find(x => x.kind === 'tag' && x.tag && sameTag(x.tag, t))
    const follows = r ? (r.follows === 'never-publish' ? 'your rule: never published' : 'your rule: suggested for the public list (nothing is published by it)') : ''
    const meaning = TAG_HINTS[k] ?? (inUse.has(k) ? `in use on ${inUse.get(k)!.n} braindump${inUse.get(k)!.n === 1 ? '' : 's'}` : 'a tag')
    out.push({ tag: inUse.get(k)?.tag ?? t, meaning: follows ? `${meaning} — ${follows}` : meaning })
  }
  return out
}
export const tagChips = (tags: readonly string[]) => tags.length ? h('span.catalog-tags', tags.map(t => h('span.chip.tag', { title: TAG_HINTS[t.toLowerCase()] ?? 'a tag' }, `#${t}`))) : null
export function tagInput(initial: readonly string[], onChange?: (tags: string[]) => void, choices?: TagChoice[]): { el: HTMLElement; value: () => string[] } {
  let tags = [...initial]
  const list = h('span.catalog-tags')
  const note = h('span.small.muted')
  const input = h('input', { placeholder: 'add a tag', 'aria-label': 'Add a tag', size: 14 })
  const examples = h('span.catalog-tag-examples.small')
  const draw = () => {
    list.replaceChildren(...tags.map(t => h('span.chip.tag.removable', { title: TAG_HINTS[t.toLowerCase()] ?? '' }, `#${t}`,
      h('button.icon-btn', { type: 'button', title: `Remove ${t}`, 'aria-label': `Remove ${t}`, onclick: () => { tags = tags.filter(x => x !== t); draw(); onChange?.(tags) } }, '×'))))
    if (choices) {
      const left = choices.filter(c => !tags.some(t => sameTag(t, c.tag)))
      examples.replaceChildren(h('span.muted', 'Choose: '), ...left.map(c => h('button.chip.tag.example', { type: 'button', title: c.meaning, onclick: () => add(c.tag) }, `+${c.tag}`)),
        h('ul.catalog-tag-meanings', left.map(c => h('li', h('strong', `#${c.tag}`), ` ${c.meaning}`))))
      return
    }
    examples.replaceChildren(h('span.muted', 'Examples: '), ...EXAMPLE_TAGS.filter(e => !tags.some(t => sameTag(t, e))).map(e =>
      h('button.chip.tag.example', { type: 'button', title: TAG_HINTS[e], onclick: () => add(e) }, `+${e}`, e === RECOMMENDED_TAG ? h('span.muted', ' (recommended)') : null)))
  }
  const add = (raw: string) => {
    for (const part of raw.split(',')) {
      if (!part.trim()) continue
      const n = normalizeTag(part)
      if ('problem' in n) { note.textContent = `Not added: ${n.problem}`; continue }
      note.textContent = ''
      if (!tags.some(t => sameTag(t, n.tag))) tags.push(n.tag)
    }
    input.value = ''; draw(); onChange?.(tags)
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input.value) } })
  input.addEventListener('blur', () => { if (input.value.trim()) add(input.value) })
  draw()
  return { el: h('div.catalog-tag-input', h('div.row', h('strong.small', 'Tags'), list, input), examples, note,
    h('p.small.muted', 'Optional and free: use any words, as many as you like, or none. A tag asks for nothing by itself (public does not publish).')), value: () => { if (input.value.trim()) add(input.value); return [...tags] } }
}

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
  const tagFilter = new Set<string>() // tags (lower case) a braindump must have to be listed
  const proposalPicks = new Map<string, Set<string>>() // per proposal, the changes ticked (none is ticked first)
  let redrawDiagram: (() => void) | null = null
  const full = new Map<string, CatalogBraindump>() // texts and reviews, read when a braindump is opened
  // The answer to the last request to the summoner, shown where it was asked: 'index' or 'bd:<path>'.
  let asked: { place: string; el: HTMLElement } | null = null
  const askedAt = (place: string) => asked?.place === place ? asked.el : null
  // user_catalog p6 ex1: a request still open is shown in place of its button
  // (key: what was asked), checked every 10 s; when its run ends the button is back
  // and the catalog is read again. The service also returns an open one instead of a second run.
  const pending = new Map<string, { workspace: string; workflow: string; run: string; href: string } | null>()
  let pendingPoll: ReturnType<typeof setInterval> | null = null
  const watchPending = () => {
    if (pendingPoll) return
    pendingPoll = setInterval(async () => {
      let ended = false
      for (const [key, p] of pending) {
        if (!p) continue
        const st = await api.run(p.workspace, p.workflow, p.run).then(r => r.record?.cancelled ? 'cancelled' : r.record?.execution?.state, () => undefined)
        if (st === 'completed' || st === 'cancelled' || st === 'stopped') { pending.delete(key); ended = true }
      }
      if (![...pending.values()].some(Boolean)) { clearInterval(pendingPoll!); pendingPoll = null }
      if (ended && !disposed) await load(true)
    }, 10_000)
  }
  const askControl = (key: string, button: HTMLElement): HTMLElement => {
    if (!pending.has(key)) return button
    const p = pending.get(key)
    return p ? h('a.chip.warn', { href: p.href, title: 'Asked; this request is still open. Its button comes back when the run has ended.' }, `Asked: ${p.workflow}/${p.run} (open)`) : h('span.chip.muted', 'Asking…')
  }
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

  // user_catalog p6 ex1: drafts, written without a path and saved outside Git; the card keeps its own DOM.
  const drafts = draftsPanel({ author: () => author.value.trim(), haveAuthor, authorSlot, registered: () => load(true) })
  // improve_publish p3: what is public and why, per project, and the owner's requests; the elements keep their own DOM.
  const pub = publicationPanel({ author: () => author.value.trim(), haveAuthor, authorSlot, changed: () => load(true) })
  // user_catalog p6 ex2: the writing field, always there; the card keeps its own DOM.
  const compose = composePanel({ author: () => author.value.trim(), haveAuthor, authorSlot, changed: () => load(true), tagChoices: () => data?.configured ? tagChoicesOf(data) : [] })
  const editInField = async (b: Bd) => { const fb = await need(b.id); if (!fb) { render(); return } await compose.edit({ id: b.id, title: b.title === b.id ? lastSegment(b.id) : b.title, text: fb.text ?? '', base: b.updated?.commit }) }
  // user_catalog p6 ex2: while the follow-up is waiting or the summoner is reading, the catalog is read every 15 s.
  let fuPoll: ReturnType<typeof setInterval> | null = null
  const followActive = (v: CatalogView) => Object.values(v.followUp.braindumps).some(x => x.state !== 'not-done') || (!!v.followUp.index && v.followUp.index.state !== 'not-done')
  const quiet = () => editing === null && !(requesting !== null && !!reqText.value.trim())
  function watchFollowUp() {
    if (fuPoll || !data?.configured || !followActive(data)) return
    fuPoll = setInterval(async () => {
      if (disposed || !data?.configured) return
      const before = JSON.stringify(data.followUp)
      const next = await api.catalog().catch(() => null)
      if (!next?.configured) return
      const active = followActive(next)
      if (!active) { clearInterval(fuPoll!); fuPoll = null }
      if ((JSON.stringify(next.followUp) !== before || !active) && quiet()) await load(true)
    }, 15_000)
  }

  const header = h('header.topbar', h('div.crumbs', h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'Catalog')),
    h('div.top-actions', h('a.button', { href: '#/' }, '← Dashboard'), ...siteLinks('catalog'),
      h('button', { onclick: () => void load(true), title: 'Read the catalog from Gitea now' }, 'Refresh'), displayToggle()))
  const main = h('main.dashboard.catalog-view')
  root.append(header, main)
  const offDisplay = onDisplay(() => redrawDiagram?.())

  async function load(refresh = false) {
    forgetWaiting()
    try { data = await api.catalog(refresh); loadError = '' } catch (e) { loadError = (e as Error).message }
    // summoner p2: whether each plan entry is applied here (docs/summon.md); its absence only hides the indicator.
    applied = data?.configured && data.plan ? await api.summon().catch(() => null) : null
    if (data && data.configured && !author.value && data.person) author.value = data.person
    // What is open is read again; the rest is read when opened.
    if (refresh) { const ids = [...full.keys()]; full.clear(); await Promise.all(ids.map(id => api.catalogBraindump(id).then(b => { full.set(id, b) }, () => { open.delete(id) }))) }
    if (data?.configured) await Promise.all([drafts.load(), compose.load()])
    if (data?.configured) pub.setQuestions(data.waiting.items.flatMap(i => i.question ? [i.question] : []))
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
  const ask = async (what: string, f: () => Promise<{ href: string; workspace: string; workflow: string; run: string; duplicate: boolean }>, place = 'index', key = place) => {
    if (pending.has(key)) return
    if (!haveAuthor(place, () => void ask(what, f, place, key))) return
    pending.set(key, null)
    asked = { place, el: h('p.muted.small', 'Requesting…') }; render()
    try {
      const r = await f()
      pending.set(key, { workspace: r.workspace, workflow: r.workflow, run: r.run, href: r.href }); watchPending()
      asked = { place, el: h('div.banner.ok', { role: 'status' }, r.duplicate ? `Already asked: ${what} is still open (${r.workspace}/${r.workflow}/${r.run}); no second run was made. ` : `Asked ${r.workspace === 'publisher' ? 'the publisher' : 'the summoner'} for ${what} (${r.workspace}/${r.workflow}/${r.run}). `, h('a', { href: r.href }, 'Open the run'), ' The page reads the catalog again when it has ended.') }
    } catch (e) { pending.delete(key); asked = { place, el: h('div.banner.error', { role: 'alert' }, (e as Error).message) } }
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
    try { const r = await f(); message = h('div.banner.ok', r.message); editing = null } catch (e) {
      // A refused change keeps what was typed: the reason is shown where the
      // change was made, and the page is not drawn again (user_catalog p6).
      const slot = [...main.querySelectorAll<HTMLElement>('[data-author-slot]')].find(el => el.dataset.authorSlot === place && !!el.parentElement?.checkVisibility())
      if (slot) { slot.replaceChildren(h('div.banner.error', { role: 'alert' }, (e as Error).message)); slot.scrollIntoView({ block: 'nearest' }); return }
      message = h('div.banner.error', (e as Error).message)
    }
    await load(true)
  }
  const cancel = () => h('button', { onclick: () => { editing = null; render() } }, 'Cancel')
  // A braindump added directly (one commit now), beside writing a draft (saved outside Git until registered).
  const newBraindump = () => h('button.d-only', { title: 'Add a braindump to the catalog directly, in one commit now (a draft is saved outside Git until you register it)', onclick: () => { editing = { kind: 'new' }; render(); go('new') } }, icon('plus', 'icon small'), 'Add a braindump directly')
  const writeDraft = () => h('button.primary.d-only', { title: 'Write freely, saved as you type outside Git; ask for advice; register it when you choose', onclick: () => { drafts.start(); go('drafts') } }, icon('plus', 'icon small'), 'Write a draft')

  // user_catalog p6 ex2: what the follow-up is doing for a braindump, in Simple's words.
  function followUpWords(v: CatalogView, b: Bd): string | null {
    const fu = v.followUp.braindumps[b.id]
    if (!fu) return null
    if (fu.state === 'reading') return 'The summoner is reading it.'
    if (fu.state === 'waiting') return `The summoner reads it${fu.dueAt ? ` from ${new Date(fu.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' shortly'}.`
    return `Not reviewed by itself: ${fu.reason ?? 'no reason given'}. Detail has Ask for a review.`
  }
  // user_catalog p6 ex2: a proposal of tags is one line with OK (all of it) and No.
  function tagLines(b: Bd): HTMLElement | null {
    if (!b.openProposals.length) return null
    const place = `bd:${b.id}`
    return h('div.s-only', b.openProposals.map(p => h('div.catalog-tag-line', { title: `Suggested by ${p.by}` }, h('span.small', 'Suggested tags: '),
      h('span.catalog-tags', p.changes.map(c => h(`span.chip.tag${c.op === 'remove' ? '.warn' : ''}`, `${c.op === 'add' ? '+' : '−'}${c.tag}`))),
      h('button.small.primary', { onclick: () => void change(place, () => api.catalogTagDecide(p.id, author.value.trim(), p.changes.map(c => `${c.op}:${c.tag}`))) }, 'OK'),
      h('button.small', { onclick: () => void change(place, () => api.catalogTagDecide(p.id, author.value.trim(), null)) }, 'No'))))
  }
  // user_catalog p7: what an adopted rule says about a braindump, where it acts.
  function ruleLine(b: Bd, v: CatalogView): HTMLElement | null {
    if (!b.rule) return null
    const rule = (id?: string) => v.rules.find(r => r.id === id)
    const never = rule(b.rule.never), suggest = rule(b.rule.suggest)
    if (never) return h('p.small.catalog-rule-line', { title: `Rule ${never.id}, adopted from “${never.source.braindump}”: “${never.source.sentence}”` }, icon('lock', 'icon small'),
      `Kept private by your rule: #${never.tag} is never published.`, suggest ? ` It is also tagged #${suggest.tag}, which you suggest for the public list: private wins.` : '',
      b.published ? h('span.chip.warn', { title: 'publication/github.toml selects it: the check before a publication refuses this' }, 'in the public list: refused') : null)
    if (suggest && !b.rule.selected) return h('div.catalog-tag-line.catalog-rule-line', { title: `Rule ${suggest.id}, adopted from “${suggest.source.braindump}”: “${suggest.source.sentence}”` },
      h('span.small', `Your rule suggests this for the public list (#${suggest.tag}).`),
      h('button.small.primary', { title: 'Writes it into the public file list in one commit. Nothing is published by it: publishing stays your act.', onclick: () => void change(`bd:${b.id}`, () => api.catalogPublicationAdd(b.id, author.value.trim())) }, 'Add to the public list'))
    return null
  }
  // user_catalog p7: links suggested by the summoner, one line each with OK and No; one click is one commit.
  const suggestLinks = () => void ask('suggested links', () => api.catalogLinksRequest(author.value.trim()), 'links', 'ground')
  function linksBlock(v: CatalogView): HTMLElement[] {
    const s = v.links.suggestion
    const title = (id: string) => { const b = v.braindumps.find(x => x.id === id); return b && b.title !== b.id ? b.title : id }
    const open = (s?.links ?? []).filter(x => x.state === 'suggested')
    const adds = open.filter(x => x.kind === 'add')
    const n = v.links.pending.length
    return [
      n ? h('div.catalog-tag-line.catalog-links-pending', h('span.small', `${n} braindump${n === 1 ? ' has' : 's have'} no suggested links yet: `),
        askControl('ground', h('button.small.primary', { title: 'The summoner reads every braindump and every project and suggests which braindump grounds which project. Nothing is written until you answer each link.', onclick: suggestLinks }, 'Suggest links')),
        h('span.small.muted.d-only', v.links.pending.join(', '))) : null,
      authorSlot('links'), askedAt('links'),
      open.length ? h('div.catalog-suggested', h('div.row', h('strong.small', 'Suggested links'),
        adds.length > 1 ? h('button.small.primary', { title: 'Every suggested link, in one commit in your name', onclick: () => void change('links', () => api.catalogLinksAgree(author.value.trim(), 'all')) }, 'OK to all') : null),
        open.map(x => h('div.catalog-tag-line.catalog-link-line',
          h('span.small.catalog-link-words', h('strong', title(x.braindump)), x.kind === 'add' ? ' → ' : ' no longer grounds ', h('strong', x.project),
            x.quote ? h('span.catalog-link-quote', ` “${x.quote}”`) : null, x.why ? h('span.muted', ` ${x.why}`) : null),
          h('button.small.primary', { onclick: () => void change('links', () => api.catalogLinksAgree(author.value.trim(), [x.n])) }, 'OK'),
          h('button.small', { onclick: () => void change('links', () => api.catalogLinksDecline(author.value.trim(), [x.n])) }, 'No')))) : null,
      s ? h('p.small.muted.d-only', `Suggestion ${s.id} by ${s.by}${s.run ? ` (${s.run})` : ''}, ${when(s.at)}, on catalog ${s.head.slice(0, 7)}${s.behind ? ' (the catalog moved on since)' : ''}: ${s.links.filter(x => x.state === 'agreed').length} agreed, ${s.links.filter(x => x.state === 'declined').length} declined, ${s.links.filter(x => x.state === 'gone').length} gone, ${open.length} open${s.existing ? `; ${s.existing} existed already` : ''}.${s.ungrounded.length ? ` Without a ground: ${s.ungrounded.join(', ')}.` : ''}${s.note ? ` ${s.note}` : ''}`) : null,
      h('div.row.d-only', askControl('ground', h('button.small', { onclick: suggestLinks }, s ? 'Suggest links again' : 'Suggest links'))),
    ].filter((x): x is HTMLElement => !!x)
  }
  // user_catalog p8 decision 17: what waits for you, at the top of the page; its count is on the navigation.
  const askPublisher = (target: string | undefined, place: string) => void ask(target ? `a publication of ${target}` : 'a publication of the catalog', () => api.catalogPublicationRequest(target, author.value.trim()), place, `publish:${target ?? 'mycatalog'}`)
  const publisherButton = (target: string | undefined, place: string, label = 'Ask the publisher') => askControl(`publish:${target ?? 'mycatalog'}`, h('button.small.primary', { title: target ? `The publisher reads ${target}, edits and assesses what is worth publishing, and publishes it; "nothing worth publishing now" is a valid answer. Its questions come back on its run.` : 'The publisher reads what the public list selects, has the summoner change the catalog where needed, and publishes it. Its questions come back on its run.', onclick: () => askPublisher(target, place) }, label))
  function waitingCard(v: CatalogView): HTMLElement | null {
    const w = v.waiting
    if (!w?.items.length) return null
    const line = (i: CatalogView['waiting']['items'][number]) => {
      const words = h('span.small.catalog-link-words', h('strong', i.title), i.detail ? h('span.muted', ` ${i.detail}`) : null)
      const buttons = i.kind === 'answer' && i.ask ? [h('button.small.primary', { onclick: () => void compose.openAsked(i.ask!.draft) }, 'Open the answer')]
        : i.kind === 'links' ? [h('button.small', { onclick: () => go('relations') }, 'Answer them')]
        : (i.kind === 'disclosure' || i.kind === 'licence') && i.n !== undefined ? [
          h('button.small.primary', { title: 'Adopt it as your rule: one commit of rules.yaml in your name', onclick: () => void change('waiting', () => api.catalogDisclosureAnswer(i.n!, true, author.value.trim())) }, 'OK'),
          h('button.small', { title: 'Nothing follows from this sentence', onclick: () => void change('waiting', () => api.catalogDisclosureAnswer(i.n!, false, author.value.trim())) }, 'No')]
        : i.kind === 'publication' ? [publisherButton(undefined, 'waiting')]
        : i.kind === 'publisher' && i.question ? []
        : i.href ? [h('a.button.small', { href: i.href }, 'Open the run')] : []
      // improve_publish p3: the publisher's question, answered here in one batch (the same question as on its run).
      if (i.kind === 'publisher' && i.question) return h('div.catalog-waiting-line.publisher.pub-asks', words, pub.answer(i.question))
      return h(`div.catalog-tag-line.catalog-waiting-line.${i.kind}`, words, ...buttons)
    }
    return h('section.card.catalog-waiting', { dataset: { section: 'waiting' } },
      h('div.card-head', h('h2', 'Waiting for you'), h('span.chip.warn', String(w.count))),
      w.items.map(line), authorSlot('waiting'), askedAt('waiting'))
  }
  // user_catalog p8: what is public, what waits for a publication, what is kept private and by which sentence, what is not decided.
  function publicCard(v: CatalogView): HTMLElement | null {
    const d = v.disclosure, c = v.publicationCheck
    if (!d && !v.publication) return null
    const repo = (url: string) => { const u = url.replace(/\.git$/, ''); return h('a', { href: u, target: '_blank', rel: 'noopener' }, u.replace(/^https:\/\//, '')) }
    const pubB = v.braindumps.filter(b => b.published)
    const pubP = (d?.projects ?? []).filter(l => l.public.length)
    const toPublish = (d?.projects ?? []).filter(l => l.state === 'to be published')
    const privP = (d?.projects ?? []).filter(l => l.state === 'private')
    const privB = v.braindumps.filter(b => b.rule?.never)
    const add = (c?.suggestions ?? []).map(x => x.braindump)
    const sentence = (l: { decides?: { rule?: string; braindump: string; sentence: string } }) => l.decides ? h('span.muted', ` ${l.decides.rule ? '' : '(proposed, not answered) '}from ${l.decides.braindump}: “${l.decides.sentence}”`) : null
    const title = (id: string) => v.braindumps.find(b => b.id === id)?.title ?? id
    return h('section.card.catalog-public', { dataset: { section: 'public' } },
      h('div.card-head', h('h2', 'Public'), v.publication ? h('span.muted.small', v.publication.last ? `last published ${v.publication.last.at.slice(0, 10)} from ${v.publication.last.sourceRev.slice(0, 7)}` : 'not published yet') : null),
      h('h3.small', 'Public now'),
      h('ul.small', v.publication?.destination ? h('li', 'The catalog: ', repo(v.publication.destination), pubB.length ? ` — ${pubB.length} braindump${pubB.length === 1 ? '' : 's'} in its public list: ${pubB.map(b => b.title).join(', ')}` : ' — no braindump in its public list') : null,
        pubP.map(l => h('li', h('strong', l.project), ' ', ...l.public.flatMap((p, i) => [i ? ', ' : '', repo(p.destination)]), l.state === 'public without a statement' ? h('span.muted', ' (no braindump states it)') : sentence(l)))),
      v.publication?.changedSince || add.length || toPublish.length || c?.rulesFile === 'suggested' ? [h('h3.small', 'Waiting for a publication'),
        v.publication?.changedSince ? h('div.catalog-tag-line', h('span.small', v.publication.last ? 'The public list changed since the last publication.' : 'The catalog\'s public list is not published yet.'), publisherButton(undefined, 'public')) : null,
        add.map(id => h('div.catalog-tag-line', h('span.small', `“${title(id)}” is tagged for the public list and is not in it.`), h('button.small', { onclick: () => void change('public', () => api.catalogPublicationAdd(id, author.value.trim())) }, 'Add to the public list'))),
        c?.rulesFile === 'suggested' ? h('div.catalog-tag-line', h('span.small', 'Your conventions are in the public list; the rules adopted from them (rules.yaml) are not.'), h('button.small', { onclick: () => void change('public', () => api.catalogPublicationAdd('rules.yaml', author.value.trim())) }, 'Add rules.yaml')) : null,
        toPublish.map(l => h('div.catalog-tag-line', h('span.small', h('strong', l.project), ' is to be published', sentence(l)), publisherButton(l.project, 'public')))] : null,
      privP.length || privB.length ? [h('h3.small', 'Kept private'), h('ul.small',
        privP.map(l => h('li', h('strong', l.project), sentence(l), l.note ? h('span.muted', ` — ${l.note}`) : null)),
        privB.map(b => h('li', `“${b.title}”`, h('span.muted', ` tagged #${v.rules.find(r => r.id === b.rule!.never)?.tag ?? 'private'}`))))] : null,
      c?.undecided.length ? [h('h3.small', 'Not decided'), h('p.small', 'No rule covers these braindumps: they stay internal until you tag them. ', c.undecided.map(title).join(', '))] : null,
      c?.projectMentions.some(m => m.allowed === undefined) ? h('p.small', `Files of the public list that name a private project; the publication tool refuses them until the text is generalized or the contract records why the name is needed: ${[...new Set(c.projectMentions.filter(m => m.allowed === undefined).map(m => `${m.path} (${m.project})`))].join(', ')}.`) : null,
      c?.projectMentions.some(m => m.allowed !== undefined) ? h('p.small.muted.d-only', `A private project's name kept where the public text needs it: ${[...new Set(c.projectMentions.filter(m => m.allowed !== undefined).map(m => `${m.path} (${m.project}: ${m.allowed})`))].join(', ')}.`) : null,
      // improve_publish p3: per project, what is public, why, what is kept local and what waits; requests from a line.
      h('h3.small', 'Per project: what is public, and why'),
      h('div.pub-projects', v.publication?.destination ? pub.project('mycatalog', 'The catalog (mycatalog)') : null,
        [...pubP, ...toPublish].filter(l => l.workspace).map(l => pub.project(l.project))),
      h('p.small.muted.d-only', 'Read from each project\'s publication contract, journal and holds by the publication tool (wfe catalog publication facts <project>). Changing it is a request: Keep local takes effect at once and the project\'s agent records it; Propose asks the publisher, which asks you once on the exact change. History already public is never rewritten.'),
      d?.licence?.rule ? h('p.small.muted', `Default licence of a first publication: ${d.licence.rule.licence}, from “${d.licence.rule.source.braindump}”: “${d.licence.rule.source.sentence}”. Your own preference: never shared as style.`) : null,
      authorSlot('public'), askedAt('public'))
  }
  // Detail: the adopted rules with their sources.
  function rulesCard(v: CatalogView): HTMLElement | null {
    if (!v.rules.length) return null
    return h('section.card.catalog-rules.d-only', { dataset: { section: 'rules' } }, h('div.card-head', h('h2', 'Rules'), h('span.muted.small', `${v.rules.length} · rules.yaml`)),
      h('p.muted.small', 'What you adopted from your own words: tag rules from your conventions (the braindumps tagged mybraindump), rules on projects and the default licence from any braindump\'s sentence. A rule is adopted from an answer of the summoner (Ask), from OK on a statement under Waiting for you, or with wfe catalog rules adopt; reading a sentence never activates one.'),
      v.rules.map(r => h('div.catalog-rule', h('div.entry-head', h('strong', r.kind === 'content' ? `${r.content === 'runs' ? 'run records' : r.content}${r.project ? ` of ${r.project}` : ''}` : r.kind === 'tag' ? `#${r.tag}` : r.kind === 'project' ? `project ${r.project}` : `licence ${r.licence}`),
        h('span', r.kind === 'licence' ? 'is the default licence of a first publication (never shared as style)' : r.kind === 'content' ? (r.follows === 'never-publish' ? 'are never published' : 'are proposed for publication by this sentence (the publisher reads it)') : r.follows === 'never-publish' ? 'is never published' : r.follows === 'publish' ? 'is to be published' : 'is suggested for the public list'), h('code', r.id),
        r.sourceChanged ? h('span.chip.warn', { title: r.sourceNote ?? '' }, 'its source changed') : null,
        h('button.small', { title: 'Nothing follows from it any more. Nothing becomes public by it, and nothing public is withdrawn.', onclick: () => { if (confirm(`Retire the rule ${r.id}? Nothing follows from it afterwards.`)) void change('rules', () => api.catalogRuleRetire(r.id, author.value.trim())) } }, 'Retire')),
        h('p.small', `From “${r.source.braindump}” at ${r.source.commit.slice(0, 7)}: “${r.source.sentence}”`),
        h('p.small.muted', `Adopted by ${r.adopted.by}, ${when(r.adopted.at)}.${r.sourceChanged ? ` ${r.sourceNote}. The rule stays in force; ask the summoner what to adopt, change or retire.` : ''}`))),
      authorSlot('rules'),
      v.publicationCheck && (v.publicationCheck.refusals.length || v.publicationCheck.mentions.length) ? h('div.banner.warn', h('strong', 'The public list: '),
        h('ul', v.publicationCheck.refusals.map(x => h('li.small', `${x.path} is selected, and #${x.tag} is never published (rule ${x.rule}): a publication is refused.`)),
          v.publicationCheck.mentions.map(x => h('li.small', `${x.path} is selected and names “${x.braindump}” (kept private by rule ${x.rule}) by its ${x.by}.`)))) : null)
  }
  // user_catalog p6 ex2: renaming (Detail): the files move and every because is rewritten, in one commit.
  async function rename(b: Bd) {
    const place = `bd:${b.id}`
    if (!haveAuthor(place, () => void rename(b))) return
    const to = prompt(`New path for ${b.id} (below braindumps/episodes/). Its review and tags move with it; plans that name it are rewritten; what cited the old path shows it removed.`, b.id)?.trim().replace(/^\/+|\/+$/g, '')
    if (!to || to === b.id) return
    open.delete(b.id); full.delete(b.id)
    await change(place, () => api.catalogMove(b.id, to, author.value.trim()))
  }

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
    const id = h('input', { value: '', placeholder: 'folder path: a-thought, or group/phase', 'aria-label': 'Braindump path', size: 40, oninput: () => id.setCustomValidity('') })
    const text = h('textarea', { rows: 16, value: b ? full.get(b.id)?.text ?? '' : '# Title\n\nWhat I want, and why.\n', 'aria-label': 'Braindump text' })
    return h('div.catalog-editor',
      b ? null : h('label.small', 'Path below braindumps/episodes/ (it is the identity) ', id),
      text,
      authorSlot(b ? `bd:${b.id}` : 'new'),
      h('div.row', h('button.primary', { onclick: () => {
        // The path is asked for before anything is sent; the text stays as typed.
        if (!b && !id.value.trim()) { id.setCustomValidity('Give the braindump a path: a folder name such as a-thought, or group/phase.'); id.reportValidity(); id.focus(); return }
        void change(b ? `bd:${b.id}` : 'new', () => b ? api.catalogEdit(b.id, text.value, author.value.trim(), b.updated?.commit) : api.catalogAdd(id.value.trim().replace(/^\/+|\/+$/g, ''), text.value, author.value.trim()))
      } }, b ? 'Commit the change' : 'Add the braindump'),
        cancel(),
        h('span.small.muted', b ? `Refused if someone changed it after ${b.updated?.commit.slice(0, 7) ?? 'its last commit'}.` : 'One commit in the catalog. Group braindumps in folders as you like.')))
  }

  // The review sits below its braindump and is edited in the same place.
  function reviewBlock(b: Bd, v: CatalogView): HTMLElement {
    const r = b.review
    const text = full.get(b.id)?.review?.text ?? ''
    const askButton = askControl(`review:${b.id}`, h('button.small.d-only', { title: 'The summoner reads the braindump, the projects that name it and their records, and writes review.md as its own author', onclick: () => void ask(`a review of ${b.id}`, () => api.catalogReviewRequest(author.value.trim(), b.id), `bd:${b.id}`, `review:${b.id}`) }, 'Ask for a review'))
    if (editing?.kind === 'review' && editing.id === b.id) {
      const area = h('textarea', { rows: 10, value: text, placeholder: 'Free text: what of this became real, where, and what did not.', 'aria-label': 'Review text' })
      return h('div.catalog-review.catalog-editor', h('strong.small', 'Review'), area,
        h('div.row', h('button.primary', { onclick: () => void change(`bd:${b.id}`, () => api.catalogReviewPut(b.id, area.value, author.value.trim(), r?.updated?.commit)) }, 'Commit the review'), cancel(),
          h('span.small.muted', 'Free text about the braindump; no form is required. You sign it as the author.')))
    }
    if (!r) return h('div.catalog-review.none', h('span.small.muted', followUpWords(v, b) ?? 'No review yet. '), askButton, h('button.small.d-only', { onclick: () => { editing = { kind: 'review', id: b.id }; render() } }, 'Write a review'), askedAt(`bd:${b.id}`))
    return h('div.catalog-review',
      h('div.entry-head', h('strong.small', 'Review'), r.updated ? h('span.muted.small.d-only', `${r.updated.author} · ${when(r.updated.at)} · ${r.updated.commit.slice(0, 7)}`) : null, publishedChip(r.published),
        b.changedAfterReview ? h('span.small.stale.d-only', { title: `The braindump's last change (${b.updated?.commit.slice(0, 7)}) is newer than this review.` }, 'The braindump changed after this review') : null,
        b.changedAfterReview && followUpWords(v, b) ? h('span.small.muted.s-only', followUpWords(v, b)!) : null),
      renderMarkdown(text, linker(v, `braindumps/episodes/${b.id}`)),
      h('div.row.d-only', askButton, h('button.small', { onclick: () => { editing = { kind: 'review', id: b.id }; render() } }, 'Edit review')),
      askedAt(`bd:${b.id}`))
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
  // Tags of an opened braindump: shown, edited in place, and the open proposals
  // of agents with a box per change (none ticked first); accepting the ticked
  // ones is one commit in your name. A stale proposal is shown, not applied.
  function tagsBlock(b: Bd): HTMLElement {
    const fb = full.get(b.id)
    const proposals: CatalogTagProposal[] = fb?.proposals ?? []
    const place = `bd:${b.id}`
    if (editing?.kind === 'tags' && editing.id === b.id) {
      const t = tagInput(b.tags, undefined, data?.configured ? tagChoicesOf(data) : undefined)
      return h('div.catalog-editor.catalog-tags-edit', t.el,
        h('div.row', h('button.primary', { onclick: () => void change(place, () => api.catalogTags(b.id, t.value(), author.value.trim(), b.metadata?.updated?.commit ?? 'none')) }, 'Commit the tags'), cancel(),
          h('span.small.muted', 'One commit of metadata.yaml beside the braindump; its text is not touched.')))
    }
    // user_catalog p8: the tags and their control in Simple as in Detail; the agents' proposals with boxes are Detail's (Simple has the OK / No line).
    return h('div.catalog-tags-block',
      h('div.row', tagChips(b.tags) ?? h('span.small.muted', 'No tags.'), h('button.small', { onclick: () => { editing = { kind: 'tags', id: b.id }; render() } }, b.tags.length ? 'Edit tags' : 'Add tags'),
        b.metadata?.problem ? h('span.chip.warn', { title: b.metadata.problem }, 'metadata.yaml cannot be read') : null),
      h('div.d-only', proposals.map(p => {
        const picks = proposalPicks.get(p.id) ?? new Set<string>()
        proposalPicks.set(p.id, picks)
        return h(`div.catalog-proposal${p.stale ? '.stale' : ''}`,
          h('div.small', h('strong', 'Proposed tags'), ` by ${p.by}${p.run ? ` (${p.run})` : ''} · ${when(p.at)}`, p.stale ? h('span.chip.warn', { title: p.staleReason }, 'stale') : null),
          p.stale ? h('p.small.stale', `${p.staleReason}. It is not applied; read the braindump again, set the tags yourself, or dismiss it.`) : null,
          h('ul', p.changes.map(c => {
            const key = `${c.op}:${c.tag}`
            const box = h('input', { type: 'checkbox', disabled: p.stale, checked: picks.has(key), onchange: () => { if (box.checked) picks.add(key); else picks.delete(key) } })
            return h('li.small', h('label', box, ' ', h(`span.chip.tag${c.op === 'remove' ? '.warn' : ''}`, `${c.op === 'add' ? '+' : '−'}${c.tag}`), ' ', c.reason))
          })),
          p.note ? h('p.small.muted', p.note) : null,
          h('div.row', p.stale ? null : h('button.primary.small', { onclick: () => {
            if (!picks.size) { alert('Tick the changes you accept, or dismiss the proposal.'); return }
            void change(place, () => api.catalogTagDecide(p.id, author.value.trim(), [...picks]))
          } }, 'Accept the ticked'), h('button.small', { onclick: () => void change(place, () => api.catalogTagDecide(p.id, author.value.trim(), null)) }, 'Dismiss')))
      })))
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
    const fu = v.followUp.braindumps[b.id]
    const [markIcon, markTone, markText] = fu && fu.state !== 'not-done' ? ['history', 'warn', followUpWords(v, b)!]
      : fu ? ['alert', 'warn', followUpWords(v, b)!]
        : !b.review ? ['pending', 'muted', 'Not reviewed'] : b.changedAfterReview ? ['alert', 'warn', 'Changed after its review'] : ['check', 'ok', 'Reviewed']
    const pathTitle = b.title === b.id
    return h(`article.catalog-bd${whole ? '.open' : ''}${pathTitle ? '' : '.titled'}`, { dataset: { braindump: b.id } },
      h('div.entry-head', h('a.catalog-bd-title', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); void toggle(b.id) }, title: whole ? 'Close' : 'Open the text and its review' },
        h('strong', h('span.d-only', whole ? '▾ ' : '▸ '), pathTitle && b.id.includes('/') ? [h('span.d-only', b.id), h('span.s-only', lastSegment(b.id))] : b.title)),
        !pathTitle && repeated.has(titleKey(b)) ? h('code.s-only', lastSegment(b.id)) : null,
        h('code.d-only', b.id),
        reviewNote, publishedChip(b.published),
        b.cited ? h('span.chip.d-only', { title: 'Messages and requests that cited this braindump; open it to see them' }, `cited ${b.cited}`) : null,
        whole ? h('span.s-only', tagChips(b.tags)) : tagChips(b.tags),
        fu ? h(`${fu.href ? 'a' : 'span'}.chip.warn`, { ...(fu.href ? { href: fu.href } : {}), title: fu.reason ?? markText }, fu.state === 'not-done' ? 'not reviewed' : 'the summoner is reading it') : null,
        b.proposals ? h('span.chip.warn.d-only', { title: 'An agent proposed tags; open the braindump to accept or dismiss them' }, `${b.proposals} tag proposal${b.proposals === 1 ? '' : 's'}`) : null,
        b.updated ? h('span.muted.small.d-only', `${b.updated.author} · ${when(b.updated.at)} · ${b.updated.commit.slice(0, 7)}`) : null,
        h('a.small.d-only', { href: `${v.web}/src/branch/${v.branch}/${b.path}`, target: '_blank', rel: 'noopener' }, 'on Gitea'),
        h(`span.catalog-mark.s-only.${markTone}`, { title: markText, role: 'img', 'aria-label': markText }, icon(markIcon, 'icon small')),
        whole ? h('button.icon-btn.catalog-close.s-only', { title: 'Close', 'aria-label': 'Close', onclick: () => void toggle(b.id, false) }, icon('close', 'icon small')) : null),
      h('div.chips', h('span.small.muted.d-only', 'grounds '), b.projects.length
        ? b.projects.map(id => { const p = v.projects.find(x => x.project === id); const href = p && projectHref(p); return href ? h('a.chip', { href }, id) : h('span.chip', id) })
        : h('span.chip.muted.d-only', `no project in ${v.plan || 'the plan'}`)),
      whole && !edit ? tagsBlock(b) : null,
      edit ? null : tagLines(b),
      b.uncovered ? h('p.small.muted.catalog-uncovered', { title: b.uncovered }, icon('pending', 'icon small'), 'No project serves this.', h('span.d-only', ` ${b.uncovered}`)) : null,
      ruleLine(b, v),
      edit ? editor(b) : whole ? renderMarkdown(full.get(b.id)!.text ?? '', linker(v, `braindumps/episodes/${b.id}`)) : h('div.catalog-excerpt', b.excerpt),
      edit ? null : authorSlot(`bd:${b.id}`),
      !whole || edit ? null : h('div.row.d-only',
        h('button', { title: 'Edit the text here and commit it at once (Edit puts it in the writing field instead)', onclick: () => { editing = { kind: 'braindump', id: b.id }; render() } }, 'Edit directly'),
        h('button', { title: 'Give this braindump another path: its files move, every because naming it is rewritten, in one commit', onclick: () => void rename(b) }, 'Rename…'),
        h('button', { title: 'Move this braindump and its review to braindumps/archive/<date>/ and take it out of every because: it stays readable in the repository and is no braindump any more', onclick: () => void archive(b) }, 'Archive'),
        h('button.danger', { title: 'Delete the files; they stay only in the repository\'s history. To keep the text readable, archive instead.', onclick: () => { if (confirm(`Remove braindump ${b.id}${b.review ? ' and its review' : ''}? They stay in the repository's history.${b.projects.length ? `\nIt grounds ${b.projects.join(', ')}: the plan's because lists must drop it first.` : ''}`)) void change(`bd:${b.id}`, () => api.catalogRemove(b.id, author.value.trim())) } }, 'Remove')),
      whole ? reviewBlock(b, v) : null,
      !whole || edit ? null : h('div.row.catalog-bd-actions', h('button', { title: 'Put its text in the writing field above; Update it commits the change', onclick: () => void editInField(b) }, 'Edit'), ...startActions(subject, 'card')),
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
  const askIndex = () => void ask('the index', () => api.catalogIndexRequest(author.value.trim()), 'index', 'index')
  function indexCard(v: CatalogView, body: HTMLElement | null): HTMLElement {
    const x = v.index
    const fi = v.followUp.index
    const fuIndex = !fi ? null : fi.state === 'not-done' ? `Not rewritten by itself: ${fi.reason ?? 'no reason given'}. Detail has Refresh the index.` : fi.state === 'reading' ? 'The summoner is rewriting this list.' : 'The summoner rewrites this list after reading what changed.'
    return h('section.card.catalog-index', { dataset: { section: 'index' } },
      h('div.card-head', h('h2', 'Not yet real'),
        h('span.muted.small.d-only', x.updated ? `${x.path} · ${x.updated.author} · ${when(x.updated.at)} · ${x.updated.commit.slice(0, 7)}` : x.path)),
      h('p.muted.small.d-only', 'The index of what is not yet real, from both origins: a braindump that was not carried out, and a challenge (a problem found during work) that is not resolved. An agent writes it by reading the braindumps with their reviews and the challenges; it is a reading, not a state kept by hand.'),
      x.text === null ? h('p.muted', 'No list yet.', fuIndex ? ` ${fuIndex}` : '') : null,
      x.stale.length ? h('div.banner.warn.d-only', x.note) : null,
      x.text !== null && (x.stale.length || fuIndex) ? h('p.small.muted.catalog-stale.s-only', icon('history', 'icon small'), fuIndex ?? 'The catalog changed after this list was written.') : null,
      fuIndex ? h('p.small.muted.d-only', `Follow-up: ${fuIndex}${v.followUp.index?.run ? ` (${v.followUp.index.run})` : ''}`) : null,
      h('div.row.d-only', askControl('index', h('button', { title: 'The summoner reads every braindump with its review and every challenge that is not resolved or withdrawn, and rewrites challenges.md', onclick: askIndex }, x.text === null ? 'Write the index' : 'Refresh the index')),
        askControl('reviews', h('button.d-only', { title: 'The summoner reviews every braindump with no review or changed after its review', onclick: () => void ask('reviews of the braindumps that need one', () => api.catalogReviewRequest(author.value.trim()), 'index', 'reviews') }, 'Ask for the reviews that are due'))),
      authorSlot('index'),
      askedAt('index'),
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
          writeDraft(), newBraindump())),
      h('p.muted.small.d-only', `Braindumps are free text on what you want and why: the grounds of the projects here. A review is free text about a braindump: what became real, where, what did not. Which projects each braindump grounds is recorded in this installation's summonplan (${v.plan ? `summonplans/${v.plan}.yaml` : 'none named'}), not in the projects.`),
      message,
      !v.followUp.enabled ? h('p.small.muted.d-only', 'The follow-up is off (catalog.json "followUp": false): reviews and the index are asked for with the buttons only.') : null,
      trouble ? h('p.small.s-only.catalog-trouble', icon('alert', 'icon small'), h('a', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); showDetail(() => window.scrollTo(0, 0)) } }, `${trouble} problem${trouble === 1 ? '' : 's'} with the catalog: see Detail`)) : null,
      ...v.problems.map(p => h('div.banner.warn.d-only', p)),
      v.issues.length ? h('ul.issues.d-only', v.issues.map(x => h(`li.${x.issue.severity}`, `${x.where}: ${x.issue.message}`))) : null))
    const wc = waitingCard(v)
    if (wc) main.append(wc)
    main.append(compose.card)
    // The summary: four counts, each a way to its part.
    const stat = (name: string, n: string | number, label: string, section: string) => h('a.catalog-stat', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); go(section) } }, icon(name), h('strong', String(n)), h('span', label))
    main.append(h('nav.catalog-summary', { 'aria-label': 'What the catalog holds' },
      stat('doc', v.braindumps.length, v.braindumps.length === 1 ? 'braindump' : 'braindumps', 'braindumps'),
      !index ? h('div.catalog-stat', icon('pending'), h('span', 'no index of what is not yet real'), h('button.small.d-only', { onclick: () => { go('index'); askIndex() } }, 'Write the index'))
        : stat('pending', index.entries || '', index.entries ? 'not yet real' : 'what is not yet real', 'index'),
      stat('flag', live, live === 1 ? 'open challenge' : 'open challenges', 'challenges'),
      stat('settings', v.preferences.length, v.preferences.length === 1 ? 'preference' : 'preferences', 'preferences')))
    main.append(drafts.card)
    if (editing?.kind === 'new') main.append(h('section.card', { dataset: { section: 'new' } }, h('h2', 'New braindump'), editor()))
    const reviewed = v.braindumps.filter(b => b.review).length
    // user_catalog p6 ex1: a row of the tags in use filters the list (a braindump with every chosen tag).
    const inUse = new Map<string, { tag: string; n: number }>()
    for (const b of v.braindumps) for (const t of b.tags) { const k = t.toLowerCase(); inUse.set(k, { tag: inUse.get(k)?.tag ?? t, n: (inUse.get(k)?.n ?? 0) + 1 }) }
    for (const k of [...tagFilter]) if (!inUse.has(k)) tagFilter.delete(k)
    const shown = tagFilter.size ? v.braindumps.filter(b => [...tagFilter].every(k => b.tags.some(t => t.toLowerCase() === k))) : v.braindumps
    const filterRow = inUse.size ? h('div.catalog-tag-filter.row', { role: 'group', 'aria-label': 'Filter by tag' }, h('span.small.muted', 'Tags:'),
      [...inUse].sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => h(`button.chip.tag${tagFilter.has(k) ? '.on' : ''}`, { 'aria-pressed': String(tagFilter.has(k)), onclick: () => { if (!tagFilter.delete(k)) tagFilter.add(k); render() } }, `#${x.tag}`, h('span.muted', ` ${x.n}`))),
      tagFilter.size ? h('button.small', { onclick: () => { tagFilter.clear(); render() } }, `Show all ${v.braindumps.length}`) : null) : null
    main.append(h(`section.card${v.braindumps.length ? '' : '.d-only'}`, { dataset: { section: 'braindumps' } }, h('div.card-head', h('h2', 'Braindumps'), h('span.muted.small.d-only', `${reviewed} of ${v.braindumps.length} reviewed · ${v.braindumps.filter(b => b.published).length} published`)), filterRow, v.braindumps.length ? h('div.catalog-bds', shown.length ? tree(shown, v) : h('p.muted', 'No braindump has every chosen tag.'))
      : h('div.catalog-empty', h('p', 'No braindumps yet. A braindump is free text on what you want and why: it is what the projects here stand on.'), editing?.kind === 'new' ? null : h('div.row', writeDraft(), newBraindump())),
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
      h('p.muted.small.d-only', 'Hover or focus a box to follow its edges; click to jump to it below. A dashed line is a suggested link you have not answered.'),
      diagram, ...linksBlock(v)))
    const pc = publicCard(v)
    if (pc) main.append(pc)
    // Side by side in Simple where there is room.
    main.append(h('div.catalog-pair', challengesCard(v), preferencesCard(v)))
    main.append(h('section.card.d-only', h('h2', 'Projects and why they are here'),
      h('table.catalog-projects', h('thead', h('tr', h('th', 'Project'), h('th', 'Grounds'), h('th', 'Roles'), h('th', 'Entry'))),
        h('tbody', v.projects.map(p => h('tr', { dataset: { project: p.project } },
          h('td', projectHref(p) ? h('a', { href: projectHref(p)! }, p.project) : p.project, p.registered ? null : h('span.chip.warn', 'not registered')),
          h('td', !p.entry ? h('span.muted', 'not in the plan') : p.braindumps.length ? h('div.chips', p.braindumps.map(b => h('a.chip', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); pick('braindump', b.id) }, title: b.title }, b.id + (b.missing ? ' (missing)' : '')))) : h('span.chip.warn', 'no ground')),
          h('td.small', p.entry ? roleText(p.entry.roles) : ''),
          h('td.small.muted', appliedChip(p.project), p.entry ? `${p.entry.state} · ${p.entry.commit.slice(0, 7)}${p.entry.note ? ` · ${p.entry.note}` : ''}` : '')))))))
    const rc = rulesCard(v)
    if (rc) main.append(rc)
    main.append(styleCard())
    watchFollowUp()
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
  return { dispose: () => { disposed = true; offDisplay(); drafts.dispose(); compose.dispose(); if (pendingPoll) clearInterval(pendingPoll); if (fuPoll) clearInterval(fuPoll) }, isDirty: () => editing !== null || (requesting !== null && !!reqText.value.trim()) || drafts.isDirty() || compose.isDirty() || pub.isDirty() }
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
