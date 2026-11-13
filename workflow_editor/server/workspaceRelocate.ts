// Relocating whole workspaces (agedev_selfassembly p4; not runs' folders, which is server/relocate.ts, docs/placement.md): a verified copy into
// another folder (often the project root on another volume), then an ownership switch in
// the registry and the area's live references. The source is never changed or removed: it
// stays as the retained copy. Each step is recorded in a durable journal, so an
// interrupted relocation continues where it stopped without losing either copy.
//
// Runs live inside their workspace (<workspace>/.agdev/runs/), and nothing names a run copy
// by absolute path, so they move with it. History (messages, reports, run records) is
// never rewritten.
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, opendir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git } from './git.ts'
import { layoutOf, sourceRootOf } from './layout.ts'
import { loadPlacement, rootProblem } from './placement.ts'
import { loadRegistry, updateRegistry, type Registration } from './registry.ts'
import { RequestError } from './workspace.ts'

const run = promisify(execFile)
export const RELOCATION_SCHEMA = 'agdev.relocation.v1'

export type Phase = 'planned' | 'copied' | 'verified' | 'switched'
export interface TreeCount { files: number; dirs: number; links: number; bytes: number; other: number }
export interface RelocationItem {
  id: string
  from: string
  to: string
  phase: Phase
  sameDevice: boolean
  method?: string // how it was copied
  count?: TreeCount
  mismatches?: string[]
  worktrees: string[] // linked worktrees of the source: they keep pointing at the retained copy
  alternates: string[]
  gitdirLinks?: string[] // absolute gitdir/worktree settings inside the copy, rewritten to the new place
  references?: Record<string, number>
}
export interface Relocation {
  schema: typeof RELOCATION_SCHEMA
  id: string
  to: string
  started: string
  finished?: string
  by: string
  verify: 'metadata' | 'content'
  items: RelocationItem[]
  log: { at: string; workspace?: string; what: string }[]
}
export interface RelocateContext { registryFile: string; area: string }
export interface RelocateOptions {
  workspaces?: string[] // ids; none: every registered workspace not already under `to`
  to?: string // destination folder; default the project root
  verify?: 'metadata' | 'content'
  by?: string
  sessions?: string // the model harness's session folders (default ~/.claude/projects)
  failAfter?: { workspace: string; phase: Phase } // tests: stop as an interruption would
}

const journalDir = (area: string) => join(area, '.local', 'migrations', 'relocations')
const exists = (p: string) => stat(p).then(() => true, () => false)
const now = () => new Date().toISOString()
const realish = async (p: string) => realpath(p).catch(() => resolve(p))
const under = (child: string, parent: string) => child === parent || child.startsWith(parent + sep)

export class Interrupted extends Error {}

// ---- preview ------------------------------------------------------------------------

export async function openWork(area: string, ids: string[]): Promise<Record<string, string[]>> {
  const file = join(area, '.local', 'exec', 'exec.sqlite')
  const out: Record<string, string[]> = {}
  if (!(await exists(file))) return out
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    for (const id of ids) {
      const a = db.prepare("SELECT id FROM attempts WHERE workspace = ? AND state != 'ended'").all(id) as { id: string }[]
      const j = db.prepare("SELECT id FROM jobs WHERE workspace = ? AND state NOT IN ('done', 'dropped')").all(id) as { id: number }[]
      const busy = [...a.map(r => `attempt ${r.id}`), ...j.map(r => `job ${r.id}`)]
      if (busy.length) out[id] = busy
    }
  } finally { db.close() }
  return out
}

async function gitFacts(dir: string): Promise<{ worktrees: string[]; alternates: string[] }> {
  const wt = await git(dir, ['worktree', 'list', '--porcelain'], { env: { GIT_OPTIONAL_LOCKS: '0' } })
  const trees = wt.code === 0 ? wt.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9)).slice(1) : []
  const alternates: string[] = []
  for (const f of [join(dir, '.git', 'objects', 'info', 'alternates')]) {
    const text = await readTextOrNull(f).catch(() => null)
    if (text) alternates.push(...text.split('\n').filter(Boolean))
  }
  return { worktrees: trees, alternates }
}

export interface Preview { to: string; items: (RelocationItem & { problems: string[] })[]; ok: boolean; journal?: string }

