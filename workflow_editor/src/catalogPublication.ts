// What is public and why, per project, and the owner's two requests (improve_publish p3; agdev
// docs/external-publication.md, *Seeing and changing it from the Catalog page*).
//
// Each project of the Catalog page's Public section is one row; opening it reads the service's publication facts
// (server/publicationFacts.ts) once, grouped as run records, workflows, code and other files. Every item says what it
// is (public, selected and not published yet, kept local, previously public and still in history) and, under Why, the
// chain it stands on: the owner's sentence or answer, the contract's selection, the publication commit. Beside an item:
// *Keep local from now on* (a hold at once, then the owning agent's contract change) or *Propose publication* (a
// request to the publisher, which asks once). The page writes no contract.
//
// The elements are kept across the page's renders (like the drafts and the writing field): what is typed stays when
// the catalog is read again or a request fails.
import { api, type PublicationFacts, type PublicationRequest, type PublisherQuestion } from './api.ts'
import { h, when } from './dom.ts'

export interface PublicationHost {
  author: () => string
  haveAuthor: (place: string, again: () => void) => boolean
  authorSlot: (place: string) => HTMLElement
  changed: () => Promise<void> // the catalog's waiting list may have changed: read it again
}
type Facts = PublicationFacts
type Repo = Facts['repositories'][number]
type Sel = Repo['selections'][number]
type Ground = Sel['ground']

const GROUPS = ['run records', 'workflows', 'code', 'other files'] as const
const STATUS: Record<string, { label: string; cls: string; title: string }> = {
  'public': { label: 'Public', cls: 'ok', title: 'In the public repository: its last publication selected it under this answer' },
  'public; source changed since': { label: 'Public', cls: 'ok', title: 'In the public repository; the source moved on since its last publication (the next update carries what changed inside the answered scope)' },
  'selected, not published yet': { label: 'Selected, not published yet', cls: 'warn', title: 'The contract selects it; no publication has carried it yet' },
  'widening': { label: 'Selected, needs your answer', cls: 'warn', title: 'The contract selects it and no answer covers it: the publisher asks before publishing it' },
}
const commitHref = (destination: string, commit: string) => /^https:\/\/github\.com\//.test(destination) ? `${destination.replace(/\.git$/, '')}/commit/${commit}` : null
const repoHref = (destination: string) => destination.replace(/\.git$/, '')
const short = (s?: string | null) => (s ?? '').slice(0, 7)
const bare = (e: unknown) => (e as Error).message.replace(/[.\s]+$/, '')
// replaceChildren with what h() takes as children: nested lists, null for nothing.
const put = (el: HTMLElement, ...xs: unknown[]) => el.replaceChildren(...(xs.flat(4).filter(x => x !== null && x !== undefined && x !== false) as (Node | string)[]))
// The source path a narrowing names, for a selection.
const pathOf = (s: Sel): string | null => s.kind === 'run' ? `devdocs/runs/${s.id}` : s.kind === 'submodule' ? s.path ?? null
  : s.kind === 'tree' ? (s.from ?? '').replace(/^source:/, '').replace(/^\/+|\/+$/g, '') || null
  : s.from?.startsWith('source:') ? s.from.slice(7) : null
const nameOf = (s: Sel) => s.kind === 'run' ? s.id! : s.kind === 'tree' ? `${(s.from ?? '').replace(/^source:/, '') || '(the whole repository)'}/` : s.kind === 'submodule' ? s.path! : s.public!

export interface PublicationPanel {
  project: (project: string, label?: string) => HTMLElement
  answer: (q: PublisherQuestion) => HTMLElement
  setQuestions: (qs: PublisherQuestion[]) => void
  isDirty: () => boolean
}

