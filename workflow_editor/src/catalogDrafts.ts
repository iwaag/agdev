// Drafts on the Catalog page (user_catalog p6 ex1, docs/mycatalog.md *Drafts*).
//
// A draft is written without a path, saved as it is typed (outside Git, in the
// installation's draft folder), opened again later, given to the summoner for
// advice, and registered as a braindump when the owner chooses. The card keeps
// its own DOM: the catalog's page may draw itself again around it without
// touching what is being typed. A save that fails or is refused keeps the text
// in place and says so; nothing here replaces the owner's text by itself.
import { api, ApiError, type CatalogDraft, type CatalogDraftAdvice, type CatalogDraftList, type CatalogDraftPreview } from './api.ts'
import { append, h, when } from './dom.ts'
import { icon } from './icons.ts'
import { renderMarkdown } from './markdown.ts'
import { sameTag } from '../shared/catalog.ts'
import { tagChips, tagInput } from './catalogView.ts'

export interface DraftsHost {
  author: () => string
  haveAuthor: (place: string, again: () => void) => boolean
  authorSlot: (place: string) => HTMLElement
  registered: () => Promise<void> // the catalog changed: read it again
}
export interface DraftsPanel { card: HTMLElement; load: () => Promise<void>; start: () => void; isDirty: () => boolean; dispose: () => void }

const UNSAVED_KEY = 'wfe.catalog.draft.unsaved'
type Unsaved = { id: string | null; base: number; text: string; at: string }
const readUnsaved = (): Unsaved | null => { try { return JSON.parse(localStorage.getItem(UNSAVED_KEY) ?? 'null') as Unsaved | null } catch { return null } }
const keepUnsaved = (u: Unsaved | null) => { try { if (u) localStorage.setItem(UNSAVED_KEY, JSON.stringify(u)); else localStorage.removeItem(UNSAVED_KEY) } catch { /* only a convenience */ } }
const STARTER = '# Title\n\nWhat I want, and why.\n'

