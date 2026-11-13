// Preservation packages of teamwork outputs (cluster_teamwork p3,
// docs/teamwork-archive.md "Packages"): the bytes a collaboration delivered
// through a share, with their manifests and the archived records that name
// them, copied to a destination independent of the share.
//
// A manifest in Git is not a byte backup, and a second folder on the same
// export is not independent protection. A package is self-contained:
//
//   package.json      ag.teamwork-package.v1: the request, the archive records it was built from
//                     (repository, commit, path), each output's identity (ref, declared manifest
//                     digest, producer, files with sha256) and how it was verified when packaged
//   outputs/<id>/     the files, byte for byte, and the output's own .wfe-output.json
//   records/<instance>/  the archived manifest.json, transcript.jsonl and transcript.md of every
//                     archive the package was built from (requester's and receiver's)
//   SHA256SUMS        every file above (sha256sum -c)
//
// Built on a host that mounts the share, from published archives (any
// installation's), never from live records. The backup copy goes to the
// destination named by attachments.json "backup" on that host, under
// <dirname(backup.path)>/agdev-teamwork/<request>/, and is hash-verified there.
// A restore copies it back into an empty folder and verifies every hash;
// it restores readable history and bytes, never services or replayed work.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { OUTPUT_MANIFEST } from '../shared/shares.ts'
import { gitOk } from './git.ts'
import { loadFilesConfig, type BackupSetting } from './messageFiles.ts'
import { hashFile, notReachable, resolveRef, verifyManifest } from './shares.ts'
import type { TeamManifest } from './teamworkArchive.ts'

export const PACKAGE_FORMAT = 'ag.teamwork-package.v1'
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function run(argv: string[], timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
    p.stdout.on('data', d => { stdout += d }); p.stderr.on('data', d => { stderr += d })
    p.on('error', e => { clearTimeout(t); resolve({ code: 127, stdout, stderr: String(e) }) })
    p.on('close', code => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }) })
  })
}

export interface ArchiveSource { repository: string; instance: string; request: string }
export interface PackageOutput { id: string; ref: string; manifest: string; producer: unknown; title: string | null; files: { path: string; sha256: string; bytes: number }[]; verified: string }
export interface PackageFile { format: string; request: string; created: string; by: string; host: string; sources: { instance: string; repository: string; commit: string; path: string; records: number }[]; outputs: PackageOutput[]; note: string }

// Reads one published archive folder (a fresh clone, at its branch head).
async function readArchive(src: ArchiveSource, work: string): Promise<{ manifest: TeamManifest; commit: string; dir: string; path: string }> {
  const dir = join(work, `clone-${src.instance}`)
  await gitOk(work, ['clone', '-q', '--depth', '1', '--', src.repository, dir], { timeoutMs: 180_000 })
  const path = `instances/${src.instance}/teamwork/${src.request}`
  const text = await readFile(join(dir, path, 'manifest.json'), 'utf8').catch(() => null)
  if (!text) throw new Error(`${src.repository} has no ${path}/manifest.json: that installation has not archived ${src.request}`)
  const commit = (await gitOk(dir, ['log', '-1', '--format=%H', '--', path])).trim()
  return { manifest: JSON.parse(text) as TeamManifest, commit, dir, path }
}

