// Where this area places workspaces (agedev_selfassembly p4, docs/placement.md).
//
// One contract for every entry that creates or obtains a workspace (CLI and UI): the
// project root from <area>/placement.json, else the area itself (an area set up before
// placement existed). A configured root must be really there: it carries a marker file,
// so an unmounted volume, whose mount point is an empty folder, is refused instead of
// silently filled. Registry paths say where each workspace actually is; changing the
// root affects what is created or obtained afterwards, and moving existing workspaces is
// `wfe workspace relocate` (server/relocate.ts).
import { mkdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { atomicWrite, inside } from './files.ts'
import { RequestError } from './workspace.ts'

export const PLACEMENT_FILE = 'placement.json'
export const ROOT_MARKER = '.agdev-projects.json'

export interface Placement {
  projectRoot: string
  configured: boolean // false: no placement.json, workspaces go into the area
  file: string
}

export async function loadPlacement(area: string): Promise<Placement> {
  const file = join(area, PLACEMENT_FILE)
  let text: string
  try { text = await readFile(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { projectRoot: area, configured: false, file }
    throw new RequestError(500, `${file} cannot be read: ${(e as Error).message}`)
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) { throw new RequestError(500, `${file} is not valid JSON (${(e as Error).message}); nothing was created`) }
  const root = (raw as { projectRoot?: unknown } | null)?.projectRoot
  if (typeof root !== 'string' || !isAbsolute(root)) throw new RequestError(500, `${file}: "projectRoot" must be an absolute path; nothing was created`)
  return { projectRoot: root, configured: true, file }
}

// Why the root cannot be used now, or null when it can.
export async function rootProblem(p: Placement): Promise<string | null> {
  const dir = await stat(p.projectRoot).catch(() => null)
  if (!dir?.isDirectory()) return `the project root ${p.projectRoot} does not exist (an unmounted volume?)`
  if (!p.configured) return null
  const marker = await stat(join(p.projectRoot, ROOT_MARKER)).catch(() => null)
  if (!marker?.isFile()) return `the project root ${p.projectRoot} has no ${ROOT_MARKER}: it is not the prepared root (an unmounted volume shows its empty mount point)`
  return null
}

// The project root, refusing one that is not available.
export async function projectRoot(area: string, what = 'Creating a workspace'): Promise<string> {
  const p = await loadPlacement(area)
  if (!p.configured) await mkdir(area, { recursive: true }) // the area itself, as before placement existed
  const problem = await rootProblem(p)
  if (problem) throw new RequestError(503, `${what} needs the project root: ${problem}. Nothing was created; mount it or change ${p.file}.`)
  return p.projectRoot
}

// A folder for a new workspace under the project root.
export async function workspaceDir(area: string, folder: string, what?: string): Promise<string> {
  return inside(await projectRoot(area, what), folder)
}

// Prepares `root` as a project root and names it in placement.json. The folder must exist:
// creating a missing mount point would hide that the volume is absent.
export async function setPlacement(area: string, root: string, by: { instance?: string } = {}): Promise<Placement> {
  if (!isAbsolute(root)) throw new RequestError(400, `the project root must be an absolute path, got ${root}`)
  const dir = await stat(root).catch(() => null)
  if (!dir?.isDirectory()) throw new RequestError(409, `${root} does not exist; create (or mount) it first`)
  const marker = join(root, ROOT_MARKER)
  if (!(await stat(marker).catch(() => null))) await atomicWrite(marker, `${JSON.stringify({ schema: 'agdev.project-root.v1', area, ...(by.instance ? { instance: by.instance } : {}), prepared: new Date().toISOString() }, null, 1)}\n`)
  const file = join(area, PLACEMENT_FILE)
  await atomicWrite(file, `${JSON.stringify({ projectRoot: root }, null, 1)}\n`)
  return { projectRoot: root, configured: true, file }
}
