// Provisioning a workspace (better_git_strategy p1, docs/storage.md): the one
// operation behind every entry that makes a workspace on this host — project
// creation, obtaining a registered project from Gitea (CLI, UI, installation
// bootstrap). It
//
//   1. allocates the envelope (an absent or empty folder, or one this
//      provisioning left unfinished: .agdev/workspace.json says so),
//   2. has the caller put the checkout in source/ (clone or create),
//   3. initializes the submodules the checkout records,
//   4. applies the project's declared layout (project.yaml `workspace:`),
//   5. marks the envelope ready and registers it.
//
// Every step looks at what is there, so running the same request again after
// an interruption continues it. Nothing that exists is overwritten: a folder
// that is neither absent, empty nor an unfinished provisioning is refused.
import { copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgdevStep } from '../shared/api.ts'
import { workspaceRelPath, type WorkspaceLayout } from '../shared/model.ts'
import { inside } from './files.ts'
import { git } from './git.ts'
import { layoutOf, LAYOUT_SCHEMA, readMarker, sourceRootOf, SOURCE_DIR, STATE_DIR, writeMarker } from './layout.ts'
import { registerWorkspace, type RegisterResult } from './registry.ts'
import { RequestError, Workspace } from './workspace.ts'

const exists = (p: string) => stat(p).then(() => true, () => false)

// Step 1: the envelope is ours to fill. `resumed` when an earlier provisioning
// left it unfinished.
export async function beginEnvelope(envelope: string, project: string | undefined): Promise<{ resumed: boolean }> {
  const l = await layoutOf(envelope)
  if (l.kind === 'missing' || l.kind === 'empty') {
    await mkdir(envelope, { recursive: true })
    await writeMarker(envelope, { schema: LAYOUT_SCHEMA, state: 'provisioning', ...(project ? { project } : {}), created: new Date().toISOString() })
    return { resumed: false }
  }
  if (l.kind === 'provisioning') {
    if (project && l.marker?.project && l.marker.project !== project) throw new RequestError(409, `${envelope} holds the unfinished provisioning of "${l.marker.project}", not "${project}"; nothing was changed`)
    return { resumed: true }
  }
  throw new RequestError(409, `${envelope} already exists (${l.kind === 'envelope' ? 'a workspace' : l.kind === 'legacy' ? 'an old-layout checkout' : 'a folder with content'}); nothing was changed. Choose another folder${l.kind === 'envelope' ? ', or register it' : ''}.`)
}

// Step 2 helper: a checkout an interrupted clone left without a usable HEAD is
// moved aside (kept, never deleted) so the clone can run again.
export async function clearPartialSource(envelope: string): Promise<string | null> {
  const src = sourceRootOf(envelope)
  if (!(await exists(src))) return null
  if ((await git(src, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0 && (await git(src, ['rev-parse', '--show-toplevel'])).stdout.trim()) return null
  if (!(await readdir(src)).length) return null
  const aside = join(envelope, STATE_DIR, `source.partial-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await rename(src, aside)
  return aside
}

// Step 4: what project.yaml `workspace:` declares — folders, and files made
// from a template of the checkout when they are absent (an edited one stays).
export async function applyLayout(ws: Workspace, layout: WorkspaceLayout | undefined): Promise<AgdevStep[]> {
  const steps: AgdevStep[] = []
  if (!layout) return steps
  for (const d of layout.directories) {
    const p = workspaceRelPath(d)
    if (typeof p !== 'string') { steps.push({ name: `directory ${d}`, status: 'failed', detail: p.problem }); continue }
    const abs = join(ws.envelope, p)
    if (await exists(abs)) { steps.push({ name: `directory ${p}`, status: 'kept', detail: 'exists' }); continue }
    await mkdir(abs, { recursive: true })
    steps.push({ name: `directory ${p}`, status: 'done', detail: 'created' })
  }
  for (const f of layout.files) {
    const to = workspaceRelPath(f.to)
    if (typeof to !== 'string') { steps.push({ name: `file ${f.to}`, status: 'failed', detail: to.problem }); continue }
    const dest = join(ws.envelope, to)
    if (await exists(dest)) { steps.push({ name: `file ${to}`, status: 'kept', detail: 'exists; not replaced' }); continue }
    let from: string
    try { from = await inside(ws.root, f.from) } catch (e) { steps.push({ name: `file ${to}`, status: 'failed', detail: (e as Error).message }); continue }
    if (!(await exists(from))) { steps.push({ name: `file ${to}`, status: 'failed', detail: `${f.from} is not in the checkout` }); continue }
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(from, dest)
    steps.push({ name: `file ${to}`, status: 'done', detail: `from ${SOURCE_DIR}/${f.from}` })
  }
  return steps
}

// Steps 3–5, after the checkout is in source/.
export async function finishEnvelope(o: { envelope: string; registryFile: string; area?: string; id?: string; label?: string; env?: Record<string, string> }): Promise<{ steps: AgdevStep[]; registered: RegisterResult }> {
  const steps: AgdevStep[] = []
  const src = sourceRootOf(o.envelope)
  if ((await git(src, ['rev-parse', '--show-toplevel'])).code !== 0) throw new RequestError(409, `${src} is not a Git checkout; provisioning of ${o.envelope} stays unfinished`)
  if (await exists(join(src, '.gitmodules'))) {
    const r = await git(src, ['submodule', 'update', '--init', '--recursive'], { env: o.env, timeoutMs: 600_000 })
    steps.push({ name: 'submodules', status: r.code === 0 ? 'done' : 'failed', detail: r.code === 0 ? 'initialized' : r.stderr.trim().slice(0, 400) })
  }
  const ws = new Workspace({ id: o.id ?? '', label: '', host: '', path: o.envelope })
  const read = await ws.readProject()
  steps.push(...await applyLayout(ws, read.project?.workspace))
  const m = await readMarker(o.envelope)
  await writeMarker(o.envelope, { schema: LAYOUT_SCHEMA, state: 'ready', ...(read.project?.id ? { project: read.project.id } : m?.project ? { project: m.project } : {}), created: m?.created ?? new Date().toISOString(), ready: new Date().toISOString() })
  steps.push({ name: 'layout', status: 'done', detail: `${STATE_DIR}/workspace.json ready` })
  const registered = await registerWorkspace(o.registryFile, o.envelope, { id: o.id, label: o.label, area: o.area })
  steps.push({ name: 'registration', status: registered.ok ? (registered.status === 'registered' ? 'done' : 'kept') : 'failed', detail: registered.message })
  return { steps, registered }
}
