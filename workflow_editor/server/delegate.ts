// Delegation on this host (p10, docs/delegation.md): the file layer and the
// relay around the parent's `delegations` record (shared/run.ts).
//
// - dispatch: resolves the delegate node's portable target to a workspace
//   (explicitly, never by guess), refuses cycles, writes the request (and
//   the human original beside it) into the parent's run folder and records
//   the dispatch with `delivery: direct`. WFE delivers it itself (`deliverOne`):
//   it creates and binds the child and applies the parent's later answers,
//   instructions and corrections to it. (Records from before cluster_teamwork
//   p4 carry the notifier → Zulip → intake route they were delivered on; that
//   route is retired, so such a dispatch is delivered here only from its
//   recorded `delegation.reroute` on.) A delegation to another installation
//   goes over the agdev link (server/peerlink.ts).
// - relay: reads every bound child's record and records its relayed facts
//   on the parent, each under its own receipt, and queues the parent's
//   continuation for the facts that wake it. It runs in the executor's
//   reconcile; it is safe to repeat.
// - the parent agent's other operations (take-up, answer, instruct,
//   dispose) and reading the child's files go through the same checks.
//
// <area>/.local/delegate/delegate.sqlite is an index of delegations to
// relay, rebuilt from the parent records by `rebuild()`; the records stay
// the authority.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalJson, semanticDigest } from '../shared/canonical.ts'
import {
  childFacts, delegationFolder, isOpenDelegation, pendingEvents, questionEvent, WAKING,
  type ChildRef, type Delegation, type ManifestFile, type ResultManifest, type TransportRef,
} from '../shared/delegation.ts'
import { acceptsRequests, normalizeRepoPath } from '../shared/model.ts'
import { graphOfState, hostOf, questionState, replay, runKey, runUid, standingHold, type BecauseRef, type DocumentEvidence, type RunRecord, type RunRef } from '../shared/run.ts'
import { requestFrom } from '../shared/run.ts'
import { assessResult, assessmentReminders, type Assessment, type ChildEvidence } from '../shared/assessment.ts'
import { latestResult, openRevision as openRevisionOf } from '../shared/delegation.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { ExecStore, JobRow } from './exec.ts'
import { atomicWrite, inside, withinRoot } from './files.ts'
import { git } from './git.ts'
import { creationOf } from './observe.ts'
import { holdsProject, loadRegistry, available, recordedWorkspace, type Registration } from './registry.ts'
import { RUN_FILE, catalogOf, createRunInCopy, findRunByReceipt, listRuns, readRun, runDir, runOp, runOpLocked, type OpContext } from './runs.ts'
import { withLock } from './lock.ts'
import { reminderText } from '../shared/reminders.ts'
import { changedPaths, pathsByNode } from './reminders.ts'
import { runSpace } from './runspace.ts'
import { named, openStore } from './sqlite.ts'
import { RequestError, Workspace } from './workspace.ts'

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const now = () => new Date().toISOString()
export const uidOf = (r: RunRecord) => runUid(r, creationOf(r))
const MAX_FILE = 4 * 1024 * 1024

// <area>/workspaces.json (host-specific, outside Git): which workspace serves a
// project that has several on this host, for what a delegation creates here
// (local and from another installation). `{"projects": {"<project>":
// {"workspace": "<workspace id>"}}}`. Absent: no selection (a project with one
// workspace needs none). Unreadable or malformed: refused, never ignored.
export const WORKSPACES_FILE = 'workspaces.json'
export function selectedWorkspace(area: string, project: string): string | undefined {
  let text: string
  try { text = readFileSync(join(area, WORKSPACES_FILE), 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new RequestError(409, `${join(area, WORKSPACES_FILE)} cannot be read: ${(e as Error).message}`, { code: 'delegate-target' })
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) { throw new RequestError(409, `${join(area, WORKSPACES_FILE)} is not JSON: ${(e as Error).message}`, { code: 'delegate-target' }) }
  const projects = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { projects?: unknown }).projects : undefined
  if (projects === undefined) return undefined
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) throw new RequestError(409, `${WORKSPACES_FILE}: projects is {"<project>": {"workspace": "<id>"}}`, { code: 'delegate-target' })
  if (!Object.hasOwn(projects, project)) return undefined
  const w = (projects as Record<string, { workspace?: unknown } | null>)[project]?.workspace
  if (typeof w !== 'string' || !w) throw new RequestError(409, `${WORKSPACES_FILE}: projects.${project}.workspace is a workspace id`, { code: 'delegate-target' })
  return w
}

export interface DelegateContext { registryFile: string; area: string; exec?: ExecStore }
interface IndexRow { uid: string; parent_ws: string; parent_workflow: string; parent_run: string; delegation: string; node: string; target_project: string; target_workflow: string; target_ws: string; child_workflow: string | null; child_run: string | null; child_uid: string | null; relayed: number; state: 'open' | 'closed'; problem: string | null; updated: string }

