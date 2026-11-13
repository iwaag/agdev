// The WFE service's HTTP peer loop (cluster_teamwork p2, docs/peers.md
// "HTTP delivery"). It owns two things and nothing else:
//
// - dispatch: posting the link store's rows to their peers (only this loop
//   posts them);
// - settling HTTP deliveries soon after they arrive: a `POST
//   /api/peers/messages` kicks it, and it runs the ordinary settle pass
//   (`PeerStore.process`) under the store's lease, so it never applies or
//   reconciles at the same time as another pass (`wfe peer process`).
//
// Bounded: a tick every TICK_MS that does nothing unless something is ready;
// the settle pass otherwise runs every SETTLE_MS. Idle while peers.json is
// absent.
import { loadPeerConfig, PeerStore } from './peerlink.ts'
import { Cluster } from './cluster.ts'
import type { ExecStore } from './exec.ts'

export const TICK_MS = 2_000
export const SETTLE_MS = 60_000
export const CLUSTER_CHECK_MS = 60_000

export class PeerHttpLoop {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private kicked = false
  private lastSettle = 0
  private lastCluster = 0
  private lastProblem: string | null = null
  readonly ctx: { area: string; registryFile: string; exec: ExecStore; log?: (m: string) => void }
  constructor(ctx: { area: string; registryFile: string; exec: ExecStore; log?: (m: string) => void }) { this.ctx = ctx }
  private log(m: string) { (this.ctx.log ?? console.log)(`peer http: ${m}`) }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }
  // A delivery was stored: settle it on the next turn.
  kick() { this.kicked = true; setImmediate(() => void this.tick()) }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const c = loadPeerConfig(this.ctx.area)
      if (!('config' in c)) return
      const s = new PeerStore({ area: this.ctx.area, registryFile: this.ctx.registryFile, exec: this.ctx.exec })
      try {
        if (this.kicked || s.pendingHttp() > 0 || Date.now() - this.lastSettle > SETTLE_MS) {
          this.kicked = false
          this.lastSettle = Date.now()
          for (const n of await s.process({ quietWhenBusy: true })) this.log(n)
        }
        if (s.readyHttp() > 0) for (const n of (await s.dispatchHttp(c.config)).notes) this.log(n)
        this.lastProblem = null
      } finally { s.close() }
      // The cluster directory (docs/cluster.md): this installation's
      // advertisement kept current, and a collector's members refreshed —
      // each on its own interval, never per request.
      if (Date.now() - this.lastCluster > CLUSTER_CHECK_MS) {
        this.lastCluster = Date.now()
        const cl = new Cluster({ area: this.ctx.area, registryFile: this.ctx.registryFile, exec: this.ctx.exec })
        await cl.advertisement().catch(e => this.log(`advertisement not rebuilt: ${(e as Error).message}`))
        for (const n of (await cl.collect()).notes) this.log(n)
      }
    } catch (e) {
      const m = (e as Error).message
      if (m !== this.lastProblem) this.log(`pass failed (retried): ${m}`)
      this.lastProblem = m
    } finally { this.running = false }
  }
}