// Builds a package into `out` (an empty or missing folder).
export async function buildPackage(sources: ArchiveSource[], out: string, by: string): Promise<PackageFile> {
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; build into a new folder`)
  if (!sources.length) throw new Error('name at least one archive (--archive <repository>=<instance>)')
  const request = sources[0].request
  await mkdir(out, { recursive: true })
  const work = join(out, '.work'); await mkdir(work)
  try {
    const read = [] as Awaited<ReturnType<typeof readArchive>>[]
    for (const s of sources) read.push(await readArchive(s, work))
    // Outputs: those a requester's archive names in the counterpart's result,
    // and those a receiver's runs published; the same id+ref once.
    const named = new Map<string, { id: string; ref: string; manifest: string; producer: unknown; title: string | null }>()
    for (const r of read) {
      const res = r.manifest.counterpart.result as { outputs?: { id: string; ref: string; manifest: string; producer?: unknown; title?: string }[] } | null
      for (const o of res?.outputs ?? []) named.set(o.ref, { id: o.id, ref: o.ref, manifest: o.manifest, producer: o.producer ?? { instance: r.manifest.peer }, title: o.title ?? null })
      for (const o of r.manifest.outputs as { id: string; ref: string; digest: string; run: string; title?: string }[]) if (!named.has(o.ref)) named.set(o.ref, { id: o.id, ref: o.ref, manifest: o.digest, producer: { instance: r.manifest.instance, run: o.run }, title: o.title ?? null })
    }
    if (!named.size) throw new Error(`the archives of ${request} name no shared output: nothing to package`)
    const outputs: PackageOutput[] = []
    for (const o of named.values()) {
      const r = await resolveRef(o.ref)
      if (notReachable(r.state)) throw new Error(`${o.ref}: ${r.detail} — build the package on a host where the share answers`)
      if (r.state !== 'ok' || !r.abs) throw new Error(`${o.ref}: ${r.detail}`)
      const text = await readFile(join(r.abs, OUTPUT_MANIFEST), 'utf8')
      const v = await verifyManifest(text)
      if (v.digest !== o.manifest) throw new Error(`${o.ref}: its manifest is ${v.digest}, the archived records name ${o.manifest}`)
      if (v.recomputed !== v.digest || v.status !== 'verified') throw new Error(`${o.ref}: ${v.status} — ${v.detail}`)
      const m = JSON.parse(text) as { files: { path: string; sha256: string; bytes: number }[] }
      const dest = join(out, 'outputs', o.id)
      for (const f of m.files) {
        await mkdir(dirname(join(dest, f.path)), { recursive: true })
        await copyFile(join(r.abs, f.path), join(dest, f.path))
        if (await hashFile(join(dest, f.path)) !== f.sha256) throw new Error(`${o.ref}${f.path}: the copy does not match its manifest`)
      }
      await writeFile(join(dest, OUTPUT_MANIFEST), text)
      outputs.push({ ...o, files: m.files, verified: `manifest ${v.digest} recomputed and every file hashed on the share, then the copies hashed again` })
    }
    const recs: PackageFile['sources'] = []
    for (const r of read) {
      const dest = join(out, 'records', r.manifest.instance)
      await mkdir(dest, { recursive: true })
      for (const f of ['manifest.json', 'transcript.jsonl', 'transcript.md']) await copyFile(join(r.dir, r.path, f), join(dest, f))
      recs.push({ instance: r.manifest.instance, repository: sources.find(s => s.instance === r.manifest.instance)!.repository.replace(/\/\/[^@/]+@/, '//'), commit: r.commit, path: r.path, records: r.manifest.horizon.records })
    }
    const pkg: PackageFile = { format: PACKAGE_FORMAT, request, created: new Date().toISOString(), by, host: (await run(['hostname'])).stdout.trim(), sources: recs, outputs, note: 'bytes and records only: restoring it restores readable history and the delivered files, never services, permissions or replayed work' }
    await writeFile(join(out, 'package.json'), JSON.stringify(pkg, null, 1) + '\n')
    await rm(work, { recursive: true, force: true })
    await writeSums(out)
    return pkg
  } finally { await rm(work, { recursive: true, force: true }) }
}

function filesUnder(root: string, dir = root): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...filesUnder(root, p))
    else if (e.isFile() && relative(root, p) !== 'SHA256SUMS') out.push(relative(root, p))
  }
  return out.sort()
}
async function writeSums(root: string) {
  const lines: string[] = []
  for (const f of filesUnder(root)) lines.push(`${sha(await readFile(join(root, f)))}  ${f}`)
  await writeFile(join(root, 'SHA256SUMS'), lines.join('\n') + '\n')
}
// Every file listed in SHA256SUMS hashes as listed, and nothing else is there.
export async function checkSums(root: string): Promise<{ files: number }> {
  const text = await readFile(join(root, 'SHA256SUMS'), 'utf8')
  const listed = text.trim().split('\n').map(l => { const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l); if (!m) throw new Error(`SHA256SUMS: bad line ${l}`); return { h: m[1], f: m[2] } })
  for (const { h, f } of listed) if (sha(await readFile(join(root, f))) !== h) throw new Error(`${f} does not match SHA256SUMS`)
  const extra = filesUnder(root).filter(f => !listed.some(x => x.f === f))
  if (extra.length) throw new Error(`not in SHA256SUMS: ${extra.slice(0, 5).join(', ')}`)
  return { files: listed.length }
}

function backupOf(area: string): BackupSetting {
  const c = loadFilesConfig(area)
  if ('disabled' in c) throw new Error(`no backup destination: ${c.disabled}`)
  if (!c.backup) throw new Error('attachments.json names no "backup" destination on this host')
  return c.backup
}
const destOf = (b: BackupSetting, request: string) => `${dirname(b.path)}/agdev-teamwork/${request}`

// Copies a built package to the backup destination (never over an existing
// copy) and verifies every hash there.
export async function backupPackage(area: string, dir: string): Promise<{ destination: string; files: number }> {
  const b = backupOf(area)
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageFile
  await checkSums(dir)
  const dst = destOf(b, pkg.request)
  const exists = await run([...b.ssh, b.host, `test -e ${q(dst)}/package.json && echo yes || echo no`])
  if (exists.code !== 0) throw new Error(`backup: ${b.host} does not answer: ${exists.stderr.trim()}`)
  if (exists.stdout.trim() === 'yes') throw new Error(`backup: ${b.host}:${dst} already holds a package; it is never replaced (restore it to compare)`)
  const mk = await run([...b.ssh, b.host, `mkdir -p ${q(dst)}`])
  if (mk.code !== 0) throw new Error(`backup: cannot create ${b.host}:${dst}: ${mk.stderr.trim()}`)
  const sync = await run(['rsync', '-a', '-e', b.ssh.join(' '), `${dir}/`, `${b.host}:${dst}/`])
  if (sync.code !== 0) throw new Error(`backup: rsync to ${b.host}:${dst} failed: ${sync.stderr.trim()}`)
  const sums = await run([...b.ssh, b.host, `cd ${q(dst)} && (sha256sum -c --quiet SHA256SUMS 2>&1 || shasum -a 256 -c --quiet SHA256SUMS)`])
  if (sums.code !== 0) throw new Error(`backup: verification at ${b.host}:${dst} failed: ${(sums.stdout + sums.stderr).trim()}`)
  const n = (await readFile(join(dir, 'SHA256SUMS'), 'utf8')).trim().split('\n').length
  return { destination: `${b.host}:${dst}`, files: n }
}

// Brings a package back from the backup into an empty folder and verifies it.
export async function restorePackage(area: string, request: string, into: string): Promise<{ package: PackageFile; files: number }> {
  const b = backupOf(area)
  if (existsSync(into) && readdirSync(into).length) throw new Error(`${into} is not empty; restore into a new folder`)
  mkdirSync(into, { recursive: true })
  const r = await run(['rsync', '-a', '-e', b.ssh.join(' '), `${b.host}:${destOf(b, request)}/`, `${into}/`])
  if (r.code !== 0) throw new Error(`restore: rsync from ${b.host}:${destOf(b, request)} failed: ${r.stderr.trim()}`)
  const { files } = await checkSums(into)
  const pkg = JSON.parse(await readFile(join(into, 'package.json'), 'utf8')) as PackageFile
  for (const o of pkg.outputs) for (const f of o.files) if (sha(await readFile(join(into, 'outputs', o.id, f.path))) !== f.sha256) throw new Error(`restore: outputs/${o.id}/${f.path} does not match its manifest`)
  return { package: pkg, files }
}
export const packageSize = (dir: string) => filesUnder(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0)
void readdir