export class DelegateStore {
  readonly db: DatabaseSync
  readonly ctx: DelegateContext
  constructor(ctx: DelegateContext) {
    this.ctx = ctx
    const dir = join(ctx.area, '.local', 'delegate')
    mkdirSync(dir, { recursive: true })
    this.db = openStore('delegate store', join(dir, 'delegate.sqlite'), [{
      version: 1,
      up: db => db.exec(`
        CREATE TABLE delegations (uid TEXT PRIMARY KEY, parent_ws TEXT NOT NULL, parent_workflow TEXT NOT NULL, parent_run TEXT NOT NULL, delegation TEXT NOT NULL, node TEXT NOT NULL,
          target_project TEXT NOT NULL, target_workflow TEXT NOT NULL, target_ws TEXT NOT NULL, child_workflow TEXT, child_run TEXT, child_uid TEXT,
          relayed INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, problem TEXT, updated TEXT NOT NULL);
        CREATE INDEX delegations_state ON delegations (state);
      `),
    }, {
      // cluster_teamwork p4: what WFE delivered directly to a local child —
      // one row per item of a `delivery: direct` delegation (the request,
      // each answer, instruction and correction): its outcome on the child.
      // The records stay the authority (each application has its receipt).
      version: 2,
      up: db => db.exec(`
        CREATE TABLE ldeliveries (id TEXT PRIMARY KEY, uid TEXT NOT NULL, item TEXT NOT NULL, state TEXT NOT NULL, child TEXT, seq INTEGER, note TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE INDEX ldeliveries_uid ON ldeliveries (uid);
      `),
    }])
  }
  close() { this.db.close() }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return named('delegate store', 'a read', () => this.db.prepare(sql).all(...a) as T[]) }
  private run(sql: string, ...a: (string | number | null)[]) { return named('delegate store', 'a write', () => this.db.prepare(sql).run(...a)) }

  rows(): IndexRow[] { return this.all<IndexRow>('SELECT * FROM delegations ORDER BY uid') }
  private index(ws: string, rec: RunRecord, d: Delegation) {
    const closed = !!d.closed || (!!d.disposition && !!d.child && this.childSettled(d))
    this.run(`INSERT INTO delegations (uid, parent_ws, parent_workflow, parent_run, delegation, node, target_project, target_workflow, target_ws, child_workflow, child_run, child_uid, relayed, state, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT (uid) DO UPDATE SET child_workflow = excluded.child_workflow, child_run = excluded.child_run, child_uid = excluded.child_uid,
      state = excluded.state, updated = excluded.updated`,
    d.uid, ws, rec.workflow, rec.run, d.id, d.node, d.target.project, d.target.workflow, d.target.workspace, d.child?.workflow ?? null, d.child?.run ?? null, d.child?.uid ?? null, d.closed ? 'closed' : closed ? 'closed' : 'open', now())
  }
  // A judged delegation is still relayed until its child is over (its
  // decision and integration are recorded for the record).
  private childSettled(d: Delegation) { return d.events.some(e => e.type === 'cancelled' || e.type === 'integrated') }

  // ---- resolution ------------------------------------------------------------------------

  private async registered(): Promise<Registration[]> { return (await loadRegistry(this.ctx.registryFile)).workspaces }
  // Gitea access, when this host has it: targets are then published workflows.
  private access(): import('./access.ts').AccessContext | undefined { return this.ctx.exec?.ctx.gitea ? this.ctx.exec.accessContext() : undefined }

  async workspace(id: string): Promise<Workspace> {
    const reg = recordedWorkspace(await this.registered(), id)
    if (!reg) throw new RequestError(404, `workspace "${id}" is not registered`)
    await assertWorkspaceAllowed(await loadBoundary(this.ctx.registryFile, this.ctx.area), reg, 'Delegation')
    return new Workspace(reg)
  }

  // The target project's workspace on this host: its one registered
  // workspace, or the one <area>/workspaces.json selects
  // ({"projects": {"<project>": {"workspace": "<id>"}}}). Ambiguity is
  // refused with the candidates, never guessed (docs/delegation.md).
  async targetWorkspace(project: string): Promise<Workspace> {
    const regs = (await this.registered()).filter(w => w.project === project)
    const selected = selectedWorkspace(this.ctx.area, project)
    const reg = selected ? regs.find(w => w.id === selected) : regs.length === 1 ? regs[0] : undefined
    if (!reg) throw new RequestError(409, selected ? `project ${project}: ${WORKSPACES_FILE} selects workspace ${selected}, which is not registered for it` : regs.length ? `project ${project} has ${regs.length} workspaces here (${regs.map(w => w.id).join(', ')}); name one in ${WORKSPACES_FILE} projects.${project}.workspace — a delegation never guesses` : `project ${project} has no workspace registered on this host`, { code: 'delegate-target' })
    await assertWorkspaceAllowed(await loadBoundary(this.ctx.registryFile, this.ctx.area), reg, 'Delegation')
    if (!(await available(reg))) throw new RequestError(409, `workspace ${reg.id} of project ${project} is not available`, { code: 'delegate-target' })
    return new Workspace(reg)
  }

  // Every registered workflow's delegate targets, as `<project>/<workflow>` keys.
  private async definitionGraph(): Promise<Map<string, string[]>> {
    const graph = new Map<string, string[]>()
    for (const reg of await this.registered()) {
      if (!reg.project || !(await available(reg))) continue
      const ws = new Workspace(reg)
      for (const s of (await ws.workflowSummaries().catch(() => ({ list: [] }))).list) {
        if (!s.id) continue
        graph.set(`${reg.project}/${s.id}`, s.delegates.map(t => (t.includes('/') ? t : `${reg.project}/${t}`)))
      }
    }
    return graph
  }

  // The ancestors of a run through delegation: each parent's record, read
  // from its own workspace, as `<project>/<workflow>` with its uid.
  async ancestors(rec: RunRecord): Promise<{ key: string; uid: string }[]> {
    const out: { key: string; uid: string }[] = []
    let cur: RunRecord | undefined = rec
    for (let depth = 0; cur && depth < 32; depth++) {
      const e: RunRecord['input']['entrustedBy'] = cur.input.entrustedBy
      if (e?.kind !== 'delegation') break
      // A parent on another installation is not read here (improve_multinodes p1).
      if (e.peer) break
      const parent: { project: string; workflow: string; run: string; creation: string; node: string } = e.parent
      out.push({ key: `${parent.project}/${parent.workflow}`, uid: `${parent.project}/${parent.workflow}/${parent.run}#${parent.creation}` })
      const regs: Registration[] = (await this.registered()).filter(w => holdsProject(w, parent.project))
      cur = undefined
      for (const r of regs) {
        const found: RunRecord | undefined = (await readRun(new Workspace(r), { workflow: parent.workflow, run: parent.run }).catch(() => null))?.record
        if (found && creationOf(found) === parent.creation) { cur = found; break }
      }
    }
    return out
  }

  // ---- dispatch ---------------------------------------------------------------------------

  async dispatch(ws: Workspace, ref: RunRef, node: string, o: { request: string; original?: string; predecessor?: string; attempt?: string; by?: string; via: string; receipt?: string }): Promise<{ record: RunRecord; delegation: Delegation; duplicate: boolean; notes: string[] }> {
    const space = await runSpace(ws, ref)
    const reading = await readRun(space, ref)
    const rec = reading.record
    if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be read: ${reading.problem?.message ?? ''}`)
    const gn = (rec.definition.revisions?.at(-1)?.effective ?? rec.definition.effective)?.nodes[node]
    if (!gn) throw new RequestError(422, `node "${node}" is not in run ${runKey(ref)}'s graph`, { code: 'node-unknown' })
    if (gn.type !== 'delegate' || !gn.workflow) throw new RequestError(422, `node "${node}" is ${gn.type}; only a delegate node with a target dispatches`, { code: 'state' })
    if (!o.request.trim()) throw new RequestError(400, 'the request is empty: write what the child is asked for')
    const receipt = o.receipt ?? `dispatch:${node}:${sha256(o.request).slice(0, 16)}:${o.predecessor ?? ''}`
    const dup = rec.history.find(h => h.receipt === receipt)
    if (dup) {
      const d = Object.values(rec.delegations ?? {}).find(x => x.dispatched.seq === dup.seq)!
      return { record: rec, delegation: d, duplicate: true, notes: [] }
    }
    const project = gn.project ?? rec.project
    if (gn.instance) return this.dispatchRemote(ws, space, ref, rec, node, gn.instance, project, gn.workflow, o, receipt)
    const target = await this.targetWorkspace(project)
    const notes: string[] = []
    // The target as it is published now (improve_wfrun p1: its default
    // branch, fetched): it exists, validates and accepts requests. The
    // revision is recorded, and the child is created from it.
    const access = this.access()
    const published = access ? await (await import('./published.ts')).publishedWorkspace(access, target.reg, { fresh: true }) : null
    const tws: Workspace = published ?? target
    const at = published ? ` at ${published.source.repository}@${published.source.commit.slice(0, 10)}` : ` (workspace ${target.reg.id})`
    const summaries = (await tws.workflowSummaries()).list
    const summary = summaries.find(s => s.id === gn.workflow)
    if (!summary) {
      const unreadable = summaries.find(s => !s.id && s.problem && /^(.*)\.ya?ml$/.exec(s.file)?.[1] === gn.workflow)
      throw new RequestError(409, unreadable ? `${project}/${unreadable.file}${at} cannot be read: ${unreadable.problem!.message}` : `project ${project}${at} has no workflow "${gn.workflow}"${published ? ' (a workflow is offered once it is on the default branch)' : ''}`, { code: 'delegate-target' })
    }
    const tw = await tws.workflowResponse(summary.file)
    if (!tw.workflow || tw.issues.some(i => i.severity === 'error')) throw new RequestError(409, `${project}/${gn.workflow} has validation errors; a child needs a valid definition (wfe validate ${gn.workflow} --workspace ${target.reg.id})`, { code: 'delegate-target' })
    // cluster_teamwork p4: the transport-neutral capability (intake.requests,
    // else the historical intake.zulip meaning); delivery is WFE's own.
    if (!acceptsRequests(tw.workflow)) throw new RequestError(409, `${project}/${gn.workflow} takes no requests (${tw.workflow.intake.requests === false ? 'intake.requests: false' : 'intake: {zulip: ""}'}); a delegation to it is refused`, { code: 'delegate-target' })
    // Cycles: the target's definitions reaching back, and the active ancestors.
    const self = `${rec.project}/${rec.workflow}`
    const tkey = `${project}/${gn.workflow}`
    const graph = access ? (await (await import('./published.ts')).publishedGraph(access)).graph : await this.definitionGraph()
    const seen = new Set<string>(), path: string[] = []
    const reaches = (k: string): boolean => {
      if (k === self) { path.push(k); return true }
      if (seen.has(k)) return false
      seen.add(k)
      for (const t of graph.get(k) ?? []) if (reaches(t)) { path.unshift(k); return true }
      return false
    }
    if (tkey === self || reaches(tkey)) throw new RequestError(422, `delegating ${self} → ${tkey} is a cycle: ${[self, ...(tkey === self ? [] : path)].join(' → ')}`, { code: 'delegate-cycle' })
    const ancestors = await this.ancestors(rec)
    const loop = ancestors.find(a => a.key === tkey)
    if (loop) throw new RequestError(422, `delegating to ${tkey} would run it inside itself: this run descends from ${loop.uid} (${ancestors.map(a => a.key).join(' ← ')})`, { code: 'delegate-cycle' })
    // The request and the human original, written into the run folder.
    const id = `d${Object.keys(rec.delegations ?? {}).length + 1}`
    const folder = delegationFolder(runDir(ref), id)
    const dir = await inside(space.root, folder)
    await mkdir(dir, { recursive: true })
    await atomicWrite(join(dir, 'request.md'), o.request)
    const original = o.original ?? await this.humanOriginal(space, ref, rec)
    if (original !== null) await atomicWrite(join(dir, 'original-input.md'), original)
    const ev = (name: string, text: string): DocumentEvidence => ({ path: `${folder}/${name}`, sha256: sha256(text), bytes: Buffer.byteLength(text) })
    const onBehalfOf = rec.input.author ?? rec.input.onBehalfOf ?? null
    const r = await runOp(space, ref, {
      op: 'delegation.dispatch', delegation: id, uid: `${uidOf(rec)}/${id}`, node,
      target: { project, workflow: gn.workflow, workspace: target.reg.id, ...(published ? { source: { kind: 'published', repository: published.source.repository, branch: published.source.branch, commit: published.source.commit, definitions: published.source.definitions } } : {}) },
      request: ev('request.md', o.request), ...(original !== null ? { original: ev('original-input.md', original) } : {}),
      ...(onBehalfOf ? { onBehalfOf } : {}), ...(o.predecessor ? { predecessor: o.predecessor } : {}), targetDigest: await semanticDigest('definition', tw.workflow),
      receipt, ...(o.attempt ? { attempt: o.attempt } : {}), delivery: 'direct',
    } as never, { by: o.by, via: o.via })
    const d = r.record.delegations![id]
    this.index(ws.shared.reg.id, r.record, d)
    // Delivered now when this process has the executor's stores; otherwise
    // (and after any failure) by the next reconcile.
    if (d.delivery === 'direct') notes.push(...await this.deliverOne(d.uid).catch(e => [`${d.uid}: not delivered yet (${(e as Error).message}); the reconcile delivers it`]))
    if (summary.warnings) notes.push(...tw.issues.filter(i => i.severity === 'warning' && i.code !== 'delegate-not-executable').map(i => `${tkey}: ${i.code}: ${i.message}`))
    return { record: r.record, delegation: d, duplicate: !!r.duplicate, notes }
  }

  // A delegate node naming another installation (improve_multinodes p1,
  // docs/peers.md): the target is checked against this host's peer
  // configuration — that installation checks the workflow itself — and the
  // request goes out over the agdev link. The record is
  // the ordinary dispatch with `target.instance`.
  private async dispatchRemote(ws: Workspace, space: Workspace, ref: RunRef, rec: RunRecord, node: string, instance: string, project: string, workflow: string, o: { request: string; original?: string; predecessor?: string; attempt?: string; by?: string; via: string }, receipt: string): Promise<{ record: RunRecord; delegation: Delegation; duplicate: boolean; notes: string[] }> {
    const { needPeerConfig, PeerStore, MAX_MESSAGE, readCredential, credentialFile } = await import('./peerlink.ts')
    const cfg = needPeerConfig(this.ctx.area)
    const peer = PeerStore.checkRemoteTarget(cfg, instance, project, workflow)
    // cluster_teamwork p2: work with this peer goes over HTTP; without the
    // credential it issued, nothing could be delivered — refused before recording.
    if (!readCredential(this.ctx.area, peer)) throw new RequestError(409, `${peer.label} (${instance}) is reached over HTTP, but no credential it issued is installed here (${credentialFile(this.ctx.area, peer)}); its operator issues one (wfe peer credential issue ${cfg.self}) and this installation installs it (wfe peer credential install ${instance}). Nothing was recorded`, { code: 'peer-credential' })
    if (!this.ctx.exec) throw new RequestError(409, 'a delegation to another installation is dispatched where the executor\'s stores are (the coordinator)', { code: 'delegate-target' })
    const id = `d${Object.keys(rec.delegations ?? {}).length + 1}`
    const original = o.original ?? await this.humanOriginal(space, ref, rec)
    // The message size is checked before anything is recorded.
    const probe = PeerStore.wire(PeerStore.requestEnvelope(cfg, rec, { id, uid: `${uidOf(rec)}/${id}`, node, target: { project, workflow, workspace: `peer:${instance}`, instance }, accepts: 'person', requester: rec.executor.name, onBehalfOf: rec.input.author ?? rec.input.onBehalfOf ?? null } as Delegation, o.request, original))
    if (probe.length > MAX_MESSAGE) throw new RequestError(413, `the request to ${peer.label} would be a ${probe.length}-character message; the agdev link carries at most ${MAX_MESSAGE} (shorten request.md or the original, or name files in a repository the other installation can read)`, { code: 'peer-message-size' })
    const folder = delegationFolder(runDir(ref), id)
    const dir = await inside(space.root, folder)
    await mkdir(dir, { recursive: true })
    await atomicWrite(join(dir, 'request.md'), o.request)
    if (original !== null) await atomicWrite(join(dir, 'original-input.md'), original)
    const ev = (name: string, text: string): DocumentEvidence => ({ path: `${folder}/${name}`, sha256: sha256(text), bytes: Buffer.byteLength(text) })
    const onBehalfOf = rec.input.author ?? rec.input.onBehalfOf ?? null
    const r = await runOp(space, ref, {
      op: 'delegation.dispatch', delegation: id, uid: `${uidOf(rec)}/${id}`, node,
      target: { project, workflow, workspace: `peer:${instance}`, instance },
      request: ev('request.md', o.request), ...(original !== null ? { original: ev('original-input.md', original) } : {}),
      ...(onBehalfOf ? { onBehalfOf } : {}), ...(o.predecessor ? { predecessor: o.predecessor } : {}),
      receipt, ...(o.attempt ? { attempt: o.attempt } : {}),
    } as never, { by: o.by, via: o.via })
    const d = r.record.delegations![id]
    this.index(ws.shared.reg.id, r.record, d)
    const link = new PeerStore({ area: this.ctx.area, registryFile: this.ctx.registryFile, exec: this.ctx.exec })
    try { await link.ensureRequest(ws.shared.reg.id, r.record, d) } finally { link.close() }
    return { record: r.record, delegation: d, duplicate: !!r.duplicate, notes: [`${project}/${workflow} on ${peer.label} (${instance}): the request goes over the agdev link; ${peer.label} checks the workflow and answers with its own run or a refusal (wfe peer status). Answers, instructions, corrections and cancellation go the same way once ${peer.label} has said it applies them.`] }
  }

  // The person's words a run's request ultimately comes from: the parent's
  // own request, or the original its agent's request kept (docs/delegation.md).
  private async humanOriginal(space: Workspace, ref: RunRef, rec: RunRecord): Promise<string | null> {
    const file = requestFrom(rec.input) === 'person' ? rec.input.file : rec.input.original
    if (!file) return null
    return readFile(join(await inside(space.root, runDir(ref)), file), 'utf8').catch(() => null)
  }

  // ---- the delivering side ----------------------------------------------------------------

  // A delegation's parent and the request it dispatched, as delivery needs
  // them to create the child: checked against the recorded hash.
  async requestOf(parent: { workspace: string; workflow: string; run: string }, id: string): Promise<{ record: RunRecord; delegation: Delegation; request: string; original: string | null; space: Workspace }> {
    const ws = await this.workspace(parent.workspace)
    const ref = { workflow: parent.workflow, run: parent.run }
    const space = await runSpace(ws, ref)
    const rec = (await readRun(space, ref)).record
    if (!rec) throw new RequestError(409, `the parent run ${runKey(ref)} in ${parent.workspace} cannot be read`)
    const d = rec.delegations?.[id]
    if (!d) throw new RequestError(409, `the parent run ${runKey(ref)} has no delegation ${id}`)
    const read = async (e: DocumentEvidence | undefined) => {
      if (!e) return null
      const text = await readFile(await inside(space.root, e.path), 'utf8')
      if (sha256(text) !== e.sha256) throw new RequestError(409, `${e.path} changed since delegation ${id} was dispatched (its hash differs); the request is not delivered as something else`)
      return text
    }
    return { record: rec, delegation: d, request: (await read(d.request))!, original: await read(d.original), space }
  }

  async bind(parent: { workspace: string; workflow: string; run: string }, id: string, child: RunRecord, childWorkspace: string, transport: TransportRef): Promise<void> {
    const { record, delegation, space } = await this.requestOf(parent, id)
    const ref: ChildRef = { uid: uidOf(child), workspace: childWorkspace, project: child.project, workflow: child.workflow, run: child.run, created: child.created }
    const r = await runOp(space, { workflow: record.workflow, run: record.run }, { op: 'delegation.bind', delegation: id, child: ref, transport, receipt: `delegation-bind:${delegation.uid}` } as never, { by: 'wfe', via: 'delegation' })
    this.index(parent.workspace, r.record, r.record.delegations![id])
  }

  // An item of this delegation was not applied to the child (late, the
  // child closed, refused): the parent is told, and woken.
  async refused(parent: { workspace: string; workflow: string; run: string }, id: string, o: { kind: 'answer' | 'instruction' | 'revision'; index: number; reason: string; question?: string }): Promise<void> {
    const ws = await this.workspace(parent.workspace)
    const ref = { workflow: parent.workflow, run: parent.run }
    const space = await runSpace(ws, ref)
    const rec = (await readRun(space, ref)).record
    const d = rec?.delegations?.[id]
    if (!rec || !d || rec.cancelled || d.closed) return
    await runOp(space, ref, { op: 'delegation.event', delegation: id, event: { type: 'answer-refused', child: { seq: 0, at: now(), by: 'wfe' }, text: `${o.kind === 'revision' ? 'correction request' : o.kind} ${o.index} was not applied to the child: ${o.reason}`, ...(o.question ? { question: o.question } : {}), ...(o.kind === 'revision' ? { revision: o.index } : { answer: o.index }) }, receipt: `delegation:${d.uid}:${o.kind}:${o.index}:refused` } as never, { by: 'wfe', via: 'delegation' })
    await this.continuation(space, ref)
  }

  // ---- direct local delivery (cluster_teamwork p4, docs/delegation.md) ----------------------
  //
  // A local delegation dispatched with `delivery: direct` is delivered by WFE
  // from the parent's durable record, never through a notifier post: the
  // child is created (found again by its receipt) and bound; each recorded
  // answer, instruction and correction is applied to the child with the
  // ordinary run operation under its own receipt, with the parent's words and
  // whose they are. A refusal by the child is told to the parent. Repeating
  // any of it applies nothing twice. The execution
  // queue starts or continues the child — nothing is launched from here.

  static receiptOf(uid: string, item: string) { return `direct:${uid}:${item}` }
  deliveries(uid?: string): { id: string; uid: string; item: string; state: string; child: string | null; seq: number | null; note: string | null; attempts: number; created: string; updated: string }[] {
    return uid ? this.all('SELECT * FROM ldeliveries WHERE uid = ? ORDER BY created, id', uid) : this.all('SELECT * FROM ldeliveries ORDER BY updated DESC LIMIT 100')
  }
  private journal(uid: string, item: string, state: 'applied' | 'refused' | 'failed', o: { child?: string | null; seq?: number | null; note?: string | null } = {}) {
    const id = DelegateStore.receiptOf(uid, item)
    this.run(`INSERT INTO ldeliveries (id, uid, item, state, child, seq, note, attempts, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (id) DO UPDATE SET state = excluded.state, child = coalesce(excluded.child, child), seq = coalesce(excluded.seq, seq), note = excluded.note, attempts = attempts + 1, updated = excluded.updated`,
    id, uid, item, state, o.child ?? null, o.seq ?? null, o.note ?? null, now(), now())
  }
  private settledItem(uid: string, item: string) { return this.all<{ state: string }>('SELECT state FROM ldeliveries WHERE id = ?', DelegateStore.receiptOf(uid, item))[0]?.state }

  // Every open direct delegation's owed items (the reconcile's pass).
  async deliver(): Promise<string[]> {
    if (!this.ctx.exec) return []
    const notes: string[] = []
    for (const row of this.rows().filter(r => r.state === 'open' && !r.target_ws.startsWith('peer:'))) {
      try { notes.push(...await this.deliverOne(row.uid)) } catch (e) { notes.push(`delegation ${row.uid}: direct delivery failed (retried) — ${(e as Error).message}`) }
    }
    return notes
  }

  async deliverOne(uid: string): Promise<string[]> {
    const exec = this.ctx.exec
    if (!exec) return []
    const row = this.rows().find(r => r.uid === uid)
    if (!row) return []
    const parent = { workspace: row.parent_ws, workflow: row.parent_workflow, run: row.parent_run }
    const { record, delegation: d, request, original } = await this.requestOf(parent, row.delegation)
    // Another installation's delegation travels the agdev link. One without
    // `delivery: direct` was dispatched on the retired notifier → intake
    // route and never rerouted: its items belong to that route, and nothing
    // is delivered for it here.
    if (d.delivery !== 'direct' || d.target.instance) return []
    const notes: string[] = []
    const tws = await this.workspace(d.target.workspace)
    let child = d.child
    if (!child) {
      if (this.settledItem(uid, 'request') === 'refused') return []
      const receipt = DelegateStore.receiptOf(uid, 'request')
      let ref = await findRunByReceipt(tws, d.target.workflow, receipt)
      if (!ref) {
        if (record.cancelled || d.closed || d.disposition) { this.journal(uid, 'request', 'refused', { note: `delegation ${uid} is ${record.cancelled ? 'of a cancelled run' : d.disposition ? d.disposition.kind : 'closed'}; no child is created for it` }); return [`${uid}: no child created (the delegation is no longer open)`] }
        const env = exec.ctx.gitea ? await exec.ctx.gitea.gitEnv() : {}
        try {
          ref = (await createRunInCopy(tws, {
            workflow: d.target.workflow, receipt, executor: { host: exec.executor }, by: record.executor.name, via: 'delegation', area: this.ctx.area,
            ...(exec.ctx.gitea ? { access: exec.accessContext() } : {}),
            // The child follows the revision the parent dispatched to.
            ...(d.target.source?.commit ? { rev: d.target.source.commit } : {}),
            input: {
              from: 'agent', text: request, requester: record.executor.name, ...(d.onBehalfOf ? { onBehalfOf: d.onBehalfOf } : {}),
              entrustedBy: { kind: 'delegation', delegation: d.uid, parent: { project: record.project, workflow: record.workflow, run: record.run, creation: creationOf(record), node: d.node }, accepts: d.accepts },
              ...(original !== null ? { original } : {}), source: { kind: 'delegation', route: 'direct', delegation: d.uid, item: 'request', at: now() },
            },
          } as never, env)).ref
        } catch (e) {
          // The target's own refusal (its definition, its workspace) is final and told; anything else is retried.
          if (e instanceof RequestError && e.status >= 400 && e.status < 500 && !/already exists/.test(e.message)) {
            this.journal(uid, 'request', 'refused', { note: e.message.slice(0, 500) })
            this.run('UPDATE delegations SET problem = ?, updated = ? WHERE uid = ?', `the child could not be created: ${e.message.slice(0, 400)}`, now(), uid)
            return [`${uid}: the child was refused — ${e.message}`]
          }
          throw e
        }
      }
      const created = (await readRun(await runSpace(tws, ref), ref)).record
      if (!created) throw new Error(`the child ${ref.workflow}/${ref.run} cannot be read after its creation`)
      await this.bind(parent, d.id, created, tws.reg.id, { route: 'direct', delivery: receipt, at: now() })
      this.journal(uid, 'request', 'applied', { child: uidOf(created), seq: 1 })
      if (!created.cancelled && created.control.attempts === 0) exec.enqueue(tws.reg.id, ref, 'start', `request:${receipt}`, `start: delegation ${d.uid} from ${record.project}/${record.workflow}/${record.run} (delivered directly)`)
      notes.push(`${uid}: child ${created.project} ${ref.workflow}/${ref.run} created and bound directly`)
      child = { uid: uidOf(created), workspace: tws.reg.id, project: created.project, workflow: created.workflow, run: created.run, created: created.created }
    }
    const cref = { workflow: child.workflow, run: child.run }
    const cws = await this.workspace(child.workspace)
    type Item = { item: string; kind: 'answer' | 'instruction' | 'revision'; index: number; seq: number }
    const items: Item[] = [
      ...d.answers.map(a => ({ item: `answer:${a.n}`, kind: 'answer' as const, index: a.n, seq: a.seq })),
      ...d.instructions.map(i => ({ item: `instruction:${i.n}`, kind: 'instruction' as const, index: i.n, seq: i.seq })),
      ...(d.revisions ?? []).map(r => ({ item: `revision:${r.n}`, kind: 'revision' as const, index: r.n, seq: r.seq })),
    ].filter(x => !d.rerouted || x.seq > d.rerouted.seq).sort((x, y) => x.seq - y.seq) // p5: before a reroute, the old route's
    for (const it of items) {
      const st = this.settledItem(uid, it.item)
      if (st === 'applied' || st === 'refused') continue
      const receipt = DelegateStore.receiptOf(uid, it.item)
      const source = { kind: 'delegation' as const, route: 'direct' as const, delegation: d.uid, item: it.item, at: now() }
      let op: Record<string, unknown>, by: string, question: string | undefined
      if (it.kind === 'answer') {
        const a = d.answers.find(x => x.n === it.index)!
        question = a.question; by = a.by
        op = { op: 'question.answer', question: a.question, text: a.text, from: a.from, source, delegation: { uid: d.uid, answer: a.n }, receipt }
      } else if (it.kind === 'instruction') {
        const i = d.instructions.find(x => x.n === it.index)!
        by = i.by
        op = { op: 'instruction.receive', text: i.text, from: i.from, source, receipt }
      } else {
        const r = d.revisions!.find(x => x.n === it.index)!
        by = r.by
        op = { op: 'correction.receive', delegation: { uid: d.uid, revision: r.n }, result: { seq: r.childSeq }, text: r.instruction, reason: r.reason, from: r.from, source, receipt }
      }
      const told = (reason: string) => this.refused(parent, d.id, { kind: it.kind, index: it.index, reason, ...(question ? { question } : {}) }).catch(() => undefined)
      try {
        const r = await runOp(cws, cref, op as never, { by, via: 'delegation' })
        const seq = r.record.history.find(h => h.receipt === receipt)?.seq ?? r.record.seq
        this.journal(uid, it.item, 'applied', { child: child.uid, seq })
        notes.push(`${uid}: ${it.item} applied to ${cref.workflow}/${cref.run} at seq ${seq} (directly)`)
        // What follows is the execution queue's: a waiting child resumes.
        if (it.kind === 'answer') await exec.afterAnswer(cws, cref, question!)
        if (it.kind === 'instruction') { const id = Object.values(r.record.instructions ?? {}).find(x => x.source?.kind === 'delegation' && x.source.item === it.item && x.source.delegation === d.uid)?.id; if (id) await exec.afterInstruction(cws, cref, id) }
        if (it.kind === 'revision') { const k = Object.values(r.record.corrections ?? {}).find(x => x.source?.kind === 'delegation' && x.source.item === it.item && x.source.delegation === d.uid)?.id; if (k) await exec.afterCorrection(cws, cref, k) }
      } catch (e) {
        const code = (e as RequestError).detail && typeof (e as RequestError).detail === 'object' ? ((e as RequestError).detail as { code?: string }).code : undefined
        const closed = code === 'question-closed' ? `the child's ${question} was already closed (${(e as Error).message})` : code === 'run-completed' ? 'the child is completed' : code === 'run-cancelled' ? 'the child is cancelled' : (e instanceof RequestError && (e.status === 422 || (it.kind === 'revision' && code === 'result-superseded'))) ? `the child refused it: ${e.message}` : null
        if (!closed) { this.journal(uid, it.item, 'failed', { child: child.uid, note: (e as Error).message.slice(0, 500) }); throw e }
        this.journal(uid, it.item, 'refused', { child: child.uid, note: closed.slice(0, 500) })
        await told(closed)
        notes.push(`${uid}: ${it.item} refused by the child — ${closed}`)
      }
    }
    return notes
  }

  // ---- the relay --------------------------------------------------------------------------

  // Re-reads every parent record of every available workspace and indexes
  // its delegations: what a lost index row, or a dispatch recorded where the
  // index was not written, needs. Cheap enough for every reconcile.
  async rebuild(): Promise<string[]> {
    const notes: string[] = []
    const known = new Set(this.rows().map(r => r.uid))
    for (const reg of await this.registered()) {
      if (!(await available(reg))) continue
      const ws = new Workspace(reg)
      for (const s of await listRuns(ws).catch(() => [])) {
        if (s.problem) continue
        const rec = (await readRun(ws, { workflow: s.workflow, run: s.run }).catch(() => null))?.record
        for (const d of Object.values(rec?.delegations ?? {})) {
          this.index(reg.id, rec!, d)
          if (!known.has(d.uid)) notes.push(`delegation ${d.uid}: indexed from its record`)
        }
      }
    }
    return notes
  }

  // Relays what each bound child recorded since the last pass: one parent
  // entry per fact (by receipt), and a continuation for the facts that wake
  // the parent. A cancelled parent records nothing more; its index row
  // closes and the child stays readable.
  async relay(): Promise<string[]> {
    const notes: string[] = []
    for (const row of this.rows().filter(r => r.state === 'open' && !r.target_ws.startsWith('peer:'))) {
      try {
        notes.push(...await this.relayOne(row))
      } catch (e) {
        const msg = (e as Error).message
        if (row.problem !== msg) notes.push(`delegation ${row.uid}: ${msg}`)
        this.run('UPDATE delegations SET problem = ?, updated = ? WHERE uid = ?', msg.slice(0, 500), now(), row.uid)
      }
    }
    return notes
  }

  private async relayOne(row: IndexRow): Promise<string[]> {
    const ws = await this.workspace(row.parent_ws)
    const ref = { workflow: row.parent_workflow, run: row.parent_run }
    const space = await runSpace(ws, ref)
    let rec = (await readRun(space, ref)).record
    if (!rec) throw new Error(`the parent ${runKey(ref)} cannot be read`)
    let d = rec.delegations?.[row.delegation]
    if (!d) throw new Error(`the parent ${runKey(ref)} has no delegation ${row.delegation}`)
    if (rec.cancelled || d.closed) { this.run('UPDATE delegations SET state = \'closed\', problem = NULL, updated = ? WHERE uid = ?', now(), row.uid); return [`delegation ${row.uid}: closed with its parent`] }
    this.index(row.parent_ws, rec, d)
    if (!d.child) return []
    const cws = await this.workspace(d.child.workspace)
    const cref = { workflow: d.child.workflow, run: d.child.run }
    const cspace = await runSpace(cws, cref)
    const child = (await readRun(cspace, cref)).record
    if (!child) throw new Error(`the child ${d.child.project}/${runKey(cref)} cannot be read`)
    if (uidOf(child) !== d.child.uid) throw new Error(`the child ${runKey(cref)} in ${d.child.workspace} is ${uidOf(child)}, not the bound ${d.child.uid}; nothing is relayed from another run`)
    const notes: string[] = []
    let woke = false
    for (const f of childFacts(d.uid, child, row.relayed)) {
      if (rec!.history.some(h => h.receipt === f.receipt)) continue
      const event = f.event.type === 'completed' ? { ...f.event, manifest: await this.manifest(cspace, child) } : f.event
      const r = await runOp(space, ref, { op: 'delegation.event', delegation: d.id, event, receipt: f.receipt } as never, { by: 'wfe', via: 'delegation' })
      rec = r.record
      if (!r.duplicate) { notes.push(`delegation ${d.uid}: ${f.event.type} (child seq ${f.event.child.seq})`); if (WAKING.has(f.event.type)) woke = true }
    }
    d = rec!.delegations![d.id]
    this.run('UPDATE delegations SET relayed = max(relayed, ?), problem = NULL, updated = ? WHERE uid = ?', child.seq, now(), row.uid)
    this.index(row.parent_ws, rec!, d)
    if (woke || pendingEvents(d).length) {
      const job = await this.continuation(space, ref)
      if (job && woke) notes.push(`${runKey(ref)}: continuation queued (job ${job.id}, ${job.state})`)
    }
    return notes
  }

  // The parent's continuation for a relayed fact (docs/delegation.md): one
  // job per fact, by its receipt; nothing while the parent is held,
  // cancelled or executing (an attempt's end queues it then).
  async continuation(ws: Workspace, ref: RunRef): Promise<JobRow | null> {
    const exec = this.ctx.exec
    if (!exec) return null
    const space = await runSpace(ws, ref)
    const r = (await readRun(space, ref)).record
    if (!r || hostOf(r.executor) !== exec.executor || r.cancelled || r.control.hold || r.control.stop || r.control.attempt) return null
    // p18: a standing conductor's closed room continues nothing; a fact it
    // held at a transition waits for the person's resume.
    if (standingHold(r)) return null
    for (const d of Object.values(r.delegations ?? {})) {
      if (!isOpenDelegation(d)) continue
      const e = pendingEvents(d).find(x => !r.standing?.held.includes(`${d.id}#${x.n}`))
      if (e) return exec.enqueue(ws.shared.reg.id, ref, 'resume', `delegation:${ws.shared.reg.id}/${runKey(ref)}/${d.id}/${e.n}`, `resume: delegation ${d.id} relayed ${e.type} #${e.n} from ${d.target.project}/${d.target.workflow}`)
    }
    return null
  }

  // What a completed child hands back (docs/delegation.md): its outcome,
  // the final report and artifacts by hash (and the commit of the run
  // branch holding each, when that commit has it unchanged), its decision.
  async manifest(space: Workspace, child: RunRecord): Promise<ResultManifest> {
    const done = [...child.history].reverse().find(h => h.change.execution?.[1] === 'completed') as unknown as { outcome?: string } | undefined
    const graph = child.definition.revisions?.at(-1)?.effective ?? child.definition.effective
    const finalStep = Object.entries(graph?.nodes ?? {}).find(([, n]) => n.step?.kind === 'final-report')?.[0]
    const head = (await git(space.root, ['rev-parse', 'HEAD'])).stdout.trim() || null
    const fileOf = async (path: string): Promise<ManifestFile | null> => {
      try {
        const abs = await inside(space.root, path)
        const st = await lstat(abs)
        if (!st.isFile() || st.size > 512 * 1024 * 1024) return null
        const bytes = await readFile(abs)
        const h = sha256(bytes)
        // The commit holds it unchanged when HEAD's blob of it is the same bytes.
        const blob = head ? (await git(space.root, ['rev-parse', `HEAD:${path}`])).stdout.trim() : ''
        const same = blob ? (await git(space.root, ['hash-object', abs])).stdout.trim() === blob : false
        return { path, sha256: h, bytes: bytes.length, commit: same ? head : null }
      } catch { return null }
    }
    const report = finalStep && child.nodes[finalStep]?.document ? await fileOf(child.nodes[finalStep].document!.path) : null
    const artifacts: ManifestFile[] = []
    for (const p of [...new Set(child.artifacts.map(a => a.path))]) {
      if (report && p === report.path) continue
      const f = await fileOf(p)
      if (f) artifacts.push(f)
    }
    const last = child.decisions.at(-1)
    const body = { child: uidOf(child), execution: child.execution.state, outcome: done?.outcome ?? '', report, artifacts, decision: last ? { decision: last.decision, by: last.by, at: last.at } : null, branch: child.storage?.branch ?? null }
    return { digest: `sha256:${sha256(canonicalJson(body))}`, ...body }
  }

  // ---- the parent agent's operations --------------------------------------------------------

  // Answers a child's question. The child's own record decides whether the
  // question is still open: a closed one is refused here rather than sent.
  async answer(ws: Workspace, ref: RunRef, id: string, question: string, text: string, ctx: OpContext & { attempt?: string; because?: BecauseRef; receipt?: string }) {
    const { d } = await this.parentDelegation(ws, ref, id)
    if (d.target.instance) {
      // improve_multinodes p2: over the link — checked (the peer applies
      // answers; the message fits) before anything is recorded, then queued
      // from the record. The remote run's own record decides whether the
      // question is still open; a closed one comes back as a refusal.
      await this.remotePreflight(d, 'answer', { run: d.child?.uid ?? '', question, answer: d.answers.length + 1, text, from: ctx.by ?? '', by: ctx.by ?? '' })
      const r = await runOp(await runSpace(ws, ref), ref, { op: 'delegation.answer', delegation: id, question, text, ...(ctx.because ? { because: ctx.because } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) } as never, ctx)
      await this.remoteQueue(r.record.delegations![id])
      return r
    }
    if (d.child) {
      const child = await this.child(d)
      const q = child?.record.questions[question]
      if (q && ['taken-up', 'withdrawn'].includes(questionState(q))) throw new RequestError(409, `the child's ${question} is ${questionState(q)}; an answer is not sent to a closed question${questionEvent(d, question) ? '' : ''}`, { code: 'question-closed' })
    }
    const r = await runOp(await runSpace(ws, ref), ref, { op: 'delegation.answer', delegation: id, question, text, ...(ctx.because ? { because: ctx.because } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) } as never, ctx)
    await this.deliverSoon(r.record.delegations?.[id])
    return r
  }

  // cluster_teamwork p4: a recorded answer/instruction/correction of a
  // direct delegation is delivered at once when this process can; the
  // reconcile delivers whatever this misses.
  private async deliverSoon(d: Delegation | undefined): Promise<void> {
    if (!d || d.delivery !== 'direct' || d.target.instance) return
    await this.deliverOne(d.uid).catch(() => undefined)
  }

  // Judges the delegation (fix6): under the parent's lock, the result judged
  // is the latest one (or the one named, which must be it), its manifest the
  // one the caller assessed; `satisfied` is assessed first and refused with
  // the reminders unless `yes`. Correctness errors (a stale result, a result
  // returned for correction) are never passed with yes.
  async dispose(ws: Workspace, ref: RunRef, id: string, o: { disposition: string; note: string; event?: number; manifest?: string; yes?: boolean; advise?: boolean }, ctx: OpContext & { attempt?: string; receipt?: string }) {
    const space = await runSpace(ws, ref)
    const file = join(await inside(space.root, runDir(ref)), RUN_FILE)
    return withLock(file, async () => {
      const { record, d } = await this.parentDelegation(space, ref, id)
      const op = { op: 'delegation.dispose', delegation: id, disposition: o.disposition, note: o.note, ...(o.event !== undefined ? { event: o.event } : {}), ...(o.manifest ? { manifest: o.manifest } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) }
      const retransmitted = !!ctx.receipt && record.history.some(h => h.receipt === ctx.receipt)
      if (o.disposition === 'satisfied' && o.advise !== false && !o.yes && !retransmitted && !d.disposition) {
        const ev = o.event !== undefined ? d.events.find(e => e.n === o.event) : latestResult(d)
        const latest = latestResult(d)
        // Only a judgment the reducer would record is assessed; its own
        // refusal (stale, returned, closed) comes first.
        if (ev && ev.type === 'completed' && latest?.n === ev.n && (!o.manifest || o.manifest === ev.manifest?.digest) && !openRevisionOf(d)) {
          const a = await assessDelegation(this, record, d, ev)
          const rs = a ? assessmentReminders([a]) : []
          if (rs.length) throw new RequestError(409, reminderText(rs, `judging ${id} satisfied`), { code: 'reminder', boundaries: ['dispose'], reminders: rs, assessment: a })
        }
      }
      return runOpLocked(space, ref, op as never, ctx)
    }, { what: `run ${runKey(ref)}` })
  }

  // Returns the child's current completed result to the same child for
  // correction (fix6, `wfe delegate revise`). The reducer checks the result's
  // identity and the delegation's state under the parent's lock; WFE
  // delivers it to the child (deliverOne), which records it and continues.
  async revise(ws: Workspace, ref: RunRef, id: string, o: { instruction: string; reason: string; event?: number; manifest?: string; because?: BecauseRef; followUp?: string; reopen?: boolean; evidence?: string }, ctx: OpContext & { attempt?: string; receipt?: string }) {
    const { d } = await this.parentDelegation(ws, ref, id)
    if (d.target.instance) {
      const latest = latestResult(d)
      await this.remotePreflight(d, 'correction', { run: d.child?.uid ?? '', revision: (d.revisions?.length ?? 0) + 1, result: { seq: latest?.child.seq ?? 0, manifest: latest?.manifest?.digest ?? null }, instruction: o.instruction, reason: o.reason, from: ctx.by ?? '', by: ctx.by ?? '' })
    } else if (d.child) {
      const c = await this.child(d).catch(() => null)
      if (c?.record.cancelled) throw new RequestError(409, `the child ${d.child.workflow}/${d.child.run} is cancelled (${c.record.cancelled.reason}); a correction does not undo that`, { code: 'child-stopped' })
      if (c && c.record.control.attempt) throw new RequestError(409, `the child ${d.child.workflow}/${d.child.run} has attempt ${c.record.control.attempt.id} open; its result is not settled — wait for it to end`, { code: 'child-active' })
      if (c && c.record.execution.state !== 'completed' && !(c.record.corrections && Object.values(c.record.corrections).some(k => k.delegation?.uid === d.uid && !k.addressed))) throw new RequestError(409, `the child ${d.child.workflow}/${d.child.run} is ${c.record.execution.state} now, not completed; a correction returns a completed result`, { code: 'child-active' })
    }
    const r = await runOp(await runSpace(ws, ref), ref, { op: 'delegation.revise', delegation: id, instruction: o.instruction, reason: o.reason, ...(o.event !== undefined ? { event: o.event } : {}), ...(o.manifest ? { manifest: o.manifest } : {}), ...(o.because ? { because: o.because } : {}), ...(o.followUp ? { followUp: o.followUp } : {}), ...(o.reopen ? { reopen: true } : {}), ...(o.evidence ? { evidence: o.evidence } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) } as never, ctx)
    // A follow-up reopened a judged delegation (p17): its child's next
    // result is relayed again.
    const nd = r.record.delegations?.[id]
    if ((o.followUp || o.because || o.reopen) && nd) this.index(ws.reg.id, r.record, nd)
    if (nd?.target.instance) await this.remoteQueue(nd)
    else await this.deliverSoon(nd)
    return r
  }

  // What of a remote result can be verified here (improve_multinodes p2):
  // the commit it names is fetched from the repository it names into a
  // scratch repository, and each report/artifact the manifest records as in
  // that commit is read from it and hashed. A file the manifest records as
  // not committed, or committed elsewhere, cannot be verified by Git — its
  // hash is the child's claim. Nothing of the other installation is read
  // but its published Git content.
  // cluster_teamwork p2: and every shared output the result names, hashed
  // against this host's share.
  async verifyRemote(d: Delegation, ev = latestResult(d)): Promise<{ repository: string | null; commit: string | null; available: boolean; detail: string; files: { path: string; sha256: string; status: 'verified' | 'differs' | 'missing' | 'unverifiable'; detail: string }[]; outputs: { id: string; ref: string; manifest: string; status: 'verified' | 'altered' | 'missing' | 'unavailable'; detail: string }[] }> {
    const m = ev?.manifest
    if (!d.target.instance) throw new RequestError(409, `delegation ${d.id} is local; read its child's files with wfe delegate file`)
    if (!m) throw new RequestError(409, `delegation ${d.id} has no result with a manifest yet`)
    const sh = await import('./shares.ts')
    sh.setShareArea(this.ctx.area)
    const outputs: { id: string; ref: string; manifest: string; status: 'verified' | 'altered' | 'missing' | 'unavailable'; detail: string }[] = []
    for (const o of m.remote?.outputs ?? []) { const r = await sh.checkRemoteOutput(o); outputs.push({ id: o.id, ref: o.ref, manifest: o.manifest, status: r.status, detail: r.detail }) }
    return { ...await this.verifyRemoteGit(m), outputs }
  }
  private async verifyRemoteGit(m: NonNullable<ReturnType<typeof latestResult>>['manifest'] & object): Promise<{ repository: string | null; commit: string | null; available: boolean; detail: string; files: { path: string; sha256: string; status: 'verified' | 'differs' | 'missing' | 'unverifiable'; detail: string }[] }> {
    const rm = m.remote
    const files = [...(m.report ? [m.report] : []), ...m.artifacts]
    if (!rm?.repository || !rm.commit) return { repository: rm?.repository ?? null, commit: rm?.commit ?? null, available: false, detail: 'the result names no repository and commit: nothing can be verified here', files: files.map(f => ({ path: f.path, sha256: f.sha256, status: 'unverifiable' as const, detail: 'no commit named' })) }
    const { mkdtemp, rm: remove } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { spawnSync } = await import('node:child_process')
    const dir = await mkdtemp(join(tmpdir(), 'wfe-verify-'))
    try {
      await git(dir, ['init', '--bare', '-q'])
      const f = await git(dir, ['fetch', '-q', '--depth=1', rm.repository, rm.commit], { timeoutMs: 120_000 })
      const has = (await git(dir, ['cat-file', '-e', `${rm.commit}^{commit}`])).code === 0
      if (!has) return { repository: rm.repository, commit: rm.commit, available: false, detail: `commit ${rm.commit} could not be fetched from ${rm.repository}: ${(f.stderr || f.stdout || `git exited ${f.code}`).trim().slice(0, 300)}`, files: files.map(x => ({ path: x.path, sha256: x.sha256, status: 'unverifiable' as const, detail: 'the commit is not available' })) }
      const out = files.map(x => {
        if (!x.commit) return { path: x.path, sha256: x.sha256, status: 'unverifiable' as const, detail: 'recorded as not committed: its hash is the child\'s claim' }
        const at = x.commit
        const r = spawnSync('git', ['cat-file', 'blob', `${at}:${x.path}`], { cwd: dir, maxBuffer: 600 * 1024 * 1024 })
        if (r.status !== 0) return { path: x.path, sha256: x.sha256, status: at === rm.commit ? 'missing' as const : 'unverifiable' as const, detail: at === rm.commit ? `not in ${at.slice(0, 10)}` : `recorded in ${at.slice(0, 10)}, which was not fetched` }
        const h = sha256(r.stdout)
        return { path: x.path, sha256: x.sha256, status: h === x.sha256 ? 'verified' as const : 'differs' as const, detail: h === x.sha256 ? `in ${at.slice(0, 10)}, bytes match` : `in ${at.slice(0, 10)} the bytes hash to ${h.slice(0, 12)}` }
      })
      return { repository: rm.repository, commit: rm.commit, available: true, detail: `fetched ${rm.commit.slice(0, 10)} from ${rm.repository}`, files: out }
    } finally { await remove(dir, { recursive: true, force: true }) }
  }

  // A further instruction to the child (wfe delegate instruct): recorded on
  // the parent; delivered by WFE directly (deliverOne), or over the agdev
  // link to a remote child (improve_multinodes p2).
  async instruct(ws: Workspace, ref: RunRef, id: string, text: string, ctx: OpContext & { attempt?: string; because?: BecauseRef; receipt?: string }) {
    const { d } = await this.parentDelegation(ws, ref, id)
    if (d.target.instance) await this.remotePreflight(d, 'instruction', { run: d.child?.uid ?? '', instruction: d.instructions.length + 1, text, from: ctx.by ?? '', by: ctx.by ?? '' })
    const r = await runOp(await runSpace(ws, ref), ref, { op: 'delegation.instruct', delegation: id, text, ...(ctx.because ? { because: ctx.because } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) } as never, ctx)
    if (d.target.instance) await this.remoteQueue(r.record.delegations![id])
    else await this.deliverSoon(r.record.delegations![id])
    return r
  }

  // Cancels a remote child (improve_multinodes p2): asked over the link;
  // the other installation applies its ordinary cancellation and tells what
  // happened (applied, requested while an attempt stops, or refused — for a
  // run that completed first). A request not accepted yet is refused there.
  async cancelRemote(ws: Workspace, ref: RunRef, id: string, o: { reason: string; by: string }) {
    const { d } = await this.parentDelegation(ws, ref, id)
    if (!d.target.instance) throw new RequestError(409, `delegation ${id} is local; its child is cancelled on this host`)
    const { PeerStore, needPeerConfig } = await import('./peerlink.ts')
    if (!this.ctx.exec) throw new RequestError(409, 'a remote cancellation is sent where the executor\'s stores are (the coordinator)', { code: 'delegate-target' })
    const cfg = needPeerConfig(this.ctx.area)
    const link = new PeerStore({ area: this.ctx.area, registryFile: this.ctx.registryFile, exec: this.ctx.exec })
    try { return { delegation: d, ...link.cancelRemote(cfg, d, o) } } finally { link.close() }
  }

  // An operation to a remote child, before it is recorded: the peer applies
  // it, and its message fits the link. The remote record decides the rest.
  private async remotePreflight(d: Delegation, kind: 'answer' | 'instruction' | 'correction', body: Record<string, unknown>) {
    const { PeerStore, needPeerConfig } = await import('./peerlink.ts')
    const { peerOf } = await import('../shared/peers.ts')
    if (!this.ctx.exec) throw new RequestError(409, 'an operation to another installation is sent where the executor\'s stores are (the coordinator)', { code: 'delegate-target' })
    const cfg = needPeerConfig(this.ctx.area)
    const peer = peerOf(cfg, d.target.instance!)
    if (!peer) throw new RequestError(409, `instance ${d.target.instance} is not a configured peer of this installation`, { code: 'delegate-target' })
    const link = new PeerStore({ area: this.ctx.area, registryFile: this.ctx.registryFile, exec: this.ctx.exec })
    try {
      PeerStore.needCapability(link, peer, kind)
      // The size is checked with room for the names recorded beside the text.
      const pad = { ...body, from: `${String(body.from)}${'x'.repeat(80)}`, by: `${String(body.by)}${'x'.repeat(80)}` }
      PeerStore.checkSize(PeerStore.operationEnvelope(cfg, d, kind, Number(body[kind === 'correction' ? 'revision' : kind]), pad as never), `the ${kind === 'correction' ? 'correction' : kind}`)
    } finally { link.close() }
  }
  // Queues what the record now holds for a remote child (the pass repeats it).
  private async remoteQueue(d: Delegation): Promise<string[]> {
    if (!this.ctx.exec) return []
    const { PeerStore, loadPeerConfig } = await import('./peerlink.ts')
    const c = loadPeerConfig(this.ctx.area)
    if (!('config' in c)) return []
    const link = new PeerStore({ area: this.ctx.area, registryFile: this.ctx.registryFile, exec: this.ctx.exec })
    try { return link.ensureOperations(c.config, d) } catch { return [] } finally { link.close() }
  }

  async parentDelegation(ws: Workspace, ref: RunRef, id: string): Promise<{ record: RunRecord; d: Delegation }> {
    const record = (await readRun(await runSpace(ws, ref), ref)).record
    if (!record) throw new RequestError(409, `run ${runKey(ref)} cannot be read`)
    const d = record.delegations?.[id]
    if (!d) throw new RequestError(404, `run ${runKey(ref)} has no delegation ${id}${record.delegations ? ` (it has ${Object.keys(record.delegations).join(', ')})` : ''}`, { code: 'delegation-unknown' })
    return { record, d }
  }

  async child(d: Delegation): Promise<{ record: RunRecord; space: Workspace } | null> {
    if (!d.child) return null
    // A remote child's record is its installation's (improve_multinodes p1).
    if (d.child.instance) return null
    const cws = await this.workspace(d.child.workspace)
    const cref = { workflow: d.child.workflow, run: d.child.run }
    const space = await runSpace(cws, cref)
    const record = (await readRun(space, cref)).record
    if (!record) return null
    if (uidOf(record) !== d.child.uid) throw new RequestError(409, `the child ${runKey(cref)} in ${d.child.workspace} is another run now (${uidOf(record)}, bound ${d.child.uid})`)
    return { record, space }
  }

  // A file of the child's working copy, read for the parent's agent: inside
  // the child's copy, a regular file, and (when the delegation's events name
  // it) the bytes those events recorded.
  async childFile(d: Delegation, path: string): Promise<{ path: string; bytes: Buffer; sha256: string; expected: string | null }> {
    remoteFiles(d)
    const c = await this.child(d)
    if (!c) throw new RequestError(409, `delegation ${d.id} has no child yet`)
    const rel = normalizeRepoPath(path)
    if (!rel || rel === '.') throw new RequestError(400, `"${path}" is not a path inside the child's project`)
    const abs = await inside(c.space.root, rel)
    const st = await lstat(abs).catch(() => null)
    // A retired child's file: from its retained commit or archive, unchanged.
    const kept = !st && c.space.copyOf?.treeless ? await (await import('./retention.ts')).retainedFile(c.space, c.space.copyOf.ref, rel) : null
    if (kept) return this.withKnown(d, rel, kept)
    if (!st || !st.isFile() || st.isSymbolicLink() || !withinRoot(await realpath(c.space.root), await realpath(abs))) throw new RequestError(404, `${rel} is not a regular file of the child's working copy (${d.child!.workflow}/${d.child!.run})`)
    if (st.size > MAX_FILE) throw new RequestError(413, `${rel} is larger than ${MAX_FILE} bytes; use --out <file> to copy it`)
    return this.withKnown(d, rel, await readFile(abs))
  }

  private withKnown(d: Delegation, rel: string, bytes: Buffer) {
    const known = d.events.flatMap(e => [...(e.document ? [e.document] : []), ...(e.subject ?? []), ...(e.manifest ? [...(e.manifest.report ? [e.manifest.report] : []), ...e.manifest.artifacts] : [])]).filter(x => x.path === rel).at(-1)
    return { path: rel, bytes, sha256: sha256(bytes), expected: known?.sha256 ?? null }
  }

  // Copies a large file of the child to `out`, checked the same way.
  async copyChildFile(d: Delegation, path: string, out: string): Promise<{ path: string; sha256: string; bytes: number; expected: string | null }> {
    remoteFiles(d)
    const c = await this.child(d)
    if (!c) throw new RequestError(409, `delegation ${d.id} has no child yet`)
    const rel = normalizeRepoPath(path)
    if (!rel || rel === '.') throw new RequestError(400, `"${path}" is not a path inside the child's project`)
    const abs = await inside(c.space.root, rel)
    const st = await lstat(abs).catch(() => null)
    if (!st || !st.isFile() || st.isSymbolicLink()) throw new RequestError(404, `${rel} is not a regular file of the child's working copy`)
    const bytes = await readFile(abs)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(out, bytes, { flag: 'wx' })
    const known = d.events.flatMap(e => [...(e.subject ?? []), ...(e.manifest ? [...(e.manifest.report ? [e.manifest.report] : []), ...e.manifest.artifacts] : [])]).filter(x => x.path === rel).at(-1)
    return { path: rel, sha256: sha256(bytes), bytes: bytes.length, expected: known?.sha256 ?? null }
  }
}

