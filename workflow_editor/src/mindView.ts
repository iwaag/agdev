// Mind (summoner p1, #/mind; docs/mind.md): the braindumps of this
// installation's mind repository, which projects each grounds, a relation
// diagram, and every project with its grounds (none is said, not hidden).
// Braindumps are edited here through api/mind: each change is one commit
// authored by the name given.
import { api, type MindView } from './api.ts'
import { h, when } from './dom.ts'
import type { ViewHandle } from './main.ts'
import { siteLinks } from './site.ts'

const SVG = 'http://www.w3.org/2000/svg'
const AUTHOR_KEY = 'wfe.mind.author'
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
export function relationDiagram(v: MindView, onPick: (kind: 'braindump' | 'project', id: string) => void): SVGSVGElement {
  const bIndex = new Map(v.braindumps.map((b, i) => [b.slug, i]))
  const projects = [...v.projects].sort((a, b) => {
    const fa = a.braindumps.length ? Math.min(...a.braindumps.map(x => bIndex.get(x.slug) ?? 99)) : 1e3
    const fb = b.braindumps.length ? Math.min(...b.braindumps.map(x => bIndex.get(x.slug) ?? 99)) : 1e3
    return fa - fb || a.project.localeCompare(b.project)
  })
  const W = 760, rowP = 26, top = 16
  const H = Math.max(projects.length * rowP, v.braindumps.length * 54) + top * 2
  const rowB = (H - top * 2) / Math.max(1, v.braindumps.length)
  const bx = 8, bw = 300, px = 500, pw = 252
  const by = (i: number) => top + rowB * i + rowB / 2
  const py = (i: number) => top + (H - top * 2 - projects.length * rowP) / 2 + rowP * i + rowP / 2
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mind-diagram', role: 'img', 'aria-label': 'Braindumps and the projects they ground' })
  const edges = svg('g', { class: 'md-edges' })
  root.append(edges)
  const pRow = new Map(projects.map((p, i) => [p.project, i]))
  for (const p of projects) for (const b of p.braindumps) {
    const i = bIndex.get(b.slug)
    if (i === undefined) continue
    const y1 = by(i), y2 = py(pRow.get(p.project)!)
    edges.append(svg('path', { d: `M${bx + bw},${y1} C${bx + bw + 90},${y1} ${px - 90},${y2} ${px},${y2}`, class: 'md-edge', 'data-b': b.slug, 'data-p': p.project }))
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
    const g = svg('g', { class: `md-node md-b${b.projects.length ? '' : ' md-none'}`, transform: `translate(${bx},${by(i) - 20})`, tabindex: 0, 'data-id': b.slug, 'data-kind': 'b' },
      svg('title', {}, `${b.title}\n${b.projects.length ? `grounds ${b.projects.join(', ')}` : 'grounds no project in this installation\'s plan'}`),
      svg('rect', { width: bw, height: 40, rx: 8 }),
      svg('text', { x: 10, y: 17, class: 'md-title' }, clip(b.title, 44)),
      svg('text', { x: 10, y: 32, class: 'md-sub' }, `${b.slug} · ${b.projects.length} project${b.projects.length === 1 ? '' : 's'}`))
    g.addEventListener('mouseenter', () => highlight('data-b', b.slug)); g.addEventListener('mouseleave', () => highlight(null))
    g.addEventListener('focus', () => highlight('data-b', b.slug)); g.addEventListener('blur', () => highlight(null))
    g.addEventListener('click', () => onPick('braindump', b.slug))
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

export function renderMindView(root: HTMLElement): ViewHandle {
  let data: Awaited<ReturnType<typeof api.mind>> | null = null
  let loadError = ''
  let applied: Awaited<ReturnType<typeof api.summon>> | null = null
  let disposed = false
  let editing: string | null = null // slug, or '' for a new braindump
  let message: HTMLElement | null = null
  const full = new Map<string, string>() // slug → full text, once read
  const author = h('input', { value: readAuthor(), placeholder: 'your name', 'aria-label': 'Author of changes', size: 14, onchange: () => keepAuthor(author.value.trim()) })

  const header = h('header.topbar', h('div.crumbs', h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'Mind')),
    h('div.top-actions', h('a.button', { href: '#/' }, '← Dashboard'), ...siteLinks(),
      h('button', { onclick: () => void load(true), title: 'Read the mind repository from Gitea now' }, 'Refresh')))
  const main = h('main.dashboard.mind-view')
  root.append(header, main)

  async function load(refresh = false) {
    try { data = await api.mind(refresh); loadError = '' } catch (e) { loadError = (e as Error).message }
    // summoner p2: whether each plan entry is applied here (docs/summon.md); its absence only hides the indicator.
    applied = data?.configured && data.plan ? await api.summon().catch(() => null) : null
    if (data && data.configured && !author.value && data.person) author.value = data.person
    if (!disposed) render()
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
    try { const r = await f(); message = h('div.banner.ok', r.message); editing = null; full.clear() } catch (e) { message = h('div.banner.error', (e as Error).message) }
    await load(true)
  }

  function editor(b?: MindView['braindumps'][number]): HTMLElement {
    const slug = h('input', { value: b?.slug ?? '', placeholder: 'slug: lower-case-words', disabled: !!b, 'aria-label': 'Braindump name' })
    const text = h('textarea', { rows: 16, value: b ? full.get(b.slug) ?? b.text ?? '' : '# Title\n\nWhat I want, and why.\n', 'aria-label': 'Braindump text' })
    return h('div.mind-editor',
      b ? null : h('label.small', 'Name (the file name; it is the identity) ', slug),
      text,
      h('div.row', h('button.primary', { onclick: () => void change(() => b ? api.mindEdit(b.slug, text.value, author.value.trim(), b.updated?.commit) : api.mindAdd(slug.value.trim(), text.value, author.value.trim())) }, b ? 'Commit the change' : 'Add the braindump'),
        h('button', { onclick: () => { editing = null; render() } }, 'Cancel'),
        h('span.small.muted', b ? `Refused if someone changed it after ${b.updated?.commit.slice(0, 7) ?? 'its last commit'}.` : 'One commit in the mind repository.')))
  }

  function braindumpCard(b: MindView['braindumps'][number], v: MindView): HTMLElement {
    const text = full.get(b.slug)
    const card = h('article.mind-bd', { dataset: { braindump: b.slug } },
      h('div.entry-head', h('strong', b.title), h('code', b.slug),
        b.updated ? h('span.muted.small', `${b.updated.author} · ${when(b.updated.at)} · ${b.updated.commit.slice(0, 7)}`) : null,
        h('a.small', { href: `${v.web}/src/branch/main/${b.path}`, target: '_blank', rel: 'noopener' }, 'on Gitea')),
      h('div.chips', h('span.small.muted', 'grounds '), b.projects.length
        ? b.projects.map(id => { const p = v.projects.find(x => x.project === id); const href = p && projectHref(p); return href ? h('a.chip', { href }, id) : h('span.chip', id) })
        : h('span.chip.muted', `no project in ${v.plan || 'the plan'}`)),
      editing === b.slug ? editor({ ...b, text: text ?? b.excerpt }) : h('div.mind-text', text ?? b.excerpt),
      editing === b.slug ? null : h('div.row',
        text ? null : h('button', { onclick: () => void api.mindBraindump(b.slug).then(r => { full.set(b.slug, r.text ?? ''); render() }, e => { message = h('div.banner.error', (e as Error).message); render() }) }, 'Read in full'),
        h('button', { onclick: () => void api.mindBraindump(b.slug).then(r => { full.set(b.slug, r.text ?? ''); editing = b.slug; render() }, e => { message = h('div.banner.error', (e as Error).message); render() }) }, 'Edit'),
        h('button.danger', { onclick: () => { if (confirm(`Remove braindump ${b.slug}? It stays in the repository's history.${b.projects.length ? `\nIt grounds ${b.projects.join(', ')}: the plan's because lists must drop it first.` : ''}`)) void change(() => api.mindRemove(b.slug, author.value.trim())) } }, 'Remove')))
    return card
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
    if (!data) { main.append(h('p.muted', 'Reading the mind repository…')); return }
    if (!data.configured) {
      main.append(h('section.card', h('h2', 'Mind'), h('p', data.reason), h('p.muted.small', 'The mind repository holds your braindumps — what you want and why — and the summonplans that say which projects make them concrete here (docs/mind.md).')))
      return
    }
    const v = data
    main.append(h('section.card.mind-head',
      h('div.card-head', h('h2', v.title || 'Mind'), h('a.small', { href: v.web, target: '_blank', rel: 'noopener' }, `${v.repository} @ ${v.head.slice(0, 7)}`)),
      h('p.muted.small', `Braindumps are the grounds of the projects here and of the resources they use. Which projects each grounds is recorded in this installation's summonplan (${v.plan ? `summonplans/${v.plan}.yaml` : 'none named'}), not in the projects.`),
      h('div.row', h('label.small', 'Author of changes ', author), h('button', { onclick: () => { editing = ''; render() } }, 'New braindump')),
      message,
      ...v.problems.map(p => h('div.banner.warn', p)),
      v.issues.length ? h('ul.issues', v.issues.map(x => h(`li.${x.issue.severity}`, `${x.where}: ${x.issue.message}`))) : null))
    if (editing === '') main.append(h('section.card', h('h2', 'New braindump'), editor()))
    main.append(styleCard())
    const grounded = v.projects.filter(p => p.braindumps.length).length
    main.append(h('section.card.mind-relations',
      h('div.card-head', h('h2', 'Braindumps and projects'), h('span.muted.small', `${v.braindumps.length} braindumps · ${grounded} of ${v.projects.length} projects grounded`)),
      h('p.muted.small', 'Hover or focus a box to follow its edges; click to jump to it below.'),
      h('div.mind-diagram-wrap', relationDiagram(v, pick))))
    main.append(h('section.card', h('h2', 'Braindumps'), v.braindumps.length ? v.braindumps.map(b => braindumpCard(b, v)) : h('p.muted', 'No braindumps yet.')))
    main.append(h('section.card', h('h2', 'Projects and why they are here'),
      h('table.mind-projects', h('thead', h('tr', h('th', 'Project'), h('th', 'Grounds'), h('th', 'Roles'), h('th', 'Entry'))),
        h('tbody', v.projects.map(p => h('tr', { dataset: { project: p.project } },
          h('td', projectHref(p) ? h('a', { href: projectHref(p)! }, p.project) : p.project, p.registered ? null : h('span.chip.warn', 'not registered')),
          h('td', !p.entry ? h('span.muted', 'not in the plan') : p.braindumps.length ? h('div.chips', p.braindumps.map(b => h('a.chip', { href: '#/mind', onclick: (e: Event) => { e.preventDefault(); pick('braindump', b.slug) }, title: b.title }, b.slug + (b.missing ? ' (missing)' : '')))) : h('span.chip.warn', 'no ground')),
          h('td.small', p.entry ? roleText(p.entry.roles) : ''),
          h('td.small.muted', appliedChip(p.project), p.entry ? `${p.entry.state} · ${p.entry.commit.slice(0, 7)}${p.entry.note ? ` · ${p.entry.note}` : ''}` : '')))))))
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
    return h('section.card.mind-style', h('h2', 'Import a development style'),
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
  const card = h('section.card.mind-why', h('h2', 'Why this project exists'), h('p.muted.small', 'Reading the mind repository…'))
  void api.mindWhy(project).then(w => {
    card.replaceChildren(h('div.card-head', h('h2', 'Why this project exists'), h('a.more-link.small', { href: '#/mind' }, 'Mind')))
    if (!w.entry) { card.append(h('p.muted.small', `Not in this installation's plan (${w.plan || 'none named'}).`)); return }
    if (!w.braindumps.length) card.append(h('div.banner.warn', `No ground: no braindump says why ${project} is here.${w.entry.note ? ` (${w.entry.note})` : ''}`))
    for (const b of w.braindumps) card.append(h('div.mind-bd', h('div.entry-head', h('strong', b.title), h('a.small', { href: '#/mind' }, b.slug)), h('div.mind-text.small', b.excerpt)))
    card.append(h('p.muted.small', `${w.plan}: ${w.entry.state} · ${w.entry.commit.slice(0, 7)}${Object.keys(w.entry.roles).length ? ` · roles ${roleText(w.entry.roles)}` : ''}${w.elsewhere.length ? ` · also in ${w.elsewhere.map(e => e.plan).join(', ')}` : ''}`))
  }, (e: Error) => card.replaceChildren(h('h2', 'Why this project exists'), h('p.muted.small', e.message)))
  return card
}
