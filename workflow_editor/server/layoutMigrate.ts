// Converting old-layout workspaces into envelopes (better_git_strategy p1,
// docs/storage.md "Converting a workspace"):
//
//   <ws>/  (the Git checkout, agdev state in .local/wfe/)
//     →  <ws>/source/                         the checkout, unchanged inside
//        <ws>/.agdev/runs/<wf>/<run>/source/  each run's tree/ renamed
//        <ws>/.agdev/retention/               retained-commit stores
//        <ws>/.agdev/character-dialogue/      the dialogue archive
//        <ws>/<file>                          top-level files of .local/ (project-local resources)
//
// The registered path stays the same. Everything happens by rename inside the
// same folder, so nothing is copied and nothing is deleted: tracked, untracked,
// staged and unstaged files, refs, submodule gitdirs and run records travel as
// they are. Project-owned folders of .local/ stay in source/.local/ (still
// ignored by the project's .gitignore) because they are referenced relative to
// the checkout; moving them is the project's decision.
//
// A journal per workspace (<area>/.local/migrations/layout/<id>.json) records
// each phase; running the same command again continues an interrupted
// conversion. Writers must be quiet: open attempts and queued jobs refuse,
// and the services should be stopped (docs/storage.md gives the sequence).
// Repairs after the move: linked worktrees (`git worktree repair`), absolute
// submodule worktree settings, the harness's session folders (renamed, with a
// link left at the old name) and presentation configs that name old paths.
// Historical records and reports are not rewritten. Undoing is by hand, in
// reverse phase order, from the journal; it is never automatic.
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git } from './git.ts'
import { layoutOf, LAYOUT_SCHEMA, readMarker, RUNS_DIR, SOURCE_DIR, sourceRootOf, STATE_DIR, writeMarker } from './layout.ts'
import { loadRegistry, type Registration } from './registry.ts'
import { openWork } from './workspaceRelocate.ts'
import { RequestError } from './workspace.ts'

export const MIGRATION_SCHEMA = 'agdev.layout-migration.v1'
export type MigrationPhase = 'planned' | 'moved' | 'state' | 'runs' | 'local' | 'repaired' | 'verified'
const PHASES: MigrationPhase[] = ['planned', 'moved', 'state', 'runs', 'local', 'repaired', 'verified']
// agdev-owned names in an old .local/ (beside wfe/).
const AGDEV_LOCAL = new Set(['wfe', 'character-dialogue', 'wfe-create.json', 'wfe-create-devdocs'])

export interface MigrationPlan {
  id: string
  path: string
  layout: string
  runs: string[] // <wf>/<run> with a tree/
  retention: boolean
  dialogue: boolean
  localMoves: string[] // top-level files of .local/ that move to the workspace root
  localKept: string[] // project-owned folders that stay in source/.local/
  worktrees: string[] // linked worktrees (project and runs), repaired after the move
  dirty: number // uncommitted entries of the project checkout, kept as they are
  sessions: number // harness session folders that follow
  presentations: number // presentation configs naming old paths
  problems: string[]
}
export interface MigrationJournal {
  schema: string
  id: string
  path: string
  started: string
  finished?: string
  phase: MigrationPhase
  snapshot?: string // the checkout's refs, status and submodules before (sha256)
  plan: MigrationPlan
  log: { at: string; what: string }[]
}
export interface MigrateContext { registryFile: string; area: string; sessions?: string }

const exists = (p: string) => lstat(p).then(() => true, () => false)
const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false
const now = () => new Date().toISOString()
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')
const journalFile = (area: string, id: string) => join(area, '.local', 'migrations', 'layout', `${id}.json`)
const sessionsRoot = (ctx: MigrateContext) => ctx.sessions ?? join(homedir(), '.claude', 'projects')
const presentRoot = (area: string) => join(area, '.local', 'present', 'instances')