function remoteFiles(d: Delegation) {
  if (!d.target.instance) return
  const m = latestResult(d)?.manifest?.remote
  throw new RequestError(409, `delegation ${d.id}'s child runs on another installation (${d.target.instance}); its files are not read here. ${m?.repository && m.commit ? `Fetch its commit with Git: git fetch ${m.repository} ${m.commit}, then git show ${m.commit}:<path>${m.published === false ? ' (the run reported that commit as not published yet)' : ''}; wfe delegate verify <run> ${d.id} checks the result's hashes against it` : 'Its result names the repository and commit once it completes'}`, { code: 'peer-files' })
}

// ---- assessing a result (fix6, shared/assessment.ts) ------------------------------

// Where the facts of a result are frozen: the first entry at or after the
// completing one after which no attempt of the child is open (the relay
// tells a completion once the attempt that completed it ended).
export function resultPosition(child: RunRecord, completingSeq: number): number {
  let open = false
  for (const h of child.history) {
    if (h.op === 'attempt.begin') open = true
    if (h.op === 'attempt.end') open = false
    if (h.seq >= completingSeq && !open) return h.seq
  }
  return child.seq
}

// The child's record as of a history position, replayed from its own history.
export function recordAt(child: RunRecord, seq: number): RunRecord | null {
  const g = child.definition.effective
  if (!g) return null
  if (seq >= child.seq) return child
  try {
    const history = child.history.slice(0, seq)
    return { ...replay(history, { nodes: g.nodes, edges: g.edges }).state, history }
  } catch { return null }
}

export async function assessDelegation(store: DelegateStore, parent: RunRecord, d: Delegation, ev = latestResult(d)): Promise<Assessment | null> {
  if (!ev) return null
  const unavailable: string[] = []
  let c: { record: RunRecord; space: Workspace } | null = null
  try { c = await store.child(d) } catch (e) { unavailable.push(`the child: ${(e as Error).message}`) }
  if (!c && !unavailable.length) unavailable.push(d.child?.instance ? `the child runs on installation ${d.child.instance}; its record and copy are not read here — judge from the returned commit${ev.manifest?.remote?.repository ? ` (${ev.manifest.remote.repository} ${ev.manifest.remote.commit ?? ''})` : ''}` : d.child ? `the child ${d.child.workflow}/${d.child.run} cannot be read on this host` : 'no child is bound')
  let frozen: RunRecord | null = null
  let authored: ChildEvidence['authored']
  let catalog: ChildEvidence['catalog'] = { state: 'none' }
  let changed: ChildEvidence['changed'] = null
  let removed: string[] = []
  let reportRefs: ChildEvidence['reportRefs'] = null
  if (c) {
    const reading = await readRun(c.space, { workflow: c.record.workflow, run: c.record.run })
    frozen = recordAt(c.record, resultPosition(c.record, ev.child.seq))
    if (!frozen) unavailable.push('the child\'s record as of the result does not replay')
    const active = frozen?.definition.active
    authored = (active ? reading.bundle.revisions?.find(r => r.revision === active)?.workflow : undefined) ?? reading.bundle.entries[c.record.definition.root]?.workflow
    catalog = catalogOf(c.record, reading.bundle)
    const paths = await changedPaths(c.space, c.record).catch(() => null)
    if (paths === null) unavailable.push('the child\'s working copy (its changed files) is not readable here')
    else {
      const by = pathsByNode(paths, frozen ?? c.record, (frozen ?? c.record).updated)
      changed = paths.map(p => ({ path: p.path, nodes: Object.entries(by).filter(([, ps]) => ps.includes(p.path)).map(([n]) => n) }))
      removed = paths.filter(p => p.mtime === null).map(p => p.path)
    }
    if (ev.manifest?.report) reportRefs = await namedPaths(c.space.root, c.record, ev.manifest.report.path).catch(() => null)
  }
  let remote: { corrections: boolean } | undefined
  if (d.target.instance && store.ctx.exec) {
    const { PeerStore } = await import('./peerlink.ts')
    const link = new PeerStore({ area: store.ctx.area, registryFile: store.ctx.registryFile, exec: store.ctx.exec })
    try { remote = { corrections: link.capabilitiesOf(d.target.instance).capabilities.includes('correction') } } catch { remote = { corrections: false } } finally { link.close() }
  }
  // cluster_teamwork p2: the outputs the remote result names, against this host's share (bounded).
  let remoteOutputs: { id: string; status: 'verified' | 'altered' | 'missing' | 'unavailable'; detail: string }[] | undefined
  if (ev.manifest?.remote?.outputs?.length) {
    const sh = await import('./shares.ts')
    sh.setShareArea(store.ctx.area)
    // cluster_teamwork p3: one budget for all of them, not a sum of waits.
    const { withinBudget } = await import('./shareProbe.ts')
    const list = ev.manifest.remote.outputs.slice(0, 20)
    const found: typeof remoteOutputs = list.map(o => ({ id: o.id, status: 'unavailable', detail: `${o.ref}: not checked within the view's budget (the share does not answer here; that says nothing about the output)` }))
    await withinBudget((async () => { for (const [k, o] of list.entries()) { const r = await sh.checkRemoteOutput(o, { quick: true }); found[k] = { id: o.id, status: r.status, detail: r.detail } } })(), () => undefined)
    remoteOutputs = found.map(x => ({ ...x }))
  }
  return assessResult(parent, d, ev, { frozen, graph: frozen ? graphOfState(frozen) ?? null : null, authored, now: c?.record ?? null, catalog, changed, removed, reportRefs, unavailable, ...(remote ? { remote } : {}), ...(remoteOutputs ? { remoteOutputs } : {}) })
}

// The paths a report names in backticks, and those that are not in the
// child's copy (tidy p2: "are the report and referenced artifacts present at
// the stated locations?"). Only names with a folder in them count: a bare
// filename, a URL, a share reference, a pattern or a placeholder is not a
// path to look up. A name may be relative to the copy's root or to the run
// folder. A missing one is something to look at, not a defect: it may have
// moved on purpose or belong to another project.
const NAMED = /`([^`\s]+)`/g
export async function namedPaths(root: string, child: RunRecord, report: string): Promise<{ named: number; missing: string[] }> {
  const text = await readFile(await inside(root, report), 'utf8')
  const names = new Set<string>()
  for (const m of text.matchAll(NAMED)) {
    const p = m[1].replace(/[.,:;)]+$/, '').replace(/:\d+(-\d+)?$/, '').replace(/\/$/, '')
    if (!p.includes('/') || p.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(p) || /^(\/|~|\.\.)/.test(p) || /[*?<>{}$|=]/.test(p) || p.includes('…')) continue
    names.add(p)
    if (names.size >= 200) break
  }
  const missing: string[] = []
  const folder = runDir({ workflow: child.workflow, run: child.run })
  for (const p of names) {
    const here = async (rel: string) => { try { return !!(await lstat(await inside(root, rel))) } catch { return false } }
    if (!(await here(p)) && !(await here(join(folder, p)))) missing.push(p)
  }
  return { named: names.size, missing }
}

// The reminders of every delegated result a run reports (fix6): each
// delegation's latest result, open or judged satisfied; a repaired omission
// (a corrected result) is assessed anew and its old warning is gone.
export async function delegatedReminders(store: DelegateStore, parent: RunRecord): Promise<ReturnType<typeof assessmentReminders>> {
  const out: Assessment[] = []
  for (const d of Object.values(parent.delegations ?? {})) {
    if (d.disposition && d.disposition.kind !== 'satisfied') continue
    if (d.closed && !d.disposition) continue
    const a = await assessDelegation(store, parent, d).catch(() => null)
    if (a) out.push(a)
  }
  return assessmentReminders(out)
}

// A run's delegations for the views (p10): each with its state and its
// child's situation now; for a child, the delegation it came from.
export async function delegationsView(store: DelegateStore, ws: Workspace, ref: RunRef) {
  const { delegationState } = await import('../shared/delegation.ts')
  const { holderOf, situation } = await import('../shared/run.ts')
  const { runStatus } = await import('../shared/status.ts')
  const rec = (await readRun(await runSpace(ws, ref), ref)).record
  if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be read`)
  {
    const delegations = []
    for (const d of Object.values(rec.delegations ?? {})) {
      const c = await store.child(d).catch(() => null)
      // fix6: the latest result's assessment, beside the delegation.
      const assessment = latestResult(d) ? await assessDelegation(store, rec, d).catch(() => null) : null
      // improve_multinodes p1: a remote delegation's delivery and acceptance as the link knows them.
      let link = null
      if (d.target.instance && store.ctx.exec) {
        const { PeerStore, selfInstance } = await import('./peerlink.ts')
        const self = selfInstance(store.ctx.area)
        if (self) { const s = new PeerStore({ area: store.ctx.area, registryFile: store.ctx.registryFile, exec: store.ctx.exec }); try { link = s.linkOf(d, self) } finally { s.close() } }
      }
      delegations.push({
        ...d, state: delegationState(d), pending: pendingEvents(d).map(e => e.n), assessment, ...(link ? { link } : {}),
        childNow: c ? { situation: situation(c.record), execution: c.record.execution.state, seq: c.record.seq, waiting: c.record.execution.waiting.map(w => ({ node: w.node, holder: holderOf(c.record, w.node) })), decisions: c.record.decisions.length, hold: c.record.control.hold?.kind ?? null, status: runStatus(c.record) } : null,
      })
    }
    // The parent's own reading with its children as they are now (p8 ex1).
    const status = runStatus(rec, { children: Object.fromEntries(delegations.filter(d => d.childNow).map(d => [d.id, { situation: d.childNow!.situation, hold: d.childNow!.hold, execution: d.childNow!.execution, run: d.child?.run ?? null }])) })
    const ent = rec.input.entrustedBy
    // A child names its parent; the parent's workspace here, for a link.
    const parentWs = ent?.kind === 'delegation' ? (await loadRegistry(store.ctx.registryFile)).workspaces.find(w => holdsProject(w, ent.parent.project))?.id ?? null : null
    return { ref: runKey(ref), delegations, status, parent: ent?.kind === 'delegation' ? { ...ent, workspace: parentWs } : null }
  }
}
