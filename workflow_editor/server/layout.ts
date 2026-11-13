// The workspace layout (better_git_strategy p1, docs/storage.md): a project
// workspace is an unversioned local folder, the envelope, that holds the
// project's Gitea checkout and its local resources:
//
//   <workspace>/                 the registered path (workspaceRoot)
//     source/                    the Git checkout (sourceRoot): project.yaml, devdocs, submodules
//     .agdev/                    agdev's state (stateRoot)
//       workspace.json           the layout marker: schema, provisioning state
//       runs/<wf>/<run>/         run envelopes (runspace.ts)
//       retention/               retained-commit stores (retention.ts)
//     <project-chosen entries>   local resources the project declares or keeps
//
// `source`, `.agdev` and `published` are reserved at a workspace root
// (`published/` is for a future external publication and is not created).
// Repository-relative paths never carry `source/`.
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, readTextOrNull } from './files.ts'
import { RUN_ENVELOPE_RESERVED } from '../shared/model.ts'

export const LAYOUT_SCHEMA = 'agdev.workspace.v1'
export const SOURCE_DIR = 'source'
export const STATE_DIR = '.agdev'
export const RESERVED = [SOURCE_DIR, STATE_DIR, 'published'] as const
export const LAYOUT_FILE = 'workspace.json'
export const RUNS_DIR = 'runs' // under the state root
export const RUN_SOURCE = SOURCE_DIR // a run envelope's checkout
// Names a run envelope holds for agdev; declared run files may not use them.
export const RUN_RESERVED = RUN_ENVELOPE_RESERVED

export const sourceRootOf = (workspace: string) => join(workspace, SOURCE_DIR)
export const stateRootOf = (workspace: string) => join(workspace, STATE_DIR)
export const runsRootOf = (workspace: string) => join(workspace, STATE_DIR, RUNS_DIR)

export interface LayoutMarker { schema: string; state: 'provisioning' | 'ready'; project?: string; created: string; ready?: string; migrated?: string }

export type LayoutKind = 'envelope' | 'provisioning' | 'legacy' | 'missing' | 'empty' | 'unknown'
export interface LayoutState { kind: LayoutKind; marker?: LayoutMarker; problem?: string }

const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false
const isAny = async (p: string) => !!(await stat(p).catch(() => null))

export async function readMarker(workspace: string): Promise<LayoutMarker | null> {
  const text = await readTextOrNull(join(stateRootOf(workspace), LAYOUT_FILE)).catch(() => null)
  if (text === null) return null
  try { const m = JSON.parse(text) as LayoutMarker; return m?.schema === LAYOUT_SCHEMA ? m : null } catch { return null }
}

export async function writeMarker(workspace: string, m: LayoutMarker) {
  await mkdir(stateRootOf(workspace), { recursive: true })
  await atomicWrite(join(stateRootOf(workspace), LAYOUT_FILE), `${JSON.stringify(m, null, 1)}\n`)
}

// What a folder is, as a workspace: an envelope (ready, or still being
// provisioned), a checkout in the old layout (the Git root is the folder
// itself), or neither. Reading never repairs.
export async function layoutOf(workspace: string): Promise<LayoutState> {
  if (!(await isDir(workspace))) return { kind: 'missing', problem: 'directory not found on this machine' }
  const marker = await readMarker(workspace)
  if (marker?.state === 'provisioning') return { kind: 'provisioning', marker, problem: `the workspace is still being provisioned (or its provisioning was interrupted; ${STATE_DIR}/${LAYOUT_FILE}); the same obtain or create continues it` }
  if (await isAny(join(workspace, '.git'))) return { kind: 'legacy', problem: `the old layout: ${workspace} is itself the Git checkout. Convert it with wfe workspace migrate (preview first)` }
  if (marker || await isAny(join(sourceRootOf(workspace), '.git'))) {
    if (!(await isAny(join(sourceRootOf(workspace), '.git')))) return { kind: 'envelope', marker: marker ?? undefined, problem: `${SOURCE_DIR}/ has no Git checkout` }
    return { kind: 'envelope', marker: marker ?? undefined }
  }
  if (!(await readdir(workspace)).length) return { kind: 'empty' }
  return { kind: 'unknown', problem: `${workspace} is neither a workspace (${SOURCE_DIR}/ with a Git checkout) nor an old-layout checkout` }
}
