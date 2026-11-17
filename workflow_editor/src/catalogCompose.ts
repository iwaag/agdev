// The writing field of the Catalog page (user_catalog p6 ex2, docs/mycatalog.md
// *Writing a braindump*).
//
// One field, always there, and two buttons: *Put it in the catalog* (or
// *Update it* for a braindump opened with *Edit*) and *Ask* (user_catalog p7:
// the text is for the summoner to read and answer, an unfinished braindump, an
// instruction or a question; nothing of it enters the catalog; its answer may
// propose actions, each a line with *Do it* and *No*). Typing
// saves (ex1's drafts, outside Git; the page does not call them that). The
// main button saves and registers the text on the screen as one commit; the
// service gives the path, takes tags from the text, and asks the summoner for
// the review by itself. Texts not yet in the catalog are listed under the
// field as *Unfinished*. The card keeps its own DOM: the page may draw itself
// again around it without touching what is being typed. A refused change
// keeps the text and says why in place.
import { api, ApiError, type CatalogAskAction, type CatalogDraft, type CatalogDraftAdvice, type CatalogDraftList } from './api.ts'
import { h, when } from './dom.ts'
import { renderMarkdown } from './markdown.ts'
import { braindumpTitle, sameTag, textTags } from '../shared/catalog.ts'
import { tagChips } from './catalogView.ts'

export interface ComposeHost {
  author: () => string
  haveAuthor: (place: string, again: () => void) => boolean
  authorSlot: (place: string) => HTMLElement
  changed: () => Promise<void> // the catalog changed: read it again
  // user_catalog p8: the tags offered at the field, each with its meaning and what follows from it.
  tagChoices?: () => { tag: string; meaning: string }[]
}
export interface ComposePanel {
  card: HTMLElement; load: () => Promise<void>
  edit: (b: { id: string; title: string; text: string; base?: string }) => Promise<void>
  isDirty: () => boolean; dispose: () => void
  openAsked: (draft: string) => Promise<void> // user_catalog p8: an answer opened from Waiting for you
}

const PLACE = 'compose'
const UNSAVED_KEY = 'wfe.catalog.compose.unsaved'
type Of = { path: string; base?: string; title: string; original: string }
type Unsaved = { id: string | null; base: number; of: Of | null; text: string; at: string }
const local = <T>(key: string, fallback: T): T => { try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback } catch { return fallback } }
const keep = (key: string, v: unknown) => { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)) } catch { /* only a convenience */ } }
const titleOf = (text: string) => { const t = braindumpTitle('', text); return t || text.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 80) || '(untitled)' }

