// Bounded liveness of a share's mount (cluster_teamwork p3, docs/shares.md
// "Unavailable shares"). A hard NFS mount whose server stops answering blocks
// every filesystem call on it — in this process, a blocked fs call occupies a
// libuv pool thread, and four of them stall every file read the service makes.
// So the first touch of a share's root is done by a small child process
// (`cat` of the marker, or `test -d`), never by this process:
//
// - a probe that does not answer within the budget is killed and the share is
//   `unavailable` (not missing, not empty) for this reading;
// - concurrent readers of one share share one in-flight probe (single flight);
// - a probe that was killed but has not exited (an uninterruptible I/O wait
//   the kill cannot end) stays counted as outstanding until the OS reaps it.
//   While a share has MAX_OUTSTANDING_PER_SHARE such probes, or the process has
//   MAX_OUTSTANDING in all, no new probe starts: the answer is `unavailable`
//   at once. Nothing claims a hung read was cancelled just because nobody
//   waits for it any more;
// - after a timeout the share is `suspect`: a reader within SUSPECT_MS gets
//   `unavailable` without a new probe, so repeated views cannot pile probes up.
//
// A successful probe says the server answered just now; the reads that follow
// it in this process are short metadata reads, and the routine views that use
// them have an overall budget of their own (`withinBudget`).
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export const PROBE_MS = Math.max(200, Number(process.env.WFE_SHARE_PROBE_MS) || 3000)
export const SUSPECT_MS = 30_000
export const MAX_OUTSTANDING_PER_SHARE = 2
export const MAX_OUTSTANDING = 8

export type ProbeResult = { state: 'ok' } | { state: 'absent'; detail: string } | { state: 'unavailable'; detail: string }

interface ShareProbeState { inflight: Promise<ProbeResult> | null; outstanding: number; suspectUntil: number; lastTimeout: string | null }
const states = new Map<string, ShareProbeState>()
let outstanding = 0

const stateOf = (key: string) => {
  let s = states.get(key)
  if (!s) states.set(key, s = { inflight: null, outstanding: 0, suspectUntil: 0, lastTimeout: null })
  return s
}

// A controlled override for diagnostics (cluster_teamwork p3 step 2):
// WFE_SHARE_PROBE_HANG=<root> makes probes of that root a command that does
// not answer (sleep), exercising timeout, kill and the caps without touching
// the mount itself.
const hangRoot = () => process.env.WFE_SHARE_PROBE_HANG || null

function command(root: string, marker: string | null): [string, string[]] {
  if (hangRoot() && hangRoot() === root) return ['sleep', ['3600']]
  return marker ? ['cat', ['--', join(root, marker)]] : ['test', ['-d', root]]
}

function runProbe(key: string, root: string, marker: string | null, ms: number): Promise<ProbeResult> {
  const s = stateOf(key)
  return new Promise(resolve => {
    const [cmd, args] = command(root, marker)
    let settled = false, out = ''
    const done = (r: ProbeResult) => { if (!settled) { settled = true; resolve(r) } }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: false })
    s.outstanding++; outstanding++
    let exited = false
    const reap = () => { if (!exited) { exited = true; s.outstanding--; outstanding-- } }
    child.on('error', e => { reap(); done({ state: 'unavailable', detail: `the probe could not run (${(e as Error).message})` }) })
    child.stdout!.on('data', d => { if (out.length < 65536) out += d })
    const timer = setTimeout(() => {
      s.suspectUntil = Date.now() + SUSPECT_MS
      s.lastTimeout = new Date().toISOString()
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      done({ state: 'unavailable', detail: `its root did not answer within ${ms} ms (a hung mount or an unreachable server); the read was abandoned, not proven cancelled` })
    }, ms)
    child.on('close', code => {
      clearTimeout(timer); reap()
      if (code === 0) { s.suspectUntil = 0; done({ state: 'ok' }) }
      else done({ state: 'absent', detail: marker ? `${marker} is not readable at its root` : 'its root is not a folder' })
    })
  })
}

// Probe a share's root. `ok`: the server answered now. `absent`: it answered
// that the marker/root is not there (an unmounted point). `unavailable`: no
// answer within the budget, or too many earlier probes still outstanding.
export async function probeShare(share: string, root: string, marker: string | null, ms = PROBE_MS): Promise<ProbeResult> {
  const key = `${share}\0${root}`
  const s = stateOf(key)
  if (s.inflight) return s.inflight
  if (s.suspectUntil > Date.now()) return { state: 'unavailable', detail: `its root did not answer at ${s.lastTimeout}; not probed again before ${new Date(s.suspectUntil).toISOString()}${s.outstanding ? ` (${s.outstanding} earlier probe${s.outstanding === 1 ? '' : 's'} not exited yet)` : ''}` }
  if (s.outstanding >= MAX_OUTSTANDING_PER_SHARE) return { state: 'unavailable', detail: `${s.outstanding} earlier probes of its root have not exited (hung I/O); no new probe is started` }
  if (outstanding >= MAX_OUTSTANDING) return { state: 'unavailable', detail: `${outstanding} share probes in this process have not exited (hung I/O); no new probe is started` }
  s.inflight = runProbe(key, root, marker, ms).finally(() => { s.inflight = null })
  return s.inflight
}

// What `wfe share list` and diagnostics show.
export function probeStatus(): { outstanding: number; shares: { key: string; outstanding: number; suspectUntil: string | null; lastTimeout: string | null }[] } {
  return { outstanding, shares: [...states.entries()].map(([key, s]) => ({ key: key.replace('\0', ' '), outstanding: s.outstanding, suspectUntil: s.suspectUntil > Date.now() ? new Date(s.suspectUntil).toISOString() : null, lastTimeout: s.lastTimeout })) }
}

// An overall budget for a routine reading (a view, a brief, an assessment):
// the reading's answer is `fallback()` once `ms` pass. The reading itself may
// still be running — its result is then dropped — which is why only bounded
// metadata reads, gated by probeShare, run under it.
export const ROUTINE_MS = Math.max(500, Number(process.env.WFE_SHARE_ROUTINE_MS) || 8000)
export function withinBudget<T>(p: Promise<T>, fallback: () => T, ms = ROUTINE_MS): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(fallback()) } }, ms)
    p.then(v => { if (!settled) { settled = true; clearTimeout(t); resolve(v) } }, () => { if (!settled) { settled = true; clearTimeout(t); resolve(fallback()) } })
  })
}
