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
import { api, type CatalogBraindump, type CatalogView } from './api.ts'
import { h, when } from './dom.ts'
import type { ViewHandle } from './main.ts'
import { renderMarkdown, type LinkResolver } from './markdown.ts'
import { hangoutHref, siteLinks } from './site.ts'

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
// ungrounded ones come last, drawn as such.
export function relationDiagram(v: CatalogView, onPick: (kind: 'braindump' | 'project', id: string) => void): SVGSVGElement {
  const bIndex = new Map(v.braindumps.map((b, i) => [b.id, i]))
  const projects = [...v.projects].sort((a, b) => {
    const fa = a.braindumps.length ? Math.min(...a.braindumps.map(x => bIndex.get(x.id) ?? 99)) : 1e3
    const fb = b.braindumps.length ? Math.min(...b.braindumps.map(x => bIndex.get(x.id) ?? 99)) : 1e3
    return fa - fb || a.project.localeCompare(b.project)
  })
  const W = 760, rowP = 26, top = 16
  const H = Math.max(projects.length * rowP, v.braindumps.length * 54) + top * 2
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
    const g = svg('g', { class: `md-node md-b${b.projects.length ? '' : ' md-none'}`, transform: `translate(${bx},${by(i) - 20})`, tabindex: 0, 'data-id': b.id, 'data-kind': 'b' },
      svg('title', {}, `${b.title}\n${b.projects.length ? `grounds ${b.projects.join(', ')}` : 'grounds no project in this installation\'s plan'}`),
      svg('rect', { width: bw, height: 40, rx: 8 }),
      svg('text', { x: 10, y: 17, class: 'md-title' }, clip(b.title, 44)),
      svg('text', { x: 10, y: 32, class: 'md-sub' }, `${b.id} · ${b.projects.length} project${b.projects.length === 1 ? '' : 's'}`))
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
const publishedChip = (published: boolean) => h(`span.chip.${published ? 'ok' : 'muted'}`, { title: published ? 'In the published part of the catalog (publication/github.toml selects it)' : 'Internal: not selected by publication/github.toml' }, published ? 'published' : 'internal')
type Editing = { kind: 'new' } | { kind: 'new-preference' } | { kind: 'braindump' | 'review' | 'preference'; id: string } | null

export function renderCatalogView(root: HTMLElement): ViewHandle {
  let data: Awaited<ReturnType<typeof api.catalog>> | null = null
  let loadError = ''
  let applied: Awaited<ReturnType<typeof api.summon>> | null = null
  let disposed = false
  let editing: Editing = null
  let message: HTMLElement | null = null
  const open = new Set<string>() // braindumps shown in full
  const full = new Map<string, CatalogBraindump>() // texts and reviews, read when a braindump is opened
  let asked: HTMLElement | null = null // the answer to the last request to the summoner
  const author = h('input', { value: readAuthor(), placeholder: 'your name', 'aria-label': 'Author of changes', size: 14, onchange: () => keepAuthor(author.value.trim()) })

  const header = h('header.topbar', h('div.crumbs', h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'Catalog')),
    h('div.top-actions', h('a.button', { href: '#/' }, '← Dashboard'), ...siteLinks(),
      h('button', { onclick: () => void load(true), title: 'Read the catalog from Gitea now' }, 'Refresh')))
  const main = h('main.dashboard.catalog-view')
  root.append(header, main)

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
    if (bd && v.braindumps.some(b => b.id === bd[1])) return { href: '#/catalog', onclick: e => { e.preventDefault(); void toggle(bd[1], true).then(() => pick('braindump', bd[1])) } }
    const ch = /^challenges\/([^/]+)/.exec(path)
    if (ch) return { href: challengeHref(ch[1]), external: true }
    return { href: `${v.web}/src/branch/${v.branch}/${path}`, external: true }
  }
  const ask = async (what: string, f: () => Promise<{ href: string; workspace: string; workflow: string }>) => {
    if (!author.value.trim()) { asked = h('div.banner.error', 'Write your name as the author first: the request is made in your name.'); render(); return }
    keepAuthor(author.value.trim())
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

  async function change(f: () => Promise<{ message: string }>) {
    if (!author.value.trim()) { message = h('div.banner.error', 'Write your name as the author first: each change is a commit in your name.'); render(); return }
    keepAuthor(author.value.trim())
    try { const r = await f(); message = h('div.banner.ok', r.message); editing = null } catch (e) { message = h('div.banner.error', (e as Error).message) }
    await load(true)
  }
  const cancel = () => h('button', { onclick: () => { editing = null; render() } }, 'Cancel')

  function editor(b?: Bd): HTMLElement {
    const id = h('input', { value: '', placeholder: 'folder path: a-thought, or group/phase', 'aria-label': 'Braindump path', size: 40 })
    const text = h('textarea', { rows: 16, value: b ? full.get(b.id)?.text ?? '' : '# Title\n\nWhat I want, and why.\n', 'aria-label': 'Braindump text' })
    return h('div.catalog-editor',
      b ? null : h('label.small', 'Path below braindumps/episodes/ (it is the identity) ', id),
      text,
      h('div.row', h('button.primary', { onclick: () => void change(() => b ? api.catalogEdit(b.id, text.value, author.value.trim(), b.updated?.commit) : api.catalogAdd(id.value.trim().replace(/^\/+|\/+$/g, ''), text.value, author.value.trim())) }, b ? 'Commit the change' : 'Add the braindump'),
        cancel(),
        h('span.small.muted', b ? `Refused if someone changed it after ${b.updated?.commit.slice(0, 7) ?? 'its last commit'}.` : 'One commit in the catalog. Group braindumps in folders as you like.')))
  }

  // The review sits below its braindump and is edited in the same place.
  function reviewBlock(b: Bd, v: CatalogView): HTMLElement {
    const r = b.review
    const text = full.get(b.id)?.review?.text ?? ''
    const askButton = h('button.small', { title: 'The summoner reads the braindump, the projects that name it and their records, and writes review.md as its own author', onclick: () => void ask(`a review of ${b.id}`, () => api.catalogReviewRequest(author.value.trim(), b.id)) }, 'Ask for a review')
    if (editing?.kind === 'review' && editing.id === b.id) {
      const area = h('textarea', { rows: 10, value: text, placeholder: 'Free text: what of this became real, where, and what did not.', 'aria-label': 'Review text' })
      return h('div.catalog-review.catalog-editor', h('strong.small', 'Review'), area,
        h('div.row', h('button.primary', { onclick: () => void change(() => api.catalogReviewPut(b.id, area.value, author.value.trim(), r?.updated?.commit)) }, 'Commit the review'), cancel(),
          h('span.small.muted', 'Free text about the braindump; no form is required. You sign it as the author.')))
    }
    if (!r) return h('div.catalog-review.none', h('span.small.muted', 'No review. '), askButton, h('button.small', { onclick: () => { editing = { kind: 'review', id: b.id }; render() } }, 'Write a review'))
    return h('div.catalog-review',
      h('div.entry-head', h('strong.small', 'Review'), r.updated ? h('span.muted.small', `${r.updated.author} · ${when(r.updated.at)} · ${r.updated.commit.slice(0, 7)}`) : null, publishedChip(r.published),
        b.changedAfterReview ? h('span.small.stale', { title: `The braindump's last change (${b.updated?.commit.slice(0, 7)}) is newer than this review.` }, 'The braindump changed after this review') : null),
      renderMarkdown(text, linker(v, `braindumps/episodes/${b.id}`)),
      h('div.row', askButton, h('button.small', { onclick: () => { editing = { kind: 'review', id: b.id }; render() } }, 'Edit review')))
  }

  // Closed: the title, an excerpt and whether it is reviewed. Opened: the
  // text and the review, read then (api/catalog/braindumps/<path>).
  function braindumpCard(b: Bd, v: CatalogView): HTMLElement {
    const edit = editing?.kind === 'braindump' && editing.id === b.id
    const whole = open.has(b.id) && full.has(b.id)
    const reviewNote = !b.review ? h('span.chip.muted', 'not reviewed') : b.changedAfterReview ? h('span.chip.warn', 'changed after its review') : h('span.chip', { title: b.review.updated ? `${b.review.updated.author} · ${when(b.review.updated.at)}` : '' }, 'reviewed')
    return h('article.catalog-bd', { dataset: { braindump: b.id } },
      h('div.entry-head', h('a.catalog-bd-title', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); void toggle(b.id) }, title: whole ? 'Close' : 'Open the text and its review' }, h('strong', `${whole ? '▾' : '▸'} ${b.title}`)), h('code', b.id),
        reviewNote, publishedChip(b.published),
        b.updated ? h('span.muted.small', `${b.updated.author} · ${when(b.updated.at)} · ${b.updated.commit.slice(0, 7)}`) : null,
        h('a.small', { href: `${v.web}/src/branch/${v.branch}/${b.path}`, target: '_blank', rel: 'noopener' }, 'on Gitea')),
      h('div.chips', h('span.small.muted', 'grounds '), b.projects.length
        ? b.projects.map(id => { const p = v.projects.find(x => x.project === id); const href = p && projectHref(p); return href ? h('a.chip', { href }, id) : h('span.chip', id) })
        : h('span.chip.muted', `no project in ${v.plan || 'the plan'}`)),
      edit ? editor(b) : whole ? renderMarkdown(full.get(b.id)!.text ?? '', linker(v, `braindumps/episodes/${b.id}`)) : h('div.catalog-excerpt', b.excerpt),
      !whole || edit ? null : h('div.row',
        h('button', { onclick: () => { editing = { kind: 'braindump', id: b.id }; render() } }, 'Edit'),
        h('button.danger', { onclick: () => { if (confirm(`Remove braindump ${b.id}${b.review ? ' and its review' : ''}? They stay in the repository's history.${b.projects.length ? `\nIt grounds ${b.projects.join(', ')}: the plan's because lists must drop it first.` : ''}`)) void change(() => api.catalogRemove(b.id, author.value.trim())) } }, 'Remove')),
      whole ? reviewBlock(b, v) : null)
  }

  // The index (challenges.md): what is not yet real, written by the summoner's workflow index.
  function indexCard(v: CatalogView): HTMLElement {
    const x = v.index
    return h('section.card.catalog-index',
      h('div.card-head', h('h2', 'Not yet real'),
        h('span.muted.small', x.updated ? `${x.path} · ${x.updated.author} · ${when(x.updated.at)} · ${x.updated.commit.slice(0, 7)}` : x.path)),
      h('p.muted.small', 'The index of what is not yet real, from both origins: a braindump that was not carried out, and a challenge (a problem found during work) that is not resolved. An agent writes it by reading the braindumps with their reviews and the challenges; it is a reading, not a state kept by hand.'),
      x.text === null ? h('p.muted', 'No index yet.') : null,
      x.stale.length ? h('div.banner.warn', x.note) : null,
      h('div.row', h('button', { title: 'The summoner reads every braindump with its review and every challenge that is not resolved or withdrawn, and rewrites challenges.md', onclick: () => void ask('the index', () => api.catalogIndexRequest(author.value.trim())) }, x.text === null ? 'Write the index' : 'Refresh the index'),
        h('button', { title: 'The summoner reviews every braindump with no review or changed after its review', onclick: () => void ask('reviews of the braindumps that need one', () => api.catalogReviewRequest(author.value.trim())) }, 'Ask for the reviews that are due')),
      asked,
      x.text === null ? null : renderMarkdown(x.text, linker(v, '')))
  }

  // Preferences (user_catalog p3): how the owner wants work done; every file
  // is given to every run as system context (system/preference/<name>).
  function preferenceEditor(p?: CatalogView['preferences'][number]): HTMLElement {
    const name = h('input', { value: '', placeholder: 'name: documents, handing-over', 'aria-label': 'Preference name', size: 32 })
    const text = h('textarea', { rows: 10, value: p ? p.text : '# Subject\n\nHow I want this done, in every project.\n', 'aria-label': 'Preference text' })
    return h('div.catalog-editor',
      p ? null : h('label.small', 'File name below preferences/ (without .md) ', name),
      text,
      h('div.row', h('button.primary', { onclick: () => void change(() => api.catalogPreferencePut(p ? p.name : name.value.trim().replace(/\.md$/, ''), text.value, author.value.trim(), p?.updated?.commit)) }, p ? 'Commit the change' : 'Add the preference'),
        cancel(),
        h('span.small.muted', p ? `Refused if someone changed it after ${p.updated?.commit.slice(0, 7) ?? 'its last commit'}. The next attempt of every run is prepared with the new text.` : 'One commit in the catalog. One file per subject.')))
  }
  function preferencesCard(v: CatalogView): HTMLElement {
    return h('section.card.catalog-preferences',
      h('div.card-head', h('h2', 'Preferences'), h('span.muted.small', `${v.preferences.length} · preferences/<name>.md`)),
      h('p.muted.small', 'How you want work done, in every project: the language of documents, how results are handed over, what a report starts with. Every file here is given whole to every run and every authoring session (the context\'s system sources). What you want and why is a braindump; facts about machines stay in the system context.'),
      h('div.row', h('button', { onclick: () => { editing = { kind: 'new-preference' }; render() } }, 'New preference')),
      editing?.kind === 'new-preference' ? preferenceEditor() : null,
      v.preferences.length ? v.preferences.map(p => {
        const edit = editing?.kind === 'preference' && editing.id === p.name
        return h('article.catalog-bd', { dataset: { preference: p.name } },
          h('div.entry-head', h('strong', p.title), h('code', p.name), publishedChip(p.published),
            p.updated ? h('span.muted.small', `${p.updated.author} · ${when(p.updated.at)} · ${p.updated.commit.slice(0, 7)}`) : null,
            h('a.small', { href: `${v.web}/src/branch/${v.branch}/${p.path}`, target: '_blank', rel: 'noopener' }, 'on Gitea')),
          edit ? preferenceEditor(p) : renderMarkdown(p.text, linker(v, 'preferences')),
          edit ? null : h('div.row',
            h('button', { onclick: () => { editing = { kind: 'preference', id: p.name }; render() } }, 'Edit'),
            h('button.danger', { onclick: () => { if (confirm(`Remove preference ${p.name}? It stays in the repository's history; runs are no longer given it.`)) void change(() => api.catalogPreferenceRemove(p.name, author.value.trim())) } }, 'Remove')))
      }) : h('p.muted', 'No preferences yet.'))
  }

  // The owner's challenges, by state; a challenge is read and written on its own page.
  function challengesCard(v: CatalogView): HTMLElement {
    const c = v.challenges
    const order = ['open', 'custom', 'unspecified', 'resolved', 'withdrawn']
    const groups = order.map(k => ({ kind: k, items: c.items.filter(i => i.stateKind === k) })).filter(g => g.items.length)
    return h('section.card.catalog-challenges',
      h('div.card-head', h('h2', 'Challenges'), h('span.muted.small', c.available ? Object.entries(c.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ') || 'none' : '')),
      h('p.muted.small', 'Problems found during work, with the trials made on them. They stay a kind of their own: a challenge is not turned into a braindump, nor a braindump into a challenge.'),
      !c.available ? h('p.muted', c.reason) : null,
      c.available && !c.inCatalog ? h('div.banner.warn', `These challenges are not in this catalog: ${c.reason}.`) : null,
      groups.map(g => h('div.catalog-ch-group', h('div.catalog-folder-name', g.kind),
        g.items.map(i => h('div.catalog-ch', { dataset: { challenge: i.id } },
          h('a', { href: challengeHref(i.id), target: '_blank', rel: 'noopener' }, h('code', i.id), ' ', i.title || '(no summary)'),
          g.kind === 'custom' && i.state ? h('span.chip', i.state) : null,
          i.projects.map(p => h('span.chip', p)),
          i.trials ? h('span.small.muted', `${i.trials} trial${i.trials === 1 ? '' : 's'}`) : null,
          publishedChip(i.published),
          h('span.muted.small', `${i.updated.by} · ${when(i.updated.at)}`))))),
      c.available && !c.items.length ? h('p.muted', 'No challenges yet.') : null)
  }

  // Braindumps grouped by their folder paths: a folder that holds several is
  // shown as a group; a braindump whose folder has braindumps below it comes
  // first, with those indented under it.
  function tree(items: Bd[], v: CatalogView, depth = 0): HTMLElement[] {
    const out: HTMLElement[] = []
    const heads = [...new Set(items.map(b => b.id.split('/')[depth]))]
    for (const seg of heads) {
      const here = items.filter(b => b.id.split('/')[depth] === seg)
      const own = here.find(b => b.id.split('/').length === depth + 1)
      const below = here.filter(b => b !== own)
      if (own) out.push(braindumpCard(own, v))
      if (below.length) out.push(h('div.catalog-folder', own ? null : h('div.catalog-folder-name', `${below[0].id.split('/').slice(0, depth + 1).join('/')}/`), tree(below, v, depth + 1)))
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
    main.append(h('section.card.catalog-head',
      h('div.card-head', h('h2', v.title || 'Catalog'), h('a.small', { href: v.web, target: '_blank', rel: 'noopener' }, `${v.repository} @ ${v.head.slice(0, 7)}`)),
      h('p.muted.small', `Braindumps are free text on what you want and why: the grounds of the projects here. A review is free text about a braindump: what became real, where, what did not. Which projects each braindump grounds is recorded in this installation's summonplan (${v.plan ? `summonplans/${v.plan}.yaml` : 'none named'}), not in the projects.`),
      h('div.row', h('label.small', 'Author of changes ', author), h('button', { onclick: () => { editing = { kind: 'new' }; render() } }, 'New braindump')),
      message,
      ...v.problems.map(p => h('div.banner.warn', p)),
      v.issues.length ? h('ul.issues', v.issues.map(x => h(`li.${x.issue.severity}`, `${x.where}: ${x.issue.message}`))) : null))
    if (editing?.kind === 'new') main.append(h('section.card', h('h2', 'New braindump'), editor()))
    main.append(indexCard(v))
    const reviewed = v.braindumps.filter(b => b.review).length
    main.append(h('section.card', h('div.card-head', h('h2', 'Braindumps'), h('span.muted.small', `${reviewed} of ${v.braindumps.length} reviewed · ${v.braindumps.filter(b => b.published).length} published`)), v.braindumps.length ? tree(v.braindumps, v) : h('p.muted', 'No braindumps yet.')))
    main.append(preferencesCard(v))
    main.append(challengesCard(v))
    const grounded = v.projects.filter(p => p.braindumps.length).length
    main.append(h('section.card.catalog-relations',
      h('div.card-head', h('h2', 'Braindumps and projects'), h('span.muted.small', `${v.braindumps.length} braindumps · ${grounded} of ${v.projects.length} projects grounded`)),
      h('p.muted.small', 'Hover or focus a box to follow its edges; click to jump to it below.'),
      h('div.catalog-diagram-wrap', relationDiagram(v, pick))))
    main.append(h('section.card', h('h2', 'Projects and why they are here'),
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
      if (!dry && !author.value.trim()) { styleOut = h('div.banner.warn', 'Give your name as the author of changes first.'); render(); return }
      styleOut = h('p.muted.small', dry ? 'Reading the catalog…' : 'Requesting…'); render()
      void api.summonStyle(user, author.value.trim(), dry).then(r => {
        styleOut = h('div',
          h('p.small', h('a', { href: r.catalog, target: '_blank', rel: 'noopener' }, r.catalog), ` @ ${r.commit.slice(0, 7)}: `, r.projects.map(p => p.project).join(', ')),
          dry ? h('div.row', h('button.primary', { onclick: () => run(false) }, `Ask the summoner to propose ${r.user}'s style`))
            : h('p.small', 'Requested. ', r.href ? h('a', { href: r.href }, 'Open the summoner\'s run') : null, ' — it writes a proposal and asks you before anything is applied.'))
        render()
      }, e => { styleOut = h('div.banner.error', (e as Error).message); render() })
    }
    return h('section.card.catalog-style', h('h2', 'Import a development style'),
      h('p.muted.small', 'Name a GitHub user who publishes their catalog as <user>/mycatalog. The summoner proposes the projects of that catalog that are not here yet, and asks you before anything is applied.'),
      h('div.row', styleUser, h('button', { onclick: () => run(true) }, 'Read the catalog')),
      styleOut)
  }

  render()
  void load()
  return { dispose: () => { disposed = true }, isDirty: () => editing !== null }
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