export function composePanel(host: ComposeHost): ComposePanel {
  let id: string | null = null, draft: CatalogDraft | null = null, base = 0, of: Of | null = null
  let advice: CatalogDraftAdvice[] = []
  let state: 'saved' | 'dirty' | 'saving' | 'failed' = 'saved', problem = '', conflict = false
  let timer: ReturnType<typeof setTimeout> | null = null, inflight: Promise<void> | null = null, again = false
  let putting = false, asking = false, disposed = false
  let poll: ReturnType<typeof setInterval> | null = null
  let list: CatalogDraftList | null = null
  const compare = new Set<string>()
  let asked: Awaited<ReturnType<typeof api.catalogAsked>>['asked'] = []
  const busy = new Set<string>() // actions being carried out: '<ask>:<n>'

  const heading = h('h2')
  const status = h('span.catalog-save-state', { role: 'status' })
  const text = h('textarea.catalog-compose-text', { rows: 9, 'aria-label': 'What you want', placeholder: 'What you want, and why: the first line is its title, #words are its tags. Or what you ask of the summoner.' }) as HTMLTextAreaElement
  const tags = h('div.catalog-compose-tags')
  const tagOffer = h('div.catalog-tag-examples.small.catalog-compose-offer')
  const putBtn = h('button.primary', { onclick: () => void put() })
  const askBtn = h('button', { title: 'The summoner reads this text and answers below: an unfinished braindump, an instruction (suggest the links, rename this, make my tag conventions rules) or a question. Nothing of it is put in the catalog.', onclick: () => void askFirst() })
  const newBtn = h('button.small', { title: 'Keep this text under Unfinished and start an empty one', onclick: () => void startNew() }, 'Start a new text')
  const pathIn = h('input', { placeholder: 'from the first line', size: 28, 'aria-label': 'Braindump path' }) as HTMLInputElement
  const where = h('span.small.muted')
  const detail = h('div.catalog-compose-detail.d-only',
    h('label.small.catalog-compose-path', 'Path below braindumps/episodes/ (optional; otherwise the service names it from the first line) ', pathIn),
    where)
  const slot = host.authorSlot(PLACE)
  const out = h('div.catalog-compose-out')
  const adviceHost = h('div')
  const unfinished = h('div.catalog-unfinished')
  const askedHost = h('div.catalog-unfinished.catalog-asked-list')
  const card = h('section.card.catalog-compose', { dataset: { section: 'write' } },
    h('div.card-head', heading, status), text, tags, tagOffer, h('div.row.catalog-compose-actions', putBtn, askBtn, newBtn), detail, slot, out, adviceHost, unfinished, askedHost)

  const say = (el: HTMLElement | null) => { out.replaceChildren(...(el ? [el] : [])) }
  const error = (e: unknown, extra = '') => h('div.banner.error', { role: 'alert' }, (e as Error).message, extra)

  // ---- drawing (never the field itself) ------------------------------------------
  function drawStatus() {
    status.className = `catalog-save-state ${state}`
    status.textContent = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Not saved yet'
      : state === 'failed' ? `Not saved: ${problem} Your text is kept here.` : id ? 'Saved' : ''
    where.textContent = id ? `Saved as typed in ${list?.where ?? 'the drafts folder'}, outside Git: ${id}, revision ${base}${of ? `; a change of ${of.path} read at ${of.base?.slice(0, 7) ?? '?'}` : ''}.` : 'Saved as you type, outside Git, until you put it in the catalog.'
  }
  const currentTags = () => { const t = [...(draft?.tags ?? [])]; for (const x of textTags(text.value)) if (!t.some(y => sameTag(y, x))) t.push(x); return t }
  function drawTags() {
    const t = currentTags(); tags.replaceChildren(...(t.length ? [h('span.small.muted', 'Tags: '), tagChips(t)!] : []))
    // A choice adds #tag at the end of the text (the service takes #words of the text as its tags).
    const offer = (host.tagChoices?.() ?? []).filter(c => !t.some(x => sameTag(x, c.tag)))
    tagOffer.replaceChildren(...(offer.length ? [h('span.muted', 'Add a tag: '), ...offer.map(c => h('button.chip.tag.example', { type: 'button', title: c.meaning, onclick: () => { text.value = `${text.value.replace(/\s+$/, '')}${text.value.trim() ? '\n\n' : ''}#${c.tag}\n`; changed(); drawTags() } }, `+${c.tag}`)),
      h('span.muted.catalog-tag-meanings', offer.map(c => `#${c.tag}: ${c.meaning}`).join(' · '))] : []))
  }
  function drawButtons() {
    heading.textContent = of ? `Change “${of.title}”` : 'Write what you want'
    putBtn.textContent = putting ? (of ? 'Updating…' : 'Putting it in…') : of ? 'Update it' : 'Put it in the catalog'
    putBtn.toggleAttribute('disabled', putting)
    askBtn.textContent = asking ? 'Asking…' : 'Ask'
    askBtn.toggleAttribute('disabled', asking)
    newBtn.hidden = !of && !text.value.trim()
    pathIn.closest('label')!.toggleAttribute('hidden', !!of)
  }
  const ACTION_WORDS: Record<string, (a: CatalogAskAction) => string> = {
    'suggest-links': () => 'Have the summoner suggest which braindump grounds which project.',
    review: a => a.braindump ? `Have the summoner review “${a.braindump}”.` : 'Have the summoner review the braindumps that are due.',
    index: () => 'Have the summoner rewrite the list of what is not yet real.',
    tags: a => `${a.braindump ? `Tags of “${a.braindump}”` : 'Tags of this text'}: ${(a.changes ?? []).map(c => `${c.op === 'add' ? '+' : '−'}${c.tag}`).join(' ')}`,
    rename: a => `Rename “${a.braindump}” to “${a.to}”.`,
    archive: a => `Archive “${a.braindump}”: it is kept to be read and is no braindump any more.`,
    'use-text': () => 'Use the rewritten text as your text. Nothing is put in the catalog by it.',
    'adopt-rule': a => `Adopt a rule: ${a.follows === 'default-licence' ? `a project published for the first time is licensed ${a.licence}` : a.project ? `project ${a.project} is ${a.follows === 'never-publish' ? 'never published' : 'to be published'}` : `a braindump tagged #${a.tag} is ${a.follows === 'never-publish' ? 'never published' : 'suggested for the public list'}`}. From “${a.source?.braindump}”: “${a.source?.sentence}”`,
    publish: a => a.publishTarget && a.publishTarget !== 'mycatalog' ? `Ask the publisher to publish ${a.publishTarget}.` : 'Ask the publisher to publish the catalog (what its public list selects).',
    'retire-rule': a => `Retire the rule ${a.rule}.`,
    'hand-over': a => `Hand this text to ${a.target?.workspace ?? 'the facilitating project'} as a request for work. Your text will be in that run's request, in Git.`,
  }
  function actionLine(a: CatalogDraftAdvice, x: CatalogAskAction, i: number): HTMLElement {
    const key = `${a.id}:${i + 1}`
    const tagsLine = x.do === 'tags'
    return h(`div.catalog-tag-line.catalog-action.${x.state}`, { title: x.why ?? '' },
      h('span.small.catalog-action-words', (ACTION_WORDS[x.do] ?? (() => x.do))(x), x.why && !tagsLine ? h('span.muted', ` ${x.why}`) : null),
      x.state === 'proposed' || x.state === 'failed' ? [
        h('button.small.primary', { disabled: busy.has(key), onclick: () => void doAction(a, i + 1) }, busy.has(key) ? 'Doing it…' : x.state === 'failed' ? 'Try again' : tagsLine ? 'OK' : 'Do it'),
        h('button.small', { disabled: busy.has(key), onclick: () => void declineAction(a, i + 1) }, 'No')] : null,
      x.state === 'done' ? h('span.chip.ok', 'done') : x.state === 'declined' ? h('span.chip.muted', 'no') : null,
      x.result && x.state !== 'declined' ? h(`span.small.${x.state === 'failed' ? 'stale' : 'muted'}.catalog-action-result`, x.state === 'failed' ? `Not done: ${x.result.message}` : x.result.message, x.result.href ? [' ', h('a', { href: x.result.href }, 'Open the run')] : null) : null)
  }
  function adviceBlock(a: CatalogDraftAdvice): HTMLElement {
    const older = a.revision !== base
    return h(`div.catalog-advice${older ? '.older' : ''}`,
      h('div.small', h('strong', a.state === 'requested' ? 'The summoner is reading it…' : a.state === 'failed' ? 'No answer' : 'The summoner\'s answer'),
        older ? h('span.chip.warn', { title: 'You changed the text after the summoner read it' }, 'on an earlier version') : null,
        h('span.muted.d-only', ` · ${a.kind ?? 'not read yet'} · revision ${a.revision} · ${a.written ? `${a.written.by}, ${when(a.written.at)}` : when(a.requested.at)}`),
        a.run ? h('a.small.d-only', { href: a.run.href }, ` ${a.run.workflow}/${a.run.run}`) : null,
        a.state !== 'requested' ? h('button.small.catalog-dismiss', { title: a.kind === 'instruction' || a.kind === 'question' ? 'Take this answer and its text off the page' : 'Take this answer off the page; your text stays', onclick: () => void dismiss(a.draft, a.id) }, 'Dismiss') : null),
      a.ask ? h('div.small.catalog-asked.d-only', h('strong', 'You asked: '), a.ask) : null,
      a.state === 'requested' ? h('p.small.muted', 'You can keep writing meanwhile; the answer appears here.') : null,
      a.problem ? h('p.small.stale', a.problem) : null,
      a.text ? renderMarkdown(a.text, () => null) : null,
      a.written?.read ? h('p.small.muted.d-only', `Read: ${a.written.read}`) : null,
      (a.actions ?? []).map((x, i) => actionLine(a, x, i)),
      a.rewrite ? h('div.row',
        h('button.small', { onclick: () => { if (!compare.delete(a.id)) compare.add(a.id); drawAdvice() } }, compare.has(a.id) ? 'Hide the comparison' : 'Compare the rewritten text with mine')) : null,
      a.rewrite && compare.has(a.id) ? h('div.catalog-compare', h('div', h('strong.small', 'Rewritten'), h('pre', a.rewrite)), h('div', h('strong.small', 'Your text now'), h('pre', text.value))) : null)
  }
  function drawAdvice() { adviceHost.replaceChildren(...advice.filter(a => !a.dismissed).map(adviceBlock)) }
  function drawUnfinished() {
    // A text the summoner read as an instruction or a question is listed under Asked, not here.
    const items = (list?.drafts ?? []).filter(d => d.state !== 'registered' && d.id !== id && d.asked !== 'instruction' && d.asked !== 'question')
    unfinished.replaceChildren(...(items.length ? [h('strong.small', 'Unfinished'),
      h('ul', items.map(d => h('li', h('a', { href: '#/catalog', onclick: (e: Event) => { e.preventDefault(); void open(d.id) } }, d.of ? `Change of “${d.title}”` : d.title),
        h('span.small.muted', ` · ${when(d.saved.at)}`), d.registration?.state === 'pending' ? h('span.chip.warn', { title: 'Its last attempt to go in had no known answer; press the button again: it finds what was committed' }, 'not finished going in') : null)))] : []))
  }
  // user_catalog p7: every asked text that was not dismissed, with the state of its answer and of its actions.
  function drawAsked() {
    const words = (x: typeof asked[number]) => {
      if (x.state === 'requested') return 'the summoner is reading it'
      if (x.state === 'failed') return 'no answer'
      const open = x.actions.filter(y => y.state === 'proposed' || y.state === 'failed').length, done = x.actions.filter(y => y.state === 'done').length
      return `answered${x.actions.length ? `: ${[open ? `${open} to answer` : '', done ? `${done} done` : '', x.actions.length - open - done ? `${x.actions.length - open - done} declined` : ''].filter(Boolean).join(', ')}` : ''}`
    }
    askedHost.replaceChildren(...(asked.length ? [h('strong.small', 'Asked'),
      h('ul', asked.map(x => h('li', h('a', { href: '#/catalog', title: 'Open the text with its answer', onclick: (e: Event) => { e.preventDefault(); void open(x.draft) } }, x.title),
        h('span.small.muted', ` · ${words(x)} · ${when(x.requested.at)}`),
        x.state !== 'requested' ? h('button.small.catalog-dismiss', { onclick: () => void dismiss(x.draft, x.id) }, 'Dismiss') : null)))] : []))
  }
  function draw() { drawStatus(); drawTags(); drawButtons(); drawAdvice(); drawUnfinished(); drawAsked() }

  // ---- saving ----------------------------------------------------------------------
  function changed() {
    state = 'dirty'; conflict = false
    keep(UNSAVED_KEY, { id, base, of, text: text.value, at: new Date().toISOString() } satisfies Unsaved)
    drawStatus(); drawTags(); drawButtons()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void save(), 1200)
  }
  async function save(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null }
    if (inflight) { again = true; return inflight }
    if (state === 'saved' || conflict) return
    if (!id && !text.value.trim()) { state = 'saved'; drawStatus(); return }
    if (!host.author()) { state = 'failed'; problem = 'your name is needed first (asked below).'; drawStatus(); host.haveAuthor(PLACE, () => void save()); return }
    state = 'saving'; drawStatus()
    inflight = (async () => {
      const t = text.value
      try {
        const r = id ? await api.catalogDraftSave(id, { text: t }, base, host.author()) : await api.catalogDraftCreate(t, [], host.author(), of ? { path: of.path, base: of.base } : undefined)
        id = r.draft.id; draft = r.draft; base = r.draft.revision
        state = text.value === t ? 'saved' : 'dirty'
        if (state === 'saved') keep(UNSAVED_KEY, null)
        void loadList()
      } catch (err) {
        state = 'failed'
        const d = err instanceof ApiError ? err.detail as { code?: string; revision?: number; saved?: { by: string; at: string } } | undefined : undefined
        if (d?.code === 'stale') {
          conflict = true
          problem = `someone else saved this text meanwhile${d.saved ? ` (${d.saved.by}, ${when(d.saved.at)})` : ''}.`
          say(h('div.banner.warn', { role: 'alert' }, `Not saved: ${problem} Your text is kept here. `,
            h('button.small', { onclick: () => void resolve(true) }, 'Keep mine'), ' ', h('button.small', { onclick: () => void resolve(false) }, 'Show theirs (mine is kept to copy)')))
        } else problem = `${(err as Error).message}.`
      } finally { inflight = null }
      drawStatus()
      if (again) { again = false; if (state === 'dirty') await save() }
    })()
    return inflight
  }
  async function flush(): Promise<boolean> {
    if (state !== 'saved') await save()
    if (inflight) await inflight
    return state === 'saved' && !!id
  }
  async function resolve(mine: boolean) {
    if (!id) return
    try {
      const r = await api.catalogDraft(id)
      if (mine) { base = r.draft.revision; draft = r.draft; conflict = false; state = 'dirty'; say(null); await save() }
      else {
        const kept = text.value
        conflict = false; base = r.draft.revision; draft = r.draft; advice = r.advice; text.value = r.draft.text; state = 'saved'
        keep(UNSAVED_KEY, { id, base, of, text: kept, at: new Date().toISOString() } satisfies Unsaved)
        say(h('div.banner.warn', 'Their text is shown. Yours is kept here to copy from (and in this browser).', h('pre.small', kept)))
      }
    } catch (e) { say(error(e)) }
    draw()
  }

  // ---- opening and starting --------------------------------------------------------
  function reset() {
    if (timer) clearTimeout(timer)
    id = null; draft = null; base = 0; of = null; advice = []; state = 'saved'; conflict = false; problem = ''
    text.value = ''; pathIn.value = ''
    stopPolling()
  }
  async function startNew() {
    if (!await settle()) return
    reset(); say(null); draw(); text.focus()
  }
  // Saves what is typed before the field holds something else; false when it could not be saved.
  async function settle(): Promise<boolean> {
    if (state === 'saved') return true
    if (await flush()) return true
    return confirm(`This text could not be saved (${problem}). Leave it? This browser keeps a copy.`)
  }
  async function open(did: string, note?: string) {
    if (!await settle()) return
    try {
      const r = await api.catalogDraft(did)
      reset()
      id = r.draft.id; draft = r.draft; base = r.draft.revision; advice = r.advice; text.value = r.draft.text
      of = r.draft.of ? { path: r.draft.of, base: r.draft.ofBase, title: titleOf(r.draft.text), original: '' } : null
      pathIn.value = r.draft.path ?? ''
      say(note ? h('div.banner.ok', note) : null)
      if (advice.some(a => a.state === 'requested')) startPolling()
      draw()
      card.scrollIntoView({ block: 'start', behavior: 'smooth' }); text.focus({ preventScroll: true })
    } catch (e) { say(error(e)) }
  }
  async function edit(b: { id: string; title: string; text: string; base?: string }) {
    if (!await settle()) return
    const mine = list?.drafts.find(d => d.of === b.id && d.state !== 'registered')
    if (mine) return open(mine.id, 'Your unfinished change of this braindump is opened.')
    reset()
    of = { path: b.id, base: b.base, title: b.title, original: b.text }
    text.value = b.text
    say(null); draw()
    card.scrollIntoView({ block: 'start', behavior: 'smooth' }); text.focus({ preventScroll: true })
  }

  // ---- the two buttons -------------------------------------------------------------
  async function put(o: { reuseArchived?: boolean } = {}) {
    if (putting) return
    if (!text.value.trim()) { say(h('div.banner.warn', 'Write something first.')); return }
    if (of && !id && text.value === of.original) { say(h('div.banner.ok', 'Nothing changed.')); return }
    if (!host.haveAuthor(PLACE, () => void put(o))) return
    putting = true; drawButtons()
    try {
      if (!await flush()) { say(h('div.banner.error', { role: 'alert' }, `Not saved: ${problem} Your text is kept here.`)); return }
      const wasOf = of, title = titleOf(text.value)
      const r = await api.catalogDraftPut(id!, { text: text.value, base, author: host.author(), ...(pathIn.value.trim() && !of ? { path: pathIn.value.trim() } : {}), ...(o.reuseArchived ? { reuseArchived: true } : {}) })
      reset()
      keep(UNSAVED_KEY, null)
      say(h('div.banner.ok', { role: 'status' }, r.unchanged ? `Nothing changed in “${title}”.`
        : wasOf ? `Updated “${title}”. The summoner reads it again within a few minutes.` : `In the catalog: “${title}”. The summoner reads it within a few minutes; its review appears on its card.`,
        h('span.small.muted.d-only', ` (${r.path}, ${r.commit.slice(0, 7)})`)))
      draw()
      await host.changed()
    } catch (e) {
      const d = e instanceof ApiError ? e.detail as { code?: string } | undefined : undefined
      if (d?.code === 'changed') say(h('div.banner.warn', { role: 'alert' }, `${(e as Error).message}. `, h('button.small', { onclick: () => void overwrite() }, 'Put mine over it')))
      else if (d?.code === 'archived-path') say(h('div.banner.warn', { role: 'alert' }, `${(e as Error).message}. `, h('button.small', { onclick: () => void put({ reuseArchived: true }) }, 'It is the same braindump: use this path')))
      else say(error(e, d?.code === 'unknown' ? ' Press the button again: it finds an earlier commit before making one.' : ' Your text is kept here.'))
    } finally { putting = false; drawButtons() }
  }
  // The braindump changed after its text was opened: this text goes on top of the present one.
  async function overwrite() {
    if (!id || !of) return
    try {
      const b = await api.catalogBraindump(of.path)
      const r = await api.catalogDraftSave(id, { ofBase: b.updated?.commit }, base, host.author())
      base = r.draft.revision; draft = r.draft; of = { ...of, base: b.updated?.commit }
      await put()
    } catch (e) { say(error(e)) }
  }
  async function askFirst() {
    if (asking) return
    if (!text.value.trim()) { say(h('div.banner.warn', 'Write something first.')); return }
    if (!host.haveAuthor(PLACE, () => void askFirst())) return
    asking = true; drawButtons()
    try {
      if (!await flush()) { say(h('div.banner.error', `Not saved: ${problem} Your text is kept here.`)); return }
      const r = await api.catalogAsk({ draft: id!, base, author: host.author() })
      if (!r.duplicate) advice = [r.advice, ...advice]
      say(r.duplicate ? h('div.banner.warn', 'Already asked: the summoner is still reading this text.') : null)
      startPolling(); void loadList()
    } catch (e) { say(error(e)) } finally { asking = false; drawButtons(); drawAdvice() }
  }
  // *Do it*: the service carries the action out in your name; what it did is said on the line.
  async function doAction(a: CatalogDraftAdvice, n: number) {
    const key = `${a.id}:${n}`
    if (busy.has(key)) return
    if (!host.haveAuthor(PLACE, () => void doAction(a, n))) return
    const what = a.actions?.[n - 1]?.do
    // An action on the text itself needs the text as it is on the screen saved first.
    if ((what === 'use-text' || (what === 'tags' && !a.actions?.[n - 1]?.braindump)) && a.draft === id && !await flush()) { say(h('div.banner.error', `Not saved: ${problem} Your text is kept here.`)); return }
    busy.add(key); drawAdvice()
    try {
      const r = await api.catalogAskDo(a.draft, a.id, n, host.author())
      advice = advice.map(x => x.id === r.advice.id ? r.advice : x)
      if (a.draft === id && (what === 'use-text' || what === 'tags')) { const d = await api.catalogDraft(id); draft = d.draft; base = d.draft.revision; if (what === 'use-text') { text.value = d.draft.text; state = 'saved' } }
      say(null)
      if (r.ok && (r.commit || r.href)) await host.changed()
    } catch (e) { say(error(e)) } finally { busy.delete(key); draw(); void loadList() }
  }
  async function declineAction(a: CatalogDraftAdvice, n: number) {
    if (!host.haveAuthor(PLACE, () => void declineAction(a, n))) return
    try { const r = await api.catalogAskDecline(a.draft, a.id, n, host.author()); advice = advice.map(x => x.id === r.advice.id ? r.advice : x) } catch (e) { say(error(e)) }
    drawAdvice(); void loadList(); void host.changed()
  }
  async function dismiss(did: string, aid: string) {
    if (!host.haveAuthor(PLACE, () => void dismiss(did, aid))) return
    try {
      const r = await api.catalogAskDismiss(did, aid, host.author())
      advice = advice.filter(x => x.id !== aid)
      if (r.removed && did === id) { reset(); keep(UNSAVED_KEY, null) }
      say(null)
    } catch (e) { say(error(e)) }
    draw(); await loadList(); await host.changed()
  }

  function startPolling() {
    if (poll) return
    poll = setInterval(async () => {
      try {
        if (id) {
          const r = await api.catalogDraft(id)
          const before = JSON.stringify(advice.map(x => [x.id, x.state]))
          advice = r.advice
          if (JSON.stringify(advice.map(x => [x.id, x.state])) !== before) { drawAdvice(); void host.changed() }
        }
        const wasReading = asked.filter(x => x.state === 'requested').map(x => x.id)
        await loadList()
        // user_catalog p8: an answer that arrived for another text opens in the field (Waiting for you lists it too).
        const arrived = asked.find(x => wasReading.includes(x.id) && x.state !== 'requested')
        if (arrived) { await host.changed(); if (arrived.draft !== id && state === 'saved' && !text.value.trim()) await open(arrived.draft) }
        if (!advice.some(x => x.state === 'requested') && !asked.some(x => x.state === 'requested')) stopPolling()
      } catch { /* the next tick tries again */ }
    }, 8000)
  }
  function stopPolling() { if (poll) { clearInterval(poll); poll = null } }
  async function loadList() {
    try { list = await api.catalogDrafts() } catch (e) { list = null; unfinished.replaceChildren(h('p.small.muted', `Unfinished texts cannot be listed: ${(e as Error).message}`)); return }
    // An ask on a text that is in the catalog by now is history: its braindump has the summoner's review.
    try { asked = (await api.catalogAsked()).asked.filter(x => !x.registered) } catch { asked = [] }
    if (!disposed) { drawUnfinished(); drawAsked(); drawStatus(); if (asked.some(x => x.state === 'requested')) startPolling() }
  }

  text.addEventListener('input', changed)
  text.addEventListener('blur', () => { if (state === 'dirty') void save() })
  // Text typed in this browser that never reached the service (a failed save, a closed tab).
  const u = local<Unsaved | null>(UNSAVED_KEY, null)
  if (u?.text?.trim()) say(h('div.banner.warn', `This browser kept a text typed at ${when(u.at)} that was not saved. `,
    h('button.small', { onclick: async () => { if (u.id) await open(u.id); else { reset(); of = u.of } text.value = u.text; say(null); changed(); draw() } }, 'Restore it'), ' ',
    h('button.small', { onclick: () => { keep(UNSAVED_KEY, null); say(null) } }, 'Discard it')))
  draw()
  return {
    card, load: loadList, edit, openAsked: (did: string) => open(did),
    isDirty: () => state !== 'saved' || !!inflight,
    dispose: () => { disposed = true; stopPolling(); if (timer) clearTimeout(timer) },
  }
}