export function publicationPanel(host: PublicationHost): PublicationPanel {
  const rows = new Map<string, { el: HTMLElement; body: HTMLElement; open: boolean; facts: Facts | null; error: string; loading: boolean; draw: () => void }>()
  const values = new Map<string, string>() // what is typed, per form
  const forms = new Map<string, { kind: 'keep' | 'propose'; project: string; repository?: string; path?: string; items?: string[]; covers?: string[]; history?: string; revision?: string }>()
  const picks = new Map<string, Set<string>>() // per project, the unjudged runs ticked to propose
  const outcome = new Map<string, HTMLElement>() // per form or answer: the last reply
  const folds = new Map<string, boolean>() // a group opened or closed by the owner stays so
  const fold = (key: string, dflt: boolean, cls: string, ...children: unknown[]) => {
    const d = h(`details.${cls}`, { open: folds.get(key) ?? dflt }, ...(children as never[]))
    d.addEventListener('toggle', () => folds.set(key, d.open))
    return d
  }
  const field = (key: string, o: { rows?: number; placeholder: string; label: string }) => {
    const t = h('textarea', { rows: o.rows ?? 2, placeholder: o.placeholder, 'aria-label': o.label })
    t.value = values.get(key) ?? ''
    t.addEventListener('input', () => values.set(key, t.value))
    return t
  }

  // ---- grounds: sentence → rule or answer → selection → publication commit ---------------------------------
  const groundEl = (g: Ground) => g.kind === 'rule' && g.rule ? h('span', 'Your rule ', h('code', g.rule.id), ` (adopted by ${g.rule.adoptedBy}, ${when(g.rule.adoptedAt)}) from “${g.rule.braindump}”: `, h('q', g.rule.sentence), g.rule.changed ? h('span.chip.warn', { title: g.rule.changed }, 'its source changed') : null)
    : g.kind === 'answer' && g.run ? h('span', 'The answer in ', h('a', { href: g.run.href }, `${g.run.workflow}/${g.run.run}`))
      : g.kind === 'legacy' ? h('span.muted', 'Decided before grounds were recorded: no sentence or answer is on record (legacy).')
        : g.kind === 'missing' ? h('span.chip.warn', 'No ground recorded')
          : h('span', g.words)
  function why(r: Repo, s: Sel | null, local?: Repo['local'][number]): HTMLElement {
    const steps: HTMLElement[] = []
    if (local) {
      steps.push(h('li', h('span.muted', 'Kept local by: '), groundEl(local.ground)))
      steps.push(h('li.d-only', h('span.muted', 'Contract: '), h('code', `[[local]] path = "${local.path}"`), local.because ? h('code', ` because = "${local.because}"`) : null))
      if (local.public) steps.push(h('li', h('span.muted', 'Previously public: '), commitLink(r, local.public.public_commit), local.public.head ? ' — still in the public head; the next publication removes it from there, and history keeps it.' : ' — it remains in the public history (not rewritten).'))
      return h('ol.pub-why', steps)
    }
    if (!s) return h('ol.pub-why')
    const g = s.ground.kind === 'project' ? r.ground : s.ground
    steps.push(h('li', h('span.muted', s.ground.kind === 'project' ? 'The project is public by: ' : 'Grounded on: '), groundEl(g)))
    steps.push(h('li.d-only', h('span.muted', 'Contract: '), h('code', s.key), s.because ? h('code', ` because = "${s.because}"`) : null, s.edits ? h('span.muted', ` with ${s.edits} edit${s.edits === 1 ? '' : 's'}`) : null))
    if (s.scopeGround) steps.push(h('li', h('span.muted', 'Published under: '), groundEl(s.scopeGround)))
    if (s.status.startsWith('public') && r.public) steps.push(h('li', h('span.muted', 'Public commit: '), commitLink(r, r.public.public_commit), r.public.published_at ? ` (${when(r.public.published_at)})` : ''))
    if (s.status === 'widening') steps.push(h('li', h('span.muted', 'Not published yet: '), 'no answer covers it; the publisher asks once before it is published.'))
    return h('ol.pub-why', steps)
  }
  const commitLink = (r: Repo, c: string) => { const u = commitHref(r.destination, c); return u ? h('a', { href: u, target: '_blank', rel: 'noopener' }, short(c)) : h('code', short(c)) }

  // ---- the two requests ------------------------------------------------------------------------------------------
  function formEl(key: string, row: { draw: () => void }): HTMLElement | null {
    const f = forms.get(key)
    if (!f) return null
    const note = field(`${key}:note`, { placeholder: f.kind === 'keep' ? 'Why (optional; the agent that changes the contract reads it)' : 'What you would like public and why (optional)', label: 'Your words' })
    const place = `pub:${key}`
    const send = h('button.primary', { onclick: async function submit() {
      if (!host.haveAuthor(place, () => void submit())) return
      send.disabled = true
      try {
        const r = f.kind === 'keep'
          ? await api.publicationKeepLocal({ project: f.project, ...(f.repository ? { repository: f.repository } : {}), path: f.path!, ...(f.revision ? { revision: f.revision } : {}), ...(note.value.trim() ? { note: note.value.trim() } : {}), author: host.author() })
          : await api.publicationPropose({ project: f.project, items: f.items ?? [], ...(note.value.trim() ? { note: note.value.trim() } : {}), ...(f.revision ? { revision: f.revision } : {}), author: host.author() })
        forms.delete(key); values.delete(`${key}:note`)
        outcome.set(f.project, h('div.banner.ok', { role: 'status' }, r.message, r.request.run ? [' ', h('a', { href: r.request.run.href }, 'Open the run')] : null))
        if (f.kind === 'propose') picks.delete(f.project)
        await reload(f.project)
        void host.changed()
      } catch (e) {
        send.disabled = false
        outcome.set(key, h('div.banner.error', { role: 'alert' }, `Not sent: ${bare(e)}. What you wrote is kept.`))
        row.draw()
      }
    } }, f.kind === 'keep' ? 'Keep local from now on' : 'Ask the publisher')
    return h('div.catalog-editor.pub-form',
      f.kind === 'keep' ? [h('strong.small', `Keep ${f.path} local from now on`),
        h('p.small', 'From the moment you send this, no publication carries it: the publication tool holds it at once, and the project\'s agent then records it in the contract as kept local.'),
        f.covers?.length ? h('details.small', h('summary', `It covers ${f.covers.length} file${f.covers.length === 1 ? '' : 's'} selected now`), h('ul.pub-paths', f.covers.slice(0, 50).map(p => h('li', h('code', p))))) : null,
        f.history ? h('p.small.muted', f.history) : null]
        : [h('strong.small', 'Propose publication'), f.items?.length ? h('ul.pub-paths.small', f.items.map(p => h('li', h('code', p)))) : null,
          h('p.small', 'The publisher reads it against your rules, prepares and assesses a candidate, and asks you once on the exact change. Proposing approves nothing.')],
      note, host.authorSlot(place), outcome.get(key) ?? null,
      h('div.row', send, h('button', { onclick: () => { forms.delete(key); outcome.delete(key); row.draw() } }, 'Cancel')))
  }
  const keepButton = (row: { draw: () => void }, key: string, f: NonNullable<ReturnType<typeof forms.get>>) => forms.has(key) ? null
    : h('button.small', { title: 'Stop publishing this from now on (what is public stays in history)', onclick: () => { forms.set(key, f); outcome.delete(key); row.draw() } }, f.kind === 'keep' ? 'Keep local' : 'Propose publication')

  // ---- one project ------------------------------------------------------------------------------------------------
  async function reload(project: string, refresh = false) {
    const row = rows.get(project)
    if (!row) return
    row.loading = true; row.draw()
    try { row.facts = await api.publicationFacts(project, { runs: project !== 'mycatalog', refresh }); row.error = '' } catch (e) { row.error = (e as Error).message }
    row.loading = false; row.draw()
  }
  function requestLine(project: string, q: PublicationRequest): HTMLElement {
    const cls = q.state?.startsWith('failed') ? 'error' : q.state === 'removal published' || q.state === 'kept local' || q.state === 'done' ? 'ok' : q.state === 'withdrawn' ? 'muted' : 'warn'
    const active = q.kind === 'keep-local' && q.state !== 'withdrawn' && q.state !== 'removal published' && q.state !== 'kept local'
    return h('li.pub-request', h('span', q.kind === 'keep-local' ? ['Keep local: ', h('code', q.path ?? '')] : ['Proposed: ', (q.items ?? []).length ? (q.items ?? []).map((x, i) => [i ? ', ' : '', h('code', x)]) : h('span', `“${q.note ?? ''}”`)]),
      ' ', h(`span.chip.${cls}`, q.state ?? ''), q.detail ? h('span.small.muted', ` ${q.detail}`) : null,
      q.run ? [' ', h('a.small', { href: q.run.href }, `${q.run.workflow}/${q.run.run}`)] : null,
      h('span.small.muted.d-only', ` · ${q.id} by ${q.by}, ${when(q.at)}`),
      active ? h('button.small.d-only', { title: 'The hold stops blocking publication; a [[local]] already written stays in the contract', onclick: async () => {
        const reason = prompt(`Withdraw ${q.id}? The hold on ${q.path} stops blocking publication. Why?`)?.trim()
        if (!reason || !host.haveAuthor(`pub:${project}`, () => undefined)) return
        try { const r = await api.publicationWithdraw({ project, id: q.id, reason, author: host.author() }); outcome.set(project, h('div.banner.ok', r.message)) } catch (e) { outcome.set(project, h('div.banner.error', (e as Error).message)) }
        await reload(project)
      } }, 'Withdraw') : null)
  }
  function repoBlock(project: string, f: Facts, r: Repo, row: { draw: () => void }): HTMLElement {
    const group = (name: string) => {
      const items = r.selections.filter(s => s.group === name)
      if (!items.length) return null
      const n = (st: string) => items.filter(s => s.status === st || (st === 'public' && s.status.startsWith('public'))).length
      const summary = [n('public') ? `${n('public')} public` : '', n('selected, not published yet') ? `${n('selected, not published yet')} selected, not published yet` : '', n('widening') ? `${n('widening')} waiting for an answer` : ''].filter(Boolean).join(' · ')
      return fold(`${project}|${r.id}|${name}`, items.length <= 4 || name === 'run records' || name === 'workflows', 'pub-group',
        h('summary', h('strong', name[0].toUpperCase() + name.slice(1)), h('span.small.muted', ` ${summary}`)),
        h('ul.pub-items', items.map(s => {
          const st = STATUS[s.status] ?? { label: s.status, cls: 'muted', title: '' }
          const key = `${project}|${r.id}|keep|${pathOf(s) ?? s.key}`
          const whyKey = `${project}|${r.id}|why|${s.key}`
          const path = pathOf(s)
          return h('li.pub-item',
            h('div.pub-line', h('span.pub-name', h('code', nameOf(s)), s.count > 1 ? h('span.small.muted', ` ${s.count} files`) : null, s.edits ? h('span.small.muted', ' · edited for the public') : null),
              h(`span.chip.${st.cls}`, { title: st.title }, st.label),
              h('button.small.linkish', { 'aria-expanded': String(openWhy.has(whyKey)), onclick: () => { if (!openWhy.delete(whyKey)) openWhy.add(whyKey); row.draw() } }, 'Why'),
              path ? keepButton(row, key, { kind: 'keep', project, repository: r.id, path, covers: s.paths, revision: f.sourceRev, ...(s.status.startsWith('public') && r.public ? { history: `It is public now (${short(r.public.public_commit)}). Kept local, it leaves the public head with the next publication and stays in the public history: nothing already published is rewritten.` } : {}) }) : null),
            openWhy.has(whyKey) ? why(r, s) : null,
            s.kind === 'tree' && s.exclude?.length ? h('p.small.muted.d-only', `Leaves out: ${s.exclude.join(', ')}`) : null,
            formEl(key, row))
        })))
    }
    const local = r.local.map(l => {
      const key = `${project}|${r.id}|propose|${l.path}`
      return h('li.pub-item', h('div.pub-line', h('span.pub-name', h('code', l.path)), h('span.chip.muted', 'Kept local'),
        l.public ? h('span.chip.warn', { title: `A journaled publication held it (${short(l.public.public_commit)}); public history is never rewritten` }, l.public.head ? 'Still in the public head' : 'Previously public; remains in history') : null,
        keepButton(row, key, { kind: 'propose', project, items: [l.path], revision: f.sourceRev })),
      why(r, null, l), formEl(key, row))
    })
    return h('div.pub-repo',
      f.repositories.length > 1 || r.path ? h('h4', r.name, r.path ? h('span.small.muted', ` (submodule ${r.path})`) : null) : null,
      h('p.small', r.public ? ['Public at ', h('a', { href: repoHref(r.destination), target: '_blank', rel: 'noopener' }, repoHref(r.destination).replace(/^https:\/\//, '')), ': last published ', commitLink(r, r.public.public_commit), r.public.published_at ? ` (${when(r.public.published_at)})` : '', '.'] : ['Not published yet (', h('code', r.destination), ').'],
        h('span.muted', ' The project: '), groundEl(r.ground)),
      h('p.small.muted.d-only', `Source ${short(r.source_rev)} · ${r.publications} publication${r.publications === 1 ? '' : 's'} journaled · scope answered by ${r.answered_by} · checkout ${r.checkout}${r.visibility ? ` · ${r.visibility}` : ''}${r.license ? ` · ${r.license}` : ''}`),
      r.not_grounded.length ? h('div.banner.warn.d-only', `Not grounded: ${r.not_grounded.join('; ')}`) : null,
      r.grounds_stale.length ? h('div.banner.warn.d-only', r.grounds_stale.join('; ')) : null,
      r.staged ? h('p.small', h('span.chip.warn', 'Staged, not pushed'), ` ${r.staged.operation ?? ''} → ${short(r.staged.public_commit)} from ${short(r.staged.source_rev)}`) : null,
      r.conflict ? h('p.small', h('span.chip.error', 'Conflict'), ` ${r.conflict.files.join(', ')} (${when(r.conflict.at)})`) : null,
      ...GROUPS.map(group),
      local.length ? fold(`${project}|${r.id}|local`, true, 'pub-group', h('summary', h('strong', 'Kept local'), h('span.small.muted', ` ${local.length} by a recorded decision`)), h('ul.pub-items', local)) : null,
      r.dropped.length ? h('p.small.muted.d-only', `No longer selected (no [[local]]); they remain in the public history: ${r.dropped.map(d => `${d.key} (${short(d.public_commit)})`).join(', ')}`) : null)
  }
  function runsBlock(project: string, f: Facts, row: { draw: () => void }): HTMLElement | null {
    const x = f.runs
    if (!x) return null
    if (x.problem) return h('p.small.muted', `Run records cannot be listed now: ${x.problem}`)
    const ticked = picks.get(project) ?? new Set<string>()
    const key = `${project}|runs|propose`
    const shown = x.runs.slice(0, 30)
    return fold(`${project}|runs`, x.runs.length > 0 && x.runs.length <= 8, 'pub-group',
      h('summary', h('strong', 'Run records not yet judged'), h('span.small.muted', ` ${x.runs.length}${x.unchanged_since_judged ? ` · ${x.unchanged_since_judged} judged before and unchanged` : ''}`)),
      h('p.small', x.criterion ? ['Your criterion: ', x.criterionGround ? groundEl(x.criterionGround) : h('q', x.criterion.sentence)] : 'No rule states a criterion for run records: they stay local and the publisher proposes none.'),
      x.unchanged_since_judged ? h('p.small.muted', `${x.unchanged_since_judged} run${x.unchanged_since_judged === 1 ? ' was' : 's were'} judged before and did not change since (${x.judged}). They are local; no individual reason is recorded for each, only the publisher's judgment in its run.`) : null,
      shown.length ? h('ul.pub-items', shown.map(run => h('li.pub-item', h('label.pub-line', h('input', { type: 'checkbox', checked: ticked.has(run.id), onchange: (e: Event) => { const s = picks.get(project) ?? new Set<string>(); if ((e.target as HTMLInputElement).checked) s.add(run.id); else s.delete(run.id); picks.set(project, s); row.draw() } }),
        h('span.pub-name', h('code', run.id)), h('span.small.muted', Object.keys(run.kinds).length ? ` changed ${Object.entries(run.kinds).map(([k, n]) => `${n} ${k}`).join(', ')} outside its folder` : ' changed nothing outside its folder'),
        [run['request.md'], run['report.md']].some(t => t?.private.length) ? h('span.chip.warn', { title: 'Its request or report names a project kept private' }, 'names a private project') : null)))) : null,
      x.runs.length > shown.length ? h('p.small.muted', `and ${x.runs.length - shown.length} more (wfe catalog disclosure runs ${project})`) : null,
      ticked.size && !forms.has(key) ? h('div.row', h('button.small.primary', { onclick: () => { forms.set(key, { kind: 'propose', project, items: [...ticked].map(id => `devdocs/runs/${id}`), revision: f.sourceRev }); row.draw() } }, `Propose ${ticked.size} for publication`)) : null,
      formEl(key, row))
  }
  function rulesBlock(project: string, f: Facts): HTMLElement | null {
    if (!f.rules?.length) return null
    return fold(`${project}|rules`, false, 'pub-group.d-only', h('summary', h('strong', 'Rules and their public form'), h('span.small.muted', ` ${f.rules.filter(r => r.public).length} of ${f.rules.length} public`)),
      h('p.small.muted', 'The public rules.yaml is derived by the publication tool: a rule is public when its braindump is in the public list, it does not name a private project, and its share is not never. Sharing a rule publishes the rule, not the content it governs; share: never also keeps it out of a style another installation imports.'),
      h('ul.pub-items', f.rules.map(x => h('li.pub-item', h('div.pub-line', h('code', x.id), h(`span.chip.${x.public ? 'ok' : 'muted'}`, x.public ? 'Public form' : 'Kept here'), h('span.small.muted', ` ${x.why}`),
        x.id === 'default-licence' ? null : h('button.small', { title: x.share === 'never' ? 'Let it follow the public list (it is public when its braindump is)' : 'Keep it in this installation: never published, never offered by a style import', onclick: async () => {
          const place = `pub:${project}`
          if (!host.haveAuthor(place, () => undefined)) return
          try { const r = await api.catalogRuleShare(x.id, x.share === 'never' ? 'default' : 'never', host.author()); outcome.set(project, h('div.banner.ok', r.message)) } catch (e) { outcome.set(project, h('div.banner.error', (e as Error).message)) }
          await reload(project)
        } }, x.share === 'never' ? 'Share: default' : 'Share: never')),
        x.rule ? h('p.small.muted', `From “${x.rule.source.braindump}”: “${x.rule.source.sentence}”`) : null))))
  }
  const openWhy = new Set<string>()
  function projectEl(project: string, label?: string): HTMLElement {
    const known = rows.get(project)
    if (known) return known.el
    const body = h('div.pub-body')
    const toggle = h('button.small', { 'aria-expanded': 'false' }, 'Open')
    const el = h('div.pub-project', { dataset: { project } }, h('div.pub-head', h('strong', label ?? project), toggle), body)
    const row = { el, body, open: false, facts: null as Facts | null, error: '', loading: false, draw: () => {} }
    row.draw = () => {
      toggle.textContent = row.open ? 'Close' : 'What is public, and why'
      toggle.setAttribute('aria-expanded', String(row.open))
      if (!row.open) { body.replaceChildren(); return }
      const f = row.facts
      const qs = questions.filter(q => q.target === project)
      put(body,
        row.loading ? h('p.small.muted', 'Reading the publication…') : null,
        row.error ? h('div.banner.error', row.error) : null,
        outcome.get(project) ?? null,
        f?.unavailable ? h('div.banner.warn', `Unavailable: ${f.unavailable}`) : null,
        f?.fetchProblem ? h('div.banner.warn', f.fetchProblem) : null,
        f && !f.unavailable ? [
          h('p.small.muted.d-only', `Read at ${f.revisionRead} ${short(f.sourceRev)}, ${when(f.readAt)}.${f.problems.length ? ` Problems: ${f.problems.join('; ')}` : ''}`),
          qs.length ? h('div.banner.warn', `The publisher asks you about ${project}: `, h('a', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); document.querySelector('[data-section="waiting"]')?.scrollIntoView({ behavior: 'smooth' }) } }, 'answer under Waiting for you')) : null,
          f.requests.length ? h('div.pub-requests', h('strong.small', 'Your requests'), h('ul.small', f.requests.slice().reverse().slice(0, 10).map(q => requestLine(project, q)))) : null,
          ...f.repositories.map(r => repoBlock(project, f, r, row)),
          runsBlock(project, f, row), rulesBlock(project, f),
          proposeOther(project, f, row),
          h('div.row.d-only', h('button.small', { onclick: () => void reload(project, true) }, 'Fetch and read again')),
        ] : null,
        host.authorSlot(`pub:${project}`))
    }
    toggle.addEventListener('click', () => { row.open = !row.open; if (row.open && !row.facts && !row.loading) void reload(project); else row.draw() })
    rows.set(project, row)
    row.draw()
    return el
  }
  function proposeOther(project: string, f: Facts, row: { draw: () => void }): HTMLElement {
    const key = `${project}|other|propose`
    if (forms.has(key)) return formEl(key, row)!
    return h('div.row.pub-other', h('button.small', { title: 'Something not listed here: say it in words; the publisher reads it and asks you once on what it would publish', onclick: () => { forms.set(key, { kind: 'propose', project, items: [], revision: f.sourceRev }); row.draw() } }, 'Propose something else for publication'))
  }

  // ---- the publisher's question: one batch answer --------------------------------------------------------------
  let questions: PublisherQuestion[] = []
  const answers = new Map<string, { el: HTMLElement; q: PublisherQuestion; declined: Set<string>; draw: () => void; done?: boolean }>()
  function answerEl(q: PublisherQuestion): HTMLElement {
    const id = `${q.workspace}/${q.workflow}/${q.run}#${q.question.id}`
    const known = answers.get(id)
    if (known && known.q.proposal?.version === q.proposal?.version) return known.el
    const el = h('div.pub-answer')
    const a = { el, q, declined: known?.declined ?? new Set<string>(), draw: () => {} }
    const text = field(`${id}:text`, { rows: 2, placeholder: q.proposal ? 'Anything else to tell the publisher (optional)' : 'Your answer', label: 'Your answer' })
    a.draw = () => {
      const p = q.proposal
      const place = `ans:${id}`
      const send = async (decline: string[]) => {
        if (!host.haveAuthor(place, () => void send(decline))) return
        try {
          const r = await api.publicationAnswer({ workspace: q.workspace, workflow: q.workflow, run: q.run, question: q.question.id, ...(p ? { version: p.version } : {}), decline, ...(text.value.trim() ? { text: text.value.trim() } : {}), author: host.author() })
          values.delete(`${id}:text`)
          el.replaceChildren(h('div.banner.ok', { role: 'status' }, r.message, ' ', h('a', { href: q.href }, 'Open the run')))
          answers.delete(id)
          void host.changed()
        } catch (e) {
          outcome.set(id, h('div.banner.error', { role: 'alert' }, `Not answered: ${bare(e)}. Your choices and words are kept.`))
          a.draw()
        }
      }
      const items = p?.items ?? []
      const declined = items.filter(i => a.declined.has(i.key))
      put(el,
        h('details.small.pub-question', h('summary', `The question (${q.question.id}, ${when(q.question.asked)})`), h('p', q.question.text)),
        p ? [h('p.small', `Proposal ${p.version}: ${items.length} item${items.length === 1 ? '' : 's'} would become public. Untick what should stay local; it is then recorded as kept local by your answer.`),
          ...['run records', 'workflows', 'the rest'].map(g => {
            const xs = items.filter(i => i.group === g)
            return xs.length ? h('div.pub-group', h('strong.small', g[0].toUpperCase() + g.slice(1)), h('ul.pub-items', xs.map(i => h('li.pub-item', h('label.pub-line',
              h('input', { type: 'checkbox', checked: !a.declined.has(i.key), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) a.declined.delete(i.key); else a.declined.add(i.key); a.draw() } }),
              h('span.pub-name', h('code', i.selection.replace(/^\[\[\w+\]\] /, ''))), h('span.small.muted', ` adds ${i.adds.length} file${i.adds.length === 1 ? '' : 's'}`)),
              h('details.small.d-only', h('summary', 'Files'), h('ul.pub-paths', i.adds.map(x => h('li', h('code', x))))))))) : null
          })] : q.proposalProblem ? h('div.banner.warn', q.proposalProblem) : h('p.small.muted', 'This question has no attached proposal: answer in words, or on the run.'),
        text, host.authorSlot(place), outcome.get(id) ?? null,
        h('div.row',
          p ? h('button.primary', { onclick: () => void send(declined.map(i => i.key)) }, declined.length ? `Approve ${items.length - declined.length}, keep ${declined.length} local` : 'Approve all')
            : h('button.primary', { onclick: () => { if (text.value.trim()) void send([]) } }, 'Send answer'),
          h('a.button.small', { href: q.href }, 'Open the run and the candidate')))
    }
    answers.set(id, a)
    a.draw()
    return el
  }

  return {
    project: projectEl,
    answer: answerEl,
    setQuestions: qs => { questions = qs; for (const r of rows.values()) if (r.open) r.draw() },
    isDirty: () => [...values.values()].some(v => v.trim()) || forms.size > 0,
  }
}