export async function relocationPreview(ctx: RelocateContext, o: RelocateOptions = {}): Promise<Preview> {
  const placement = await loadPlacement(ctx.area)
  const to = resolve(o.to ?? placement.projectRoot)
  const targetDir = await stat(to).catch(() => null)
  const problems: string[] = []
  if (!targetDir?.isDirectory()) problems.push(`${to} does not exist (an unmounted volume?); it is never created here`)
  else if (resolve(placement.projectRoot) === to) { const p = await rootProblem(placement); if (p) problems.push(p) }
  const reg = await loadRegistry(ctx.registryFile)
  const realTo = await realish(to)
  const chosen: Registration[] = o.workspaces?.length
    ? o.workspaces.map(id => { const w = reg.workspaces.find(x => x.id === id); if (!w) throw new RequestError(404, `no workspace ${id} is registered`); return w })
    : (await Promise.all(reg.workspaces.map(async w => (dirname(await realish(w.path)) === realTo ? null : w)))).filter((w): w is Registration => !!w)
  const busy = await openWork(ctx.area, chosen.map(w => w.id))
  const destDev = targetDir ? targetDir.dev : -1
  const items: Preview['items'] = []
  for (const w of chosen) {
    const from = await realish(w.path)
    const dest = join(realTo, basename(from))
    const mine: string[] = [...problems]
    const src = await stat(from).catch(() => null)
    if (!src?.isDirectory()) mine.push(`${from} is not there`)
    if (under(realTo, from)) mine.push(`the destination is inside ${from}`)
    if (dest === from) mine.push('already there')
    else if (await exists(dest)) mine.push(`${dest} exists; nothing is overwritten`)
    if (reg.workspaces.some(x => x.id !== w.id && resolve(x.path) === dest)) mine.push(`${dest} is registered for another workspace`)
    if (busy[w.id]) mine.push(`open work: ${busy[w.id].join(', ')}; let it end first`)
    if (src && (await layoutOf(from)).kind !== 'envelope') mine.push(`${from} is not a workspace envelope; convert it first with wfe workspace migrate`)
    const g = src ? await gitFacts(sourceRootOf(from)) : { worktrees: [], alternates: [] }
    items.push({ id: w.id, from, to: dest, phase: 'planned', sameDevice: !!src && src.dev === destDev, ...g, problems: mine })
  }
  return { to: realTo, items, ok: items.length > 0 && items.every(i => i.problems.length === 0) }
}

// ---- copy and verification ----------------------------------------------------------

async function copyTree(from: string, to: string, sameDevice: boolean): Promise<string> {
  // Preserves modes, times and links; on one volume, clones where the filesystem can (APFS
  // clonefile, reflink), which costs no space. Across volumes it is a real copy.
  if (process.platform === 'darwin') {
    await run('cp', [...(sameDevice ? ['-c'] : []), '-pPR', from, to], { maxBuffer: 64 << 20 })
    return sameDevice ? 'cp -c (clonefile)' : 'cp -pPR'
  }
  if (process.platform === 'linux') {
    await run('cp', ['-a', '--reflink=auto', from, to], { maxBuffer: 64 << 20 })
    return 'cp -a --reflink=auto'
  }
  await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false })
  return 'fs.cp'
}

async function* walk(root: string, rel = ''): AsyncGenerator<string> {
  const dir = await opendir(join(root, rel))
  const names: string[] = []
  for await (const e of dir) names.push(e.name)
  names.sort()
  for (const n of names) {
    const r = rel ? join(rel, n) : n
    yield r
    const s = await lstat(join(root, r))
    if (s.isDirectory()) yield* walk(root, r)
  }
}