async function snapshot(dir: string): Promise<string> {
  const env = { GIT_OPTIONAL_LOCKS: '0' }
  const parts = await Promise.all([
    git(dir, ['for-each-ref', '--format=%(refname) %(objectname)'], { env }),
    git(dir, ['status', '--porcelain=v1', '--ignore-submodules=none', '--untracked-files=all'], { env, timeoutMs: 300_000 }),
    git(dir, ['submodule', 'status', '--recursive'], { env, timeoutMs: 300_000 }),
  ])
  return createHash('sha256').update(parts.map(p => p.stdout).join('\n--\n')).digest('hex')
}

async function worktreesOf(dir: string): Promise<string[]> {
  const r = await git(dir, ['worktree', 'list', '--porcelain'], { env: { GIT_OPTIONAL_LOCKS: '0' } })
  return r.code === 0 ? r.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9)).slice(1) : []
}

// The run folders of an old or new layout, and where their checkouts are.
async function runFolders(base: string): Promise<string[]> {
  const out: string[] = []
  for (const wf of (await readdir(base, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    for (const run of (await readdir(join(base, wf), { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory()).map(d => d.name).sort()) out.push(`${wf}/${run}`)
  }
  return out
}

// What a conversion of one workspace would do; nothing changes.
export async function migrationPlan(ctx: MigrateContext, w: Registration, busy: Record<string, string[]> = {}): Promise<MigrationPlan> {
  const P = w.path
  const l = await layoutOf(P)
  const j = JSON.parse(await readTextOrNull(journalFile(ctx.area, w.id)) ?? 'null') as MigrationJournal | null
  const plan: MigrationPlan = { id: w.id, path: P, layout: l.kind, runs: [], retention: false, dialogue: false, localMoves: [], localKept: [], worktrees: [], dirty: 0, sessions: 0, presentations: 0, problems: [] }
  if (l.kind === 'envelope' && !j) return plan
  if (l.kind !== 'legacy' && !(j && !j.finished)) { plan.problems.push(`not an old-layout checkout (${l.kind}${l.problem ? `: ${l.problem}` : ''})`); return plan }
  if (busy[w.id]) plan.problems.push(`open work: ${busy[w.id].join(', ')}; let it end first`)
  const src = l.kind === 'legacy' ? P : sourceRootOf(P)
  const local = join(src, '.local')
  const runsBase = (await isDir(join(local, 'wfe', 'runs'))) ? join(local, 'wfe', 'runs') : join(P, STATE_DIR, RUNS_DIR)
  for (const r of await runFolders(runsBase)) if (await exists(join(runsBase, r, 'tree'))) plan.runs.push(r)
  plan.retention = await isDir(join(local, 'wfe', 'retention'))
  plan.dialogue = await isDir(join(local, 'character-dialogue'))
  for (const d of await readdir(local, { withFileTypes: true }).catch(() => [])) {
    if (AGDEV_LOCAL.has(d.name) || d.name === '.DS_Store') continue
    if (d.isFile()) {
      if (['source', '.agdev', 'published', '.git'].includes(d.name)) { plan.problems.push(`.local/${d.name} cannot move to the workspace root (a reserved name)`); continue }
      if (l.kind === 'legacy' && await exists(join(src, d.name))) { plan.localKept.push(`${d.name} (a file of the checkout has the same name; kept in source/.local/)`); continue }
      plan.localMoves.push(d.name)
    } else plan.localKept.push(`${d.name}/`)
  }
  if (await exists(`${P}.layout-migrating`) && l.kind === 'legacy') plan.problems.push(`${P}.layout-migrating exists; inspect it by hand`)
  plan.worktrees.push(...await worktreesOf(src))
  for (const r of plan.runs) plan.worktrees.push(...await worktreesOf(join(runsBase, r, 'tree')))
  const st = await git(src, ['status', '--porcelain=v1', '--ignore-submodules=none'], { env: { GIT_OPTIONAL_LOCKS: '0' } })
  plan.dirty = st.stdout.split('\n').filter(Boolean).length
  const head = slug(P)
  plan.sessions = (await readdir(sessionsRoot(ctx)).catch(() => [])).filter(d => d === head || d.startsWith(`${head}-`)).length
  for (const d of await readdir(presentRoot(ctx.area)).catch(() => [])) if ((await readTextOrNull(join(presentRoot(ctx.area), d, 'config.json')).catch(() => null))?.includes(`${P}/`)) plan.presentations++
  return plan
}

export async function migrationPreview(ctx: MigrateContext, ids: string[] | undefined): Promise<{ plans: MigrationPlan[]; ok: boolean }> {
  const reg = await loadRegistry(ctx.registryFile)
  const chosen = ids ? ids.map(id => { const w = reg.workspaces.find(x => x.id === id); if (!w) throw new RequestError(404, `workspace "${id}" is not registered`); return w }) : reg.workspaces
  const busy = await openWork(ctx.area, chosen.map(w => w.id))
  const plans = await Promise.all(chosen.map(w => migrationPlan(ctx, w, busy)))
  return { plans, ok: plans.every(p => !p.problems.length) }
}

// Converts one workspace, or continues its conversion.
export async function migrateWorkspace(ctx: MigrateContext, id: string, o: { by?: string } = {}): Promise<MigrationJournal> {
  const reg = await loadRegistry(ctx.registryFile)
  const w = reg.workspaces.find(x => x.id === id)
  if (!w) throw new RequestError(404, `workspace "${id}" is not registered`)
  const file = journalFile(ctx.area, id)
  let j = JSON.parse(await readTextOrNull(file) ?? 'null') as MigrationJournal | null
  if (j?.finished) return j
  const busy = await openWork(ctx.area, [id])
  if (!j) {
    const plan = await migrationPlan(ctx, w, busy)
    if (plan.layout === 'envelope') throw new RequestError(409, `${id} is already a workspace envelope; nothing to convert`)
    if (plan.problems.length) throw new RequestError(409, `${id} cannot be converted: ${plan.problems.join('; ')}`, plan)
    j = { schema: MIGRATION_SCHEMA, id, path: w.path, started: now(), phase: 'planned', plan, log: [{ at: now(), what: `planned by ${o.by ?? 'unknown'}` }] }
    await mkdir(join(ctx.area, '.local', 'migrations', 'layout'), { recursive: true })
    await atomicWrite(file, `${JSON.stringify(j, null, 1)}\n`)
  } else if (busy[id]) throw new RequestError(409, `${id} has open work: ${busy[id].join(', ')}; let it end, then continue`)
  const J = j
  const save = async (phase: MigrationPhase, what: string) => { J.phase = phase; J.log.push({ at: now(), what }); await atomicWrite(file, `${JSON.stringify(J, null, 1)}\n`) }
  const at = (p: MigrationPhase) => PHASES.indexOf(J.phase) >= PHASES.indexOf(p)
  const P = J.path, S = sourceRootOf(P), A = join(P, STATE_DIR), tmp = `${P}.layout-migrating`

  // 1. the checkout moves into source/
  if (!at('moved')) {
    if (!J.snapshot && await exists(join(P, '.git'))) { J.snapshot = await snapshot(P); await save('planned', `snapshot ${J.snapshot.slice(0, 16)}`) }
    if (await exists(join(P, '.git'))) { await rename(P, tmp); await mkdir(P); await rename(tmp, S) }
    else if (await exists(tmp) && !(await exists(S))) { await mkdir(P, { recursive: true }); await rename(tmp, S) }
    if (!(await exists(join(S, '.git')))) throw new RequestError(500, `${id}: ${S} has no checkout after the move; see ${file}`)
    await writeMarker(P, { schema: LAYOUT_SCHEMA, state: 'provisioning', project: w.project, created: J.started })
    await save('moved', `checkout moved to ${S}`)
  }
  // 2. agdev's state leaves the checkout
  if (!at('state')) {
    await mkdir(A, { recursive: true })
    const moves: [string, string][] = [[join(S, '.local', 'wfe', 'runs'), join(A, RUNS_DIR)], [join(S, '.local', 'wfe', 'retention'), join(A, 'retention')], [join(S, '.local', 'character-dialogue'), join(A, 'character-dialogue')]]
    for (const [a, b] of moves) if (await exists(a) && !(await exists(b))) await rename(a, b)
    await rmdir(join(S, '.local', 'wfe')).catch(() => {})
    await save('state', 'runs, retention and dialogue moved to .agdev/')
  }
  // 3. each run's tree/ becomes source/
  if (!at('runs')) {
    let n = 0
    for (const r of await runFolders(join(A, RUNS_DIR))) {
      const d = join(A, RUNS_DIR, r)
      if (await exists(join(d, 'tree')) && !(await exists(join(d, SOURCE_DIR)))) { await rename(join(d, 'tree'), join(d, SOURCE_DIR)); n++ }
      if (await exists(join(d, 'tree.removing')) && !(await exists(join(d, 'source.removing')))) await rename(join(d, 'tree.removing'), join(d, 'source.removing'))
    }
    await save('runs', `${n} run checkouts renamed tree/ → source/`)
  }
  // 4. project-local files go to the workspace root
  if (!at('local')) {
    const moved: string[] = []
    for (const f of J.plan.localMoves) if (await exists(join(S, '.local', f)) && !(await exists(join(P, f)))) { await rename(join(S, '.local', f), join(P, f)); moved.push(f) }
    await rmdir(join(S, '.local')).catch(() => {}) // only when nothing project-owned stays
    await save('local', moved.length ? `moved to the workspace root: ${moved.join(', ')}` : 'no project-local files to move')
  }
  // 5. repairs of what named the old places
  if (!at('repaired')) {
    const notes: string[] = []
    const oldRun = (r: string) => join(P, '.local', 'wfe', 'runs', r, 'tree')
    const newRun = (r: string) => join(A, RUNS_DIR, r, SOURCE_DIR)
    const repos = [S, ...J.plan.runs.map(newRun)]
    for (const dir of repos) {
      if ((await worktreesOf(dir)).length) { const r = await git(dir, ['worktree', 'repair']); notes.push(`worktree repair in ${dir}: ${r.code === 0 ? 'ok' : r.stderr.trim()}`) }
    }
    // absolute submodule worktree settings (rare; relative ones move as they are)
    const pairs: [string, string][] = [...J.plan.runs.map(r => [oldRun(r), newRun(r)] as [string, string]), [P, S]]
    for (const dir of repos) {
      const modules = join(dir, '.git', 'modules')
      for (const cfg of await configsUnder(modules)) {
        let text = await readFile(cfg, 'utf8'), changed = false
        for (const [a, b] of pairs) if (text.includes(`worktree = ${a}/`)) { text = text.replaceAll(`worktree = ${a}/`, `worktree = ${b}/`); changed = true }
        if (changed) { await writeFile(cfg, text); notes.push(`submodule worktree setting in ${cfg}`) }
      }
    }
    // the harness's session folders: by the cwd they were made in
    const root = sessionsRoot(ctx)
    const names = (await readdir(root).catch(() => [])).filter(d => d === slug(P) || d.startsWith(`${slug(P)}-`))
    let sessions = 0, kept = 0
    const follow = async (d: string, to: string) => {
      if ((await lstat(join(root, d))).isSymbolicLink()) return
      if (await exists(join(root, to))) { kept++; return }
      await rename(join(root, d), join(root, to)); await symlink(to, join(root, d)); sessions++
    }
    const done = new Set<string>()
    for (const r of J.plan.runs) {
      const a = slug(oldRun(r)), b = slug(newRun(r))
      for (const d of names) if (!done.has(d) && (d === a || d.startsWith(`${a}-`))) { done.add(d); await follow(d, b + d.slice(a.length)) }
    }
    const other = reg.workspaces.filter(x => x.id !== id).map(x => slug(x.path)).filter(s => s.startsWith(slug(P)) && s !== slug(P))
    for (const d of names) {
      if (done.has(d) || d.startsWith(`${slug(P)}--local-`) || other.some(s => d === s || d.startsWith(`${s}-`))) continue
      await follow(d, slug(S) + d.slice(slug(P).length))
    }
    notes.push(`${sessions} session folders follow (old names link to them)${kept ? `, ${kept} kept where a folder of the new name exists` : ''}`)
    // presentation configs naming old paths
    let presented = 0
    for (const d of await readdir(presentRoot(ctx.area)).catch(() => [])) {
      const f = join(presentRoot(ctx.area), d, 'config.json')
      const text = await readTextOrNull(f).catch(() => null)
      if (!text?.includes(`${P}/`)) continue
      const esc = P.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const next = text.replace(new RegExp(`${esc}/\\.local/wfe/runs/([^/"]+)/([^/"]+)/tree`, 'g'), `${A}/${RUNS_DIR}/$1/$2/${SOURCE_DIR}`)
        .replace(new RegExp(`${esc}/(?!\\.agdev/|${SOURCE_DIR}/)`, 'g'), `${S}/`)
      if (next !== text) { await writeFile(`${f}.before-layout`, text, { flag: 'wx' }).catch(() => {}); await writeFile(f, next); presented++ }
    }
    if (presented) notes.push(`${presented} presentation configs repointed (previous kept as config.json.before-layout)`)
    await save('repaired', notes.join('; ') || 'nothing to repair')
  }
  // 6. the checkout reads as it did; the envelope is ready
  if (!at('verified')) {
    if (J.snapshot) {
      const after = await snapshot(S)
      if (after !== J.snapshot) throw new RequestError(409, `${id}: the checkout's refs or status read differently after the move (${J.snapshot.slice(0, 12)} → ${after.slice(0, 12)}); nothing was undone. Inspect ${S} (journal ${file})`)
    }
    const m = await readMarker(P)
    await writeMarker(P, { schema: LAYOUT_SCHEMA, state: 'ready', project: w.project, created: m?.created ?? J.started, ready: now(), migrated: now() })
    const l = await layoutOf(P)
    if (l.kind !== 'envelope' || l.problem) throw new RequestError(500, `${id}: the envelope is not usable after conversion: ${l.problem ?? l.kind}`)
    J.finished = now()
    await save('verified', 'checkout verified; envelope ready')
  }
  return J
}

async function configsUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, depth: number) => {
    if (depth > 6) return
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === 'objects' || e.name === 'refs' || e.name === 'logs') continue
      if (e.isFile() && e.name === 'config') out.push(join(d, e.name))
      else if (e.isDirectory()) await walk(join(d, e.name), depth + 1)
    }
  }
  await walk(resolve(dir), 0)
  return out
}