export function draftsPanel(host: DraftsHost): DraftsPanel {
  const card = h('section.card.catalog-drafts.d-only', { dataset: { section: 'drafts' } })
  let list: CatalogDraftList | null = null
  let listError = ''
  let disposed = false
  let poll: ReturnType<typeof setInterval> | null = null

  // The open editor. `id` is null until the first save creates the draft.
  type Editor = {
    id: string | null; draft: CatalogDraft | null; base: number; advice: CatalogDraftAdvice[]
    text: HTMLTextAreaElement; ask: HTMLTextAreaElement; tags: ReturnType<typeof tagInput>; tagHost: HTMLElement
    state: 'saved' | 'dirty' | 'saving' | 'failed'; problem: string; conflict: { revision: number; by?: string; at?: string } | null
    timer: ReturnType<typeof setTimeout> | null; inflight: Promise<void> | null; again: boolean
    status: HTMLElement; body: HTMLElement; out: HTMLElement | null
    compare: Set<string>; register: { path: HTMLInputElement; preview: CatalogDraftPreview | null; reuse: boolean; out: HTMLElement | null } | null
  }
  let ed: Editor | null = null
  let asking = false // a request for advice is on its way: the button waits

  const say = (el: HTMLElement | null) => { if (ed) { ed.out = el; drawEditor() } }
  const error = (e: unknown) => h('div.banner.error', { role: 'alert' }, (e as Error).message)

  async function load() {
    try { list = await api.catalogDrafts(); listError = '' } catch (e) { listError = (e as Error).message; list = null }
    if (!disposed) draw()
  }

  // ---- saving ----------------------------------------------------------------
  function statusText(): HTMLElement {
    if (!ed) return h('span')
    const s = ed.state
    const where = list?.where ? ` in ${list.where}` : ''
    return h(`span.catalog-save-state.${s}`, { role: 'status' },
      s === 'saving' ? 'Saving…'
        : s === 'dirty' ? 'Not saved yet'
          : s === 'failed' ? `Not saved: ${ed.problem} Your text is kept here.`
            : ed.id ? `Saved${ed.draft ? `, revision ${ed.base}, ${when(ed.draft.saved.at)}` : ''}${where}` : 'Nothing written yet')
  }
  const showStatus = () => { if (ed) ed.status.replaceChildren(statusText()) }
  function changed() {
    if (!ed || ed.draft?.state === 'registered') return
    ed.state = 'dirty'; showStatus()
    keepUnsaved({ id: ed.id, base: ed.base, text: ed.text.value, at: new Date().toISOString() })
    if (ed.timer) clearTimeout(ed.timer)
    ed.timer = setTimeout(() => void save(), 1200)
  }
  // One save at a time; a change during a save saves again after it.
  async function save(): Promise<void> {
    if (!ed || ed.draft?.state === 'registered') return
    if (ed.timer) { clearTimeout(ed.timer); ed.timer = null }
    if (ed.inflight) { ed.again = true; return ed.inflight }
    if (ed.state === 'saved' || ed.conflict) return
    const e = ed
    if (!e.id && !e.text.value.trim()) return
    if (!host.author()) {
      e.state = 'failed'; e.problem = 'your name is needed first (asked below).'; showStatus()
      host.haveAuthor('draft', () => void save())
      return
    }
    e.state = 'saving'; showStatus()
    e.inflight = (async () => {
      const text = e.text.value, tags = e.tags.value()
      try {
        const r = e.id ? await api.catalogDraftSave(e.id, { text, tags }, e.base, host.author()) : await api.catalogDraftCreate(text, tags, host.author())
        e.id = r.draft.id; e.draft = r.draft; e.base = r.draft.revision
        e.state = e.text.value === text && JSON.stringify(e.tags.value()) === JSON.stringify(tags) ? 'saved' : 'dirty'
        if (e.state === 'saved') keepUnsaved(null)
        void load()
      } catch (err) {
        e.state = 'failed'
        const d = err instanceof ApiError ? err.detail as { code?: string; revision?: number; saved?: { by: string; at: string } } | undefined : undefined
        if (d?.code === 'stale') { e.conflict = { revision: d.revision ?? 0, by: d.saved?.by, at: d.saved?.at }; e.problem = `someone saved revision ${d.revision}${d.saved ? ` (${d.saved.by}, ${when(d.saved.at)})` : ''} after the one you are editing.` }
        else e.problem = `${(err as Error).message}.`
        drawEditor()
      } finally { e.inflight = null }
      showStatus()
      if (e.again) { e.again = false; if (e.state === 'dirty') await save() }
    })()
    return e.inflight
  }
  // Settles what is typed before an action that reads the saved revision.
  async function flush(): Promise<boolean> {
    if (!ed) return false
    if (ed.state !== 'saved') await save()
    if (ed.inflight) await ed.inflight
    return ed.state === 'saved' && !!ed.id
  }

  // ---- opening -----------------------------------------------------------------
  function openEditor(d: CatalogDraft | null, advice: CatalogDraftAdvice[] = []) {
    if (ed?.timer) clearTimeout(ed.timer)
    const text = h('textarea', { rows: 18, 'aria-label': 'Draft text', value: d?.text ?? STARTER }) as HTMLTextAreaElement
    const tagHost = h('div')
    const ask = h('textarea', { rows: 2, 'aria-label': 'What you want advice on', placeholder: 'Optional: what you want advice on (e.g. "Is the tag policy clear enough to follow mechanically?"). Kept with the advice, outside Git.' }) as HTMLTextAreaElement
    const e: Editor = { id: d?.id ?? null, draft: d, base: d?.revision ?? 0, advice, text, ask, tags: tagInput(d?.tags ?? [], () => changed()), tagHost,
      state: 'saved', problem: '', conflict: null, timer: null, inflight: null, again: false,
      status: h('span'), body: h('div.catalog-draft-editor'), out: null, compare: new Set<string>(), register: null }
    ed = e
    text.addEventListener('input', changed)
    text.addEventListener('blur', () => { if (ed === e && e.state === 'dirty') void save() })
    // Text typed in this browser that never reached the service (a failed save, a closed tab).
    const u = readUnsaved()
    if (u && u.id === e.id && u.text !== text.value) {
      e.out = h('div.banner.warn', `This browser kept text typed at ${when(u.at)} on revision ${u.base} that was not saved. `,
        h('button.small', { onclick: () => { text.value = u.text; e.out = null; changed(); drawEditor() } }, 'Restore it'), ' ',
        h('button.small', { onclick: () => { keepUnsaved(null); e.out = null; drawEditor() } }, 'Discard it'))
    }
    if (advice.some(a => a.state === 'requested')) startPolling()
    draw()
    card.scrollIntoView({ block: 'start', behavior: 'smooth' })
    text.focus({ preventScroll: true })
  }
  async function open(id: string) {
    if (ed && ed.id !== id && ed.state !== 'saved' && !confirm('The open draft has changes that are not saved. Leave it?')) return
    try { const r = await api.catalogDraft(id); openEditor(r.draft, r.advice) } catch (e) { listError = (e as Error).message; draw() }
  }
  function close() {
    if (ed && ed.state !== 'saved' && !confirm('This draft has changes that are not saved. Close it anyway? (This browser keeps a copy.)')) return
    if (ed?.timer) clearTimeout(ed.timer)
    ed = null; stopPolling(); draw()
  }
  function startPolling() {
    if (poll) return
    poll = setInterval(async () => {
      if (!ed?.id) return stopPolling()
      try {
        const r = await api.catalogDraft(ed.id)
        const before = JSON.stringify(ed.advice.map(a => [a.id, a.state]))
        ed.advice = r.advice
        if (JSON.stringify(r.advice.map(a => [a.id, a.state])) !== before) drawEditor()
        if (!r.advice.some(a => a.state === 'requested')) stopPolling()
      } catch { /* the next tick tries again */ }
    }, 8000)
  }
  function stopPolling() { if (poll) { clearInterval(poll); poll = null } }

  // ---- actions ---------------------------------------------------------------
  async function askAdvice() {
    if (!ed || asking) return
    if (!host.haveAuthor('draft', () => void askAdvice())) return
    asking = true; drawEditor()
    try {
      if (!await flush()) { say(h('div.banner.error', 'Save the draft first: advice is asked on a saved revision.')); return }
      const r = await api.catalogAsk({ draft: ed.id!, base: ed.base, author: host.author() })
      if (!r.duplicate) ed.advice = [r.advice, ...ed.advice]
      ed.ask.value = ''
      say(h(`div.banner.${r.duplicate ? 'warn' : 'ok'}`, `${r.message} `, r.href ? h('a', { href: r.href }, 'Open the run') : null, r.duplicate ? '' : ' Advice appears here when it is written; keep writing meanwhile.'))
      startPolling()
    } catch (e) { say(error(e)) } finally { asking = false; drawEditor() }
  }
  async function resolveConflict(keepMine: boolean) {
    if (!ed?.id) return
    const e = ed
    try {
      const r = await api.catalogDraft(e.id!)
      if (keepMine) { e.base = r.draft.revision; e.draft = r.draft; e.conflict = null; e.state = 'dirty'; await save() }
      else {
        const mine = e.text.value
        e.conflict = null; e.base = r.draft.revision; e.draft = r.draft; e.advice = r.advice
        e.text.value = r.draft.text; e.state = 'saved'
        e.tagHost.replaceChildren(); e.tags = tagInput(r.draft.tags, () => changed())
        keepUnsaved({ id: e.id, base: r.draft.revision, text: mine, at: new Date().toISOString() })
        e.out = h('div.banner.warn', 'The saved revision is shown. Your text is kept below to copy from (and in this browser).', h('pre.small', mine))
        drawEditor()
      }
    } catch (err) { say(error(err)) }
  }
  function adoptTag(t: { op: 'add' | 'remove'; tag: string }) {
    if (!ed) return
    const now = ed.tags.value()
    const next = t.op === 'add' ? (now.some(x => sameTag(x, t.tag)) ? now : [...now, t.tag]) : now.filter(x => !sameTag(x, t.tag))
    ed.tagHost.replaceChildren(); ed.tags = tagInput(next, () => changed())
    changed(); drawEditor()
  }
  function useRewrite(a: CatalogDraftAdvice) {
    if (!ed || !a.rewrite) return
    const newer = ed.base !== a.revision || ed.state !== 'saved'
    if (!confirm(newer ? `This rewrite was proposed for revision ${a.revision}; your text has changed since. Replace your present text with the proposed one? (Your present text stays in the revision history of this draft only as the saved revision ${ed.base}.)` : 'Replace your text with the proposed rewrite? It is saved as a new revision; the present one stays as the earlier revision.')) return
    ed.text.value = a.rewrite
    changed(); void save()
  }

  async function preview() {
    if (!ed?.register) return
    if (!await flush()) { ed.register.out = h('div.banner.error', 'Save the draft first.'); drawEditor(); return }
    const r = ed.register
    try { r.preview = await api.catalogDraftPreview(ed.id!, r.path.value.trim()); r.out = null } catch (e) { r.preview = null; r.out = error(e) }
    drawEditor()
  }
  async function register() {
    if (!ed?.register?.preview) return
    if (!host.haveAuthor('draft', () => void register())) return
    const r = ed.register, p = r.preview!
    if (ed.state !== 'saved' || ed.base !== p.revision) { r.out = h('div.banner.warn', 'The draft changed after the preview: preview it again.'); r.preview = null; drawEditor(); return }
    try {
      const x = await api.catalogDraftRegister(ed.id!, p.path ?? '', p.revision, host.author(), r.reuse)
      ed.draft = x.draft; ed.register = null
      ed.out = h('div.banner.ok', x.message)
      keepUnsaved(null)
      void load(); await host.registered()
      drawEditor()
    } catch (e) {
      const d = e instanceof ApiError ? e.detail as { code?: string } | undefined : undefined
      r.out = h('div.banner.error', { role: 'alert' }, (e as Error).message, d?.code === 'unknown' ? ' Press Register again: it finds an earlier commit before making one.' : '')
      if (d?.code === 'stale') r.preview = null
      drawEditor()
    }
  }

  // ---- drawing -----------------------------------------------------------------
  function adviceBlock(a: CatalogDraftAdvice): HTMLElement {
    const e = ed!
    const older = a.revision !== e.base
    const showCompare = e.compare.has(a.id)
    return h(`div.catalog-advice${older ? '.older' : ''}`,
      h('div.small', h('strong', 'Advice'), ` on revision ${a.revision}`, older ? h('span.chip.warn', { title: 'You have edited the draft since this advice read it' }, 'an older revision') : null,
        ` · ${a.state === 'requested' ? 'asked' : a.state}${a.written ? ` by ${a.written.by}, ${when(a.written.at)}` : `, ${when(a.requested.at)}`}`,
        a.run ? [' · ', h('a', { href: a.run.href }, `${a.run.workflow}/${a.run.run}`)] : null),
      a.ask ? h('div.small.catalog-asked', h('strong', 'You asked: '), a.ask) : null,
      a.state === 'requested' ? h('p.small.muted', 'The summoner is reading the draft and the catalog. You can keep writing; the advice stays labelled with the revision it read.') : null,
      a.problem ? h('p.small.stale', a.problem) : null,
      a.written?.read ? h('p.small.muted', `Read: ${a.written.read}`) : null,
      a.text ? renderMarkdown(a.text, () => null) : null,
      a.tags?.length ? h('div.catalog-proposal', h('strong.small', 'Suggested tags'),
        h('ul', a.tags.map(t => {
          const have = e.tags.value().some(x => sameTag(x, t.tag))
          const done = t.op === 'add' ? have : !have
          return h('li.small', h(`span.chip.tag${t.op === 'remove' ? '.warn' : ''}`, `${t.op === 'add' ? '+' : '−'}${t.tag}`), ' ', t.reason, ' ',
            done ? h('span.muted', '(as it is now)') : h('button.small', { onclick: () => adoptTag(t) }, t.op === 'add' ? 'Add it' : 'Remove it'))
        }))) : null,
      a.rewrite ? h('div.row',
        h('button.small', { onclick: () => { if (!e.compare.delete(a.id)) e.compare.add(a.id); drawEditor() } }, showCompare ? 'Hide the comparison' : 'Compare the proposed rewrite with my text'),
        h('button.small', { onclick: () => useRewrite(a) }, older ? 'Replace my newer text with it…' : 'Use the rewrite…')) : null,
      a.rewrite && showCompare ? h('div.catalog-compare', h('div', h('strong.small', `Proposed (for revision ${a.revision})`), h('pre', a.rewrite)), h('div', h('strong.small', 'Your text now'), h('pre', e.text.value))) : null)
  }
  function registerBlock(): HTMLElement | null {
    const e = ed!
    if (!e.register) return null
    const r = e.register, p = r.preview
    return h('div.catalog-register',
      h('strong.small', 'Register as a braindump'),
      h('p.small.muted', 'Your text and its tags become braindumps/episodes/<path>/ in the catalog, in one commit in your name. Nothing is published, no project is mapped and no preference is written by it. The draft stays until you remove it.'),
      h('label.small', 'Path below braindumps/episodes/ (its identity) ', r.path),
      h('div.row', h('button', { onclick: () => void preview() }, 'Preview')),
      p ? h('div',
        h('p.small', `Revision ${p.revision} as `, h('code', p.path ?? '(no path)'), p.tags.length ? [' with tags ', tagChips(p.tags)] : ' with no tags', ` · catalog ${p.head.slice(0, 7)}`),
        p.problems.map(x => h('div.banner.error', x)),
        p.warnings.map(x => h('div.banner.warn', x, h('label.small', ' ', h('input', { type: 'checkbox', checked: r.reuse, onchange: (ev: Event) => { r.reuse = (ev.target as HTMLInputElement).checked } }), ' It is the same braindump: use this path'))),
        h('div.catalog-text', renderMarkdown(p.draft.text, () => null)),
        h('div.row', h('button.primary', { disabled: p.problems.length > 0, onclick: () => void register() }, 'Register in the catalog'), h('button', { onclick: () => { e.register = null; drawEditor() } }, 'Cancel'))) : null,
      host.authorSlot('draft'),
      r.out)
  }
  function drawEditor() {
    const e = ed
    if (!e) return
    const done = e.draft?.state === 'registered'
    e.text.readOnly = !!done
    e.tagHost.replaceChildren(done ? (tagChips(e.draft!.tags) ?? h('span.small.muted', 'No tags.')) : e.tags.el)
    showStatus()
    e.body.replaceChildren()
    append(e.body, [
      h('div.card-head', h('h3', e.id ? 'Draft ' : 'New draft', e.id ? h('code.small.d-only', e.id) : null), e.status,
        h('button.small', { onclick: () => close() }, 'Close')),
      done ? h('div.banner.ok', `Registered as braindump ${e.draft!.registration!.path} (${e.draft!.registration!.commit?.slice(0, 7)}), revision ${e.draft!.registration!.revision}. This draft is kept until you remove it.`) : null,
      e.conflict ? h('div.banner.warn', { role: 'alert' }, `Not saved: ${e.problem} Your text is kept here. `,
        h('button.small', { onclick: () => void resolveConflict(true) }, `Save mine as revision ${e.conflict.revision + 1}`), ' ',
        h('button.small', { onclick: () => void resolveConflict(false) }, 'Show theirs (mine is kept to copy)')) : null,
      e.state === 'failed' && !e.conflict ? h('div.row', h('button.small', { onclick: () => { e.state = 'dirty'; void save() } }, 'Try saving again')) : null,
      e.text,
      e.tagHost,
      host.authorSlot('draft'),
      e.out,
      done ? null : h('label.small.catalog-ask', 'What you want advice on (optional)', e.ask),
      done ? null : h('div.row',
        h('button', { disabled: asking, title: 'The summoner reads this saved revision, your other braindumps (and your mybraindump conventions) and the projects here, and writes advice beside the draft. Nothing is changed by it.', onclick: () => void askAdvice() }, asking ? 'Asking…' : 'Ask for advice'),
        e.advice.some(a => a.state === 'requested') ? h('span.chip.warn', 'advice being written') : null,
        h('button.primary', { onclick: () => { e.register ??= { path: h('input', { value: e.draft?.path ?? '', placeholder: 'a-thought, or group/phase', size: 32, 'aria-label': 'Braindump path' }) as HTMLInputElement, preview: null, reuse: false, out: null }; drawEditor() } }, 'Register…'),
        h('span.small.muted', 'Saved as you type, outside Git. No path is needed until you register.')),
      registerBlock(),
      e.advice.length ? h('div', e.advice.map(adviceBlock)) : null,
      e.id ? h('div.row', h('button.small.danger', { onclick: async () => {
        if (!confirm(done ? 'Remove this draft and its advice? The braindump in the catalog stays.' : 'Remove this draft and its advice? Its text is not in the catalog and cannot be brought back.')) return
        if (!host.haveAuthor('draft', () => undefined)) return
        try { await api.catalogDraftRemove(e.id!, host.author()); keepUnsaved(null); ed = null; stopPolling(); await load() } catch (err) { say(error(err)) }
      } }, 'Remove the draft')) : null])
  }
  function draw() {
    const items = list?.drafts ?? []
    card.replaceChildren()
    append(card, [
      h('div.card-head', h('h2', 'Drafts'), h('span.muted.small.d-only', list ? `${items.length} · ${list.where}` : ''),
        h('button', { onclick: () => start() }, icon('plus', 'icon small'), 'Write a draft')),
      h('p.muted.small', 'Write freely here: a draft is saved as you type, outside Git, and is not part of the catalog. Ask the summoner for advice when you like, then register it as a braindump.'),
      listError ? h('div.banner.error', listError) : null,
      ed ? ed.body : null,
      items.filter(d => d.id !== ed?.id).map(d => h('div.catalog-draft', { dataset: { draft: d.id } },
        h('div.entry-head', h('a.catalog-bd-title', { href: '#/catalog', onclick: (ev: Event) => { ev.preventDefault(); void open(d.id) } }, h('strong', d.title)),
          d.state === 'registered' ? h('span.chip.ok', `registered as ${d.registration?.path}`) : d.registration?.state === 'pending' ? h('span.chip.warn', `registering as ${d.registration.path}`) : h('span.chip.muted', 'draft'),
          tagChips(d.tags),
          d.advice.total ? h('span.chip', `advice ${d.advice.written}/${d.advice.total}`) : null,
          h('span.muted.small', `revision ${d.revision} · ${d.saved.by} · ${when(d.saved.at)}`)),
        h('div.catalog-excerpt', d.excerpt))),
      list && !items.length && !ed ? h('p.muted.small', 'No drafts.') : null])
    if (ed) drawEditor()
  }

  function start() {
    if (ed && ed.state !== 'saved' && !confirm('The open draft has changes that are not saved. Leave it?')) return
    openEditor(null)
  }
  draw()
  return { card, load, start, isDirty: () => !!ed && ed.state !== 'saved', dispose: () => { disposed = true; stopPolling(); if (ed?.timer) clearTimeout(ed.timer) } }
}
