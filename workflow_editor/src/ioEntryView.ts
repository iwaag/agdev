// One entry of a run's detailed IO in full (p10): an attempt log's entry at
// one line, redacted, never the raw log. (Links to this page are also in the
// retired Zulip IO channels' messages.)
import { api, ApiError } from './api.ts'
import { h } from './dom.ts'
import type { ViewHandle } from './main.ts'

export function renderIoEntry(app: HTMLElement, wsId: string, workflow: string, run: string, attempt: string, line: number): ViewHandle {
  const runHref = `#/ws/${encodeURIComponent(wsId)}/run/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}`
  const body = h('div.io-entry', h('p.muted', 'Loading…'))
  app.append(h('header.app-header', h('nav.crumbs', h('a', { href: '#/' }, 'Projects'), ' / ', h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, wsId), ' / ', h('a', { href: runHref }, `${workflow}/${run}`), ' / ', `IO ${attempt} · line ${line}`)),
    h('main.io-main', h('h1', `Detailed IO — ${workflow}/${run}`), h('p.muted.small', `Attempt ${attempt}, log line ${line}: the whole entry.`), body))
  let gone = false
  api.runIo(wsId, workflow, run, attempt, line).then(v => {
    if (gone) return
    body.replaceChildren(...(v.entries.length ? v.entries.map(e => h('section.io-item', h('h2.small', e.head || (e.kind === 'text' ? 'Agent' : e.kind)), e.body !== undefined ? h('pre.io-body', e.body) : null)) : [h('p.muted', 'Nothing at that line is IO (it may be bookkeeping the IO leaves out).')]),
    )
  }, (e: unknown) => { if (!gone) body.replaceChildren(h('p.error', e instanceof ApiError ? e.message : String(e))) })
  return { dispose: () => { gone = true }, isDirty: () => false }
}
