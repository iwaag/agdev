// Hash routes: #/ (projects, create and register), #/nodes (user nodes, p7/ex1), #/ws/<workspace>
// (project editor), #/ws/<workspace>/wf/<file> (the published workflow) and
// #/ws/<workspace>/run/<workflow>/<run>[/at/<devdocs commit>] (run view) and
// #/ws/<workspace>/wf/<file>/draft/<id> (a draft), .../wf/<file>/checkout (what a
// checkout holds), #/ws/<workspace>/run/<workflow>/<run>/definition[/<revision>]
// (what a run started with) (one graph, by source: p20, docs/drafts.md) and
// #/ws/<workspace>/run/<workflow>/<run>/io/<attempt>/<line> (one IO entry in full, p10)
// and #/context[/<workspace>[/<workflow>]] (the scoped context overview, p13)
// and #/cluster (the management relationships this installation knows, improve_multinodes p4)
// and #/usage (subscription windows and what executions used, retire_old_ui p1)
// and #/ws/<workspace>/review/<workflow>/<run>/<rv> (a human review round, p17)
// and #/mind (braindumps and the projects they ground, summoner p1).
// A trailing /context on Home (#/home/context), a project or a workflow opens
// that editor's Context section (p13 ex1).
import './styles.css'
import { renderHomeView } from './homeView.ts'
import { renderNodesView } from './nodesView.ts'
import { renderProjectView } from './projectView.ts'
import { renderRunView } from './runView.ts'
import { renderIoEntry } from './ioEntryView.ts'
import { renderReviewView } from './reviewView.ts'
import { renderWorkflowView } from './workflowView.ts'
import { renderContextChooser, renderContextView } from './contextView.ts'
import { renderUsageView } from './usageView.ts'
import { renderClusterView } from './clusterView.ts'
import { renderMindView } from './mindView.ts'
import { closeReader } from './contextParts.ts'
import { loadSite, setWebOrigin } from './site.ts'

const app = document.getElementById('app')!
let dispose: (() => void) | undefined

// A view with unsaved changes can veto navigation away from it.
export interface ViewHandle { dispose: () => void; isDirty: () => boolean }
let current: ViewHandle | undefined
let lastHash = location.hash

function route() {
  if (current?.isDirty() && location.hash !== lastHash) {
    if (!confirm('Discard unsaved changes in this view?')) { history.replaceState(null, '', lastHash); return }
  }
  lastHash = location.hash
  dispose?.(); current = undefined
  closeReader()
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  app.replaceChildren()
  if (parts[0] === 'ws' && parts[1] && parts[2] === 'run' && parts[3] && parts[4] && parts[5] === 'io' && parts[6] && parts[7]) {
    current = renderIoEntry(app, parts[1], parts[3], parts[4], parts[6], Number(parts[7]))
  } else if (parts[0] === 'ws' && parts[1] && parts[2] === 'review' && parts[3] && parts[4] && parts[5]) {
    current = renderReviewView(app, parts[1], parts[3], parts[4], parts[5])
  } else if (parts[0] === 'ws' && parts[1] && parts[2] === 'run' && parts[3] && parts[4] && parts[5] === 'definition') {
    current = renderWorkflowView(app, parts[1], `${parts[3]}.yaml`, { source: { kind: 'run', workflow: parts[3], run: parts[4], revision: parts[6] } })
  } else if (parts[0] === 'ws' && parts[1] && parts[2] === 'run' && parts[3] && parts[4]) {
    current = renderRunView(app, parts[1], parts[3], parts[4], parts[5] === 'at' ? parts[6] : undefined)
  } else if (parts[0] === 'ws' && parts[1] && parts[2] === 'wf' && parts[3]) {
    current = renderWorkflowView(app, parts[1], parts[3], {
      context: parts[4] === 'context',
      source: parts[4] === 'draft' && parts[5] ? { kind: 'draft', id: parts[5] } : parts[4] === 'checkout' ? { kind: 'checkout' } : { kind: 'published' },
    })
  } else if (parts[0] === 'context') {
    current = parts[1] ? renderContextView(app, parts[1], parts[2]) : renderContextChooser(app)
  } else if (parts[0] === 'cluster') {
    current = renderClusterView(app)
  } else if (parts[0] === 'mind') {
    current = renderMindView(app)
  } else if (parts[0] === 'usage') {
    current = renderUsageView(app)
  } else if (parts[0] === 'nodes') {
    current = renderNodesView(app)
  } else if (parts[0] === 'ws' && parts[1]) {
    current = renderProjectView(app, parts[1], { context: parts[2] === 'context' })
  } else {
    current = renderHomeView(app, { context: parts[0] === 'home' && parts[1] === 'context' })
  }
  dispose = current?.dispose
}

window.addEventListener('hashchange', route)
window.addEventListener('beforeunload', e => { if (current?.isDirty()) e.preventDefault() })
// The aghangout link follows this installation's web origin; without an answer the page still opens.
void Promise.all([fetch('api/version').then(r => r.ok ? r.json() : null).then(v => setWebOrigin(v?.webOrigin), () => {}), loadSite()]).finally(route)