export function migrationSummary(j: MigrationJournal): string[] {
  return [`${j.id}: ${j.finished ? 'converted' : `stopped after ${j.phase}`} (${j.path})`, ...j.log.slice(1).map(l => `  ${l.at}  ${l.what}`)]
}

// Conversion when the service starts (better_git_strategy p1): an installation
// updated by its parent (`wfe manage update`) runs the new release on workspaces
// of the old layout, and nobody stands at its host to run `wfe workspace migrate`.
// The lifecycle has drained and stopped the executor before the service starts,
// and main.ts calls this before it listens, so no claim can reach a workspace while
// it moves. A workspace with open work, or whose conversion fails, is left as it is
// (unavailable, its journal saying why) and the rest are served; the next start or
// `wfe workspace migrate` continues it. WFE_NO_LAYOUT_CONVERT=1 turns it off.
export async function convertAtStart(ctx: MigrateContext, log: (line: string) => void): Promise<void> {
  if (process.env.WFE_NO_LAYOUT_CONVERT) return
  let pv: { plans: MigrationPlan[] }
  try { pv = await migrationPreview(ctx, undefined) } catch (e) { log(`layout conversion: cannot read the registry: ${(e as Error).message}`); return }
  for (const p of pv.plans) {
    if (p.layout === 'envelope' && !p.problems.length) continue
    if (p.layout !== 'legacy' && !(await readTextOrNull(journalFile(ctx.area, p.id)))) continue
    try {
      const j = await migrateWorkspace(ctx, p.id, { by: 'wfe service start' })
      log(migrationSummary(j).join('\n'))
    } catch (e) { log(`layout conversion of ${p.id} did not run: ${(e as Error).message}`) }
  }
}