async function fileHash(path: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const { createReadStream } = await import('node:fs')
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

// Compares the copy with its source: every entry's type, mode and link target, each file's
// size and modification time, and with `content` its bytes.
export async function compareTrees(from: string, to: string, verify: 'metadata' | 'content' = 'metadata'): Promise<{ count: TreeCount; mismatches: string[] }> {
  const count: TreeCount = { files: 0, dirs: 0, links: 0, bytes: 0, other: 0 }
  const mismatches: string[] = []
  const note = (m: string) => { if (mismatches.length < 50) mismatches.push(m) }
  const seen = new Set<string>()
  for await (const rel of walk(from)) {
    seen.add(rel)
    const a = await lstat(join(from, rel))
    const b = await lstat(join(to, rel)).catch(() => null)
    if (!b) { note(`missing: ${rel}`); continue }
    if ((a.mode & 0o170000) !== (b.mode & 0o170000)) { note(`type: ${rel}`); continue }
    if ((a.mode & 0o7777) !== (b.mode & 0o7777)) note(`mode: ${rel} ${(a.mode & 0o7777).toString(8)} → ${(b.mode & 0o7777).toString(8)}`)
    if (a.isSymbolicLink()) {
      count.links++
      if (await readlink(join(from, rel)) !== await readlink(join(to, rel))) note(`link target: ${rel}`)
    } else if (a.isDirectory()) count.dirs++
    else if (a.isFile()) {
      count.files++
      count.bytes += a.size
      if (a.size !== b.size) note(`size: ${rel}`)
      else if (Math.floor(a.mtimeMs / 1000) !== Math.floor(b.mtimeMs / 1000)) note(`time: ${rel}`)
      else if (verify === 'content' && await fileHash(join(from, rel)) !== await fileHash(join(to, rel))) note(`content: ${rel}`)
    } else count.other++
  }
  for await (const rel of walk(to)) if (!seen.has(rel)) note(`extra: ${rel}`)
  return { count, mismatches }
}

// Git facts that must read the same in both copies: every ref, and the working state of the
// root and its submodules. GIT_OPTIONAL_LOCKS=0 keeps `status` from rewriting the source's index.
async function gitState(dir: string): Promise<string> {
  const env = { GIT_OPTIONAL_LOCKS: '0' }
  const refs = await git(dir, ['for-each-ref', '--format=%(refname) %(objectname)'], { env })
  const status = await git(dir, ['status', '--porcelain=v1', '--ignore-submodules=none', '--untracked-files=all'], { env })
  const subs = await git(dir, ['submodule', 'status', '--recursive'], { env })
  return [refs.stdout, status.stdout, subs.stdout].join('\n--\n')
}

// Absolute gitdir/worktree settings inside the copy that point into the source (a submodule
// absorbed with absolute paths): rewritten so the copy does not lean on the retained one.
async function rewriteGitdirLinks(from: string, to: string): Promise<string[]> {
  const changed: string[] = []
  for await (const rel of walk(to)) {
    const name = basename(rel)
    const path = join(to, rel)
    if (name === '.git') {
      const s = await lstat(path)
      if (!s.isFile()) continue
      const text = await readFile(path, 'utf8')
      if (text.includes(`gitdir: ${from}/`)) { await writeFile(path, text.replaceAll(`gitdir: ${from}/`, `gitdir: ${to}/`)); changed.push(rel) }
    } else if (name === 'config' && rel.split(sep).includes('modules')) {
      const text = await readFile(path, 'utf8').catch(() => '')
      if (text.includes(`worktree = ${from}/`)) { await writeFile(path, text.replaceAll(`worktree = ${from}/`, `worktree = ${to}/`)); changed.push(rel) }
    }
  }
  return changed
}

// ---- live references of the area ------------------------------------------------------

const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

async function switchReferences(ctx: RelocateContext, item: RelocationItem, sessions: string): Promise<Record<string, number>> {
  const refs: Record<string, number> = {}
  // Presentation instances serve from the workspace.
  const root = join(ctx.area, '.local', 'present', 'instances')
  let present = 0
  for (const d of await opendirNames(root)) {
    const f = join(root, d, 'config.json')
    const t = await readTextOrNull(f).catch(() => null)
    if (t?.includes(`${item.from}/`)) { await writeFile(f, t.replaceAll(`${item.from}/`, `${item.to}/`)); present++ }
  }
  refs.presentations = present
  // The model harness keeps session folders by the working directory: copies under the new
  // directory's name let a run's next attempt continue its session from the new place.
  let copied = 0
  const head = slug(item.from)
  for (const d of await opendirNames(sessions)) {
    if (d !== head && !d.startsWith(`${head}-`)) continue
    const target = join(sessions, slug(item.to) + d.slice(head.length))
    if (!(await exists(target))) { await copyTree(join(sessions, d), target, true); copied++ }
  }
  refs.sessions = copied
  return refs
}

async function opendirNames(dir: string): Promise<string[]> {
  try { const out: string[] = []; for await (const e of await opendir(dir)) out.push(e.name); return out.sort() } catch { return [] }
}

// ---- the operation --------------------------------------------------------------------

async function save(area: string, j: Relocation) {
  await mkdir(journalDir(area), { recursive: true })
  await atomicWrite(join(journalDir(area), `${j.id}.json`), `${JSON.stringify(j, null, 1)}\n`)
}

export async function unfinishedRelocation(area: string): Promise<Relocation | null> {
  for (const name of (await opendirNames(journalDir(area))).filter(n => n.endsWith('.json')).reverse()) {
    const j = JSON.parse(await readFile(join(journalDir(area), name), 'utf8')) as Relocation
    if (!j.finished) return j
  }
  return null
}

export async function relocate(ctx: RelocateContext, o: RelocateOptions & { resume?: boolean } = {}): Promise<Relocation> {
  let j = await unfinishedRelocation(ctx.area)
  if (j && !o.resume) throw new RequestError(409, `relocation ${j.id} is unfinished: continue it with --resume (journal ${join(journalDir(ctx.area), j.id + '.json')})`)
  if (!j) {
    if (o.resume) throw new RequestError(409, 'there is no unfinished relocation to resume')
    const pv = await relocationPreview(ctx, o)
    if (!pv.items.length) throw new RequestError(409, `no workspace to relocate to ${pv.to}`)
    if (!pv.ok) throw new RequestError(409, `relocation refused; nothing was changed:\n${pv.items.filter(i => i.problems.length).map(i => `  ${i.id}: ${i.problems.join('; ')}`).join('\n')}`, pv)
    j = { schema: RELOCATION_SCHEMA, id: `relocate-${now().replace(/[-:.]/g, '').slice(0, 15)}-${process.pid}`, to: pv.to, started: now(), by: o.by ?? 'wfe', verify: o.verify ?? 'metadata',
      items: pv.items.map(({ problems: _, ...i }) => i), log: [] }
    await save(ctx.area, j)
  }
  const sessions = o.sessions ?? join(homedir(), '.claude', 'projects')
  const log = async (what: string, workspace?: string) => { j!.log.push({ at: now(), ...(workspace ? { workspace } : {}), what }); await save(ctx.area, j!) }
  const stopIf = (item: RelocationItem) => { if (o.failAfter?.workspace === item.id && o.failAfter.phase === item.phase) throw new Interrupted(`stopped after ${item.phase} of ${item.id} (test)`) }
  for (const item of j.items) {
    const partial = `${item.to}.relocating-${j.id}`
    if (item.phase === 'planned') {
      // A copy that did not finish is discarded and made again; the source is untouched.
      await rm(partial, { recursive: true, force: true })
      if (await exists(item.to)) throw new RequestError(409, `${item.to} appeared meanwhile; nothing of it is touched (journal ${j.id})`)
      const busy = await openWork(ctx.area, [item.id])
      if (busy[item.id]) throw new RequestError(409, `${item.id} has open work: ${busy[item.id].join(', ')}; let it end, then --resume`)
      item.method = await copyTree(item.from, partial, item.sameDevice)
      await rename(partial, item.to)
      item.phase = 'copied'
      await log(`copied by ${item.method}`, item.id)
      stopIf(item)
    }
    if (item.phase === 'copied') {
      const c = await compareTrees(item.from, item.to, j.verify)
      item.count = c.count
      item.mismatches = c.mismatches
      if (c.mismatches.length) { await log(`verification failed: ${c.mismatches.slice(0, 5).join('; ')}`, item.id); throw new RequestError(500, `the copy of ${item.id} at ${item.to} differs from ${item.from}: ${c.mismatches.slice(0, 10).join('; ')}. The registry still names the source; nothing else changed.`, item) }
      item.gitdirLinks = await rewriteGitdirLinks(item.from, item.to)
      const [a, b] = await Promise.all([gitState(sourceRootOf(item.from)), gitState(sourceRootOf(item.to))])
      if (a !== b) { await log('Git state differs between the copies', item.id); throw new RequestError(500, `Git reads ${item.id} differently at ${item.to} than at ${item.from}; the registry still names the source`) }
      item.phase = 'verified'
      await log(`verified: ${c.count.files} files, ${c.count.dirs} folders, ${c.count.links} links, ${c.count.bytes} bytes (${j.verify})`, item.id)
      stopIf(item)
    }
    if (item.phase === 'verified') {
      // Ownership switch: from here the registry, and so every service, uses the new copy.
      await updateRegistry(ctx.registryFile, raw => {
        const w = ((raw.workspaces ?? []) as Registration[]).find(x => x.id === item.id)
        if (!w) throw new RequestError(409, `workspace ${item.id} is no longer registered`)
        if (resolve(w.path) !== item.to) w.path = item.to
      })
      item.references = await switchReferences(ctx, item, sessions)
      item.phase = 'switched'
      await log(`switched; the source stays at ${item.from}`, item.id)
      stopIf(item)
    }
  }
  j.finished = now()
  await save(ctx.area, j)
  return j
}

export function relocationSummary(j: Relocation): string[] {
  return [
    `${j.id}: ${j.items.length} workspace${j.items.length === 1 ? '' : 's'} to ${j.to}${j.finished ? ', finished' : ', unfinished'}`,
    ...j.items.map(i => `  ${i.id.padEnd(16)} ${i.phase.padEnd(9)} ${i.from} → ${i.to}${i.count ? `  ${i.count.files} files, ${(i.count.bytes / 1e9).toFixed(2)} GB` : ''}${i.method ? ` (${i.method})` : ''}${i.worktrees.length ? `  worktrees stay with the source: ${i.worktrees.join(', ')}` : ''}`),
  ]
}
