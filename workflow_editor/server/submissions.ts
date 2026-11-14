// Machine submissions (cluster_teamwork p4, docs/submissions.md): a
// requester on this installation that is not a person — Observer asking a
// recovery agent — opens a run of a workflow through WFE itself, durably and
// idempotently.
//
// - Who may submit what: <area>/submitters.json `{version: 1, submitters:
//   [{name, workflows: ["<project>/<workflow>"]}]}`, and nothing else:
//   without that file nobody may submit.
// - Identity: the receipt `submission:<requester>:<key>`, where the key is
//   the requester's own (Observer: `<incident>:<assignment>`). The same
//   receipt is the same run, however often it is submitted; another key is
//   another run.
// - The run: an ordinary `request` input (requester, entrustedBy note, the
//   source {kind: submission, requester, receipt, at, about}), started by the
//   execution queue (job receipt `request:<receipt>`).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acceptsRequests } from '../shared/model.ts'
import type { ExecStore } from './exec.ts'
import { creationOf } from './observe.ts'
import { readRun } from './runs.ts'
import { runSpace } from './runspace.ts'
import { runUid } from '../shared/run.ts'
import { RequestError, type Workspace } from './workspace.ts'
import type { JobRow } from './exec.ts'

export interface Submitter { name: string; workflows: string[] }
const NAME = /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/
const KEY = /^[A-Za-z0-9:._/#-]{1,120}$/
const TARGET = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/

export function loadSubmitters(area: string): Submitter[] {
  const file = join(area, 'submitters.json')
  if (!existsSync(file)) return []
  let raw: { version?: unknown; submitters?: unknown }
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new RequestError(503, `${file}: ${(e as Error).message}`, { code: 'submission-config' }) }
  if (raw.version !== 1 || !Array.isArray(raw.submitters)) throw new RequestError(503, `${file} is {version: 1, submitters: [{name, workflows}]}`, { code: 'submission-config' })
  return (raw.submitters as { name?: unknown; workflows?: unknown }[]).filter(s => typeof s?.name === 'string' && Array.isArray(s.workflows))
    .map(s => ({ name: s.name as string, workflows: (s.workflows as unknown[]).filter((w): w is string => typeof w === 'string' && TARGET.test(w)) }))
}

export const submissionReceipt = (requester: string, key: string) => `submission:${requester.replace(/[^A-Za-z0-9._-]/g, '_')}:${key}`

export interface SubmissionView { receipt: string; requester: string; workspace: string; workflow: string; run: string; uid: string | null; job: number; duplicate: boolean }

export async function submit(exec: ExecStore, o: { requester: string; workflow: string; key: string; text: string; about?: string; workspace?: string }): Promise<SubmissionView> {
  if (!NAME.test(o.requester)) throw new RequestError(400, 'requester is the submitter\'s name (as submitters.json names it)', { code: 'submission-shape' })
  if (!TARGET.test(o.workflow)) throw new RequestError(400, 'workflow is <project>/<workflow>', { code: 'submission-shape' })
  if (!KEY.test(o.key)) throw new RequestError(400, 'key is the submitter\'s own identity of this submission (1–120 of A-Z a-z 0-9 : . _ / # -)', { code: 'submission-shape' })
  if (!o.text.trim()) throw new RequestError(400, 'the submission has no text', { code: 'submission-shape' })
  const who = loadSubmitters(exec.ctx.area).find(s => s.name === o.requester)
  if (!who) throw new RequestError(403, `${o.requester} may submit nothing here (submitters.json)`, { code: 'submission-not-permitted' })
  if (!who.workflows.includes(o.workflow)) throw new RequestError(403, `${o.requester} may submit to ${who.workflows.join(', ') || 'nothing'} here, not ${o.workflow} (submitters.json)`, { code: 'submission-not-permitted' })
  const [project, workflow] = o.workflow.split('/')
  const receipt = submissionReceipt(o.requester, o.key)
  const ws: Workspace = o.workspace ? await exec.workspace(o.workspace) : await exec.delegate.targetWorkspace(project)
  if (ws.reg.project !== project) throw new RequestError(409, `workspace ${ws.reg.id} holds ${ws.reg.project}, not ${project}`, { code: 'submission-target' })
  const summary = (await ws.workflowSummaries()).list.find(s => s.id === workflow)
  if (!summary) throw new RequestError(409, `project ${project} has no workflow ${workflow} here`, { code: 'submission-target' })
  const tw = await ws.workflowResponse(summary.file)
  if (!tw.workflow || !acceptsRequests(tw.workflow)) throw new RequestError(409, `${o.workflow} takes no requests here`, { code: 'submission-target' })
  const at = new Date().toISOString()
  const r = await exec.request({
    workspace: ws.reg.id, workflow, text: o.text, author: o.requester, receipt, by: o.requester, via: 'submission',
    input: { from: 'agent', text: o.text, requester: o.requester, entrustedBy: { kind: 'note', text: o.about ? `${o.requester}: ${o.about}` : `${o.requester}'s submission ${receipt}` }, source: { kind: 'submission', requester: o.requester, receipt, at, ...(o.about ? { about: o.about.slice(0, 300) } : {}) } } as never,
  })
  return { ...await viewOf(exec, receipt, r.job), duplicate: r.duplicate }
}

// The run a receipt is bound to (the acknowledgement), or 404.
// `known`: the job the request returned (a run first started under another receipt has no job of this one).
export async function viewOf(exec: ExecStore, receipt: string, known?: JobRow): Promise<SubmissionView> {
  const job = exec.jobByReceipt(`request:${receipt}`) ?? known
  if (!job) throw new RequestError(404, `no submission ${receipt} was received here`, { code: 'submission-unknown' })
  const ws = await exec.workspace(job.workspace)
  const ref = { workflow: job.workflow, run: job.run }
  const rec = (await readRun(await runSpace(ws, ref), ref).catch(() => null))?.record ?? null
  const requester = receipt.split(':')[1] ?? ''
  return { receipt, requester, workspace: job.workspace, workflow: job.workflow, run: job.run, uid: rec ? runUid(rec, creationOf(rec)) : null, job: job.id, duplicate: true }
}
