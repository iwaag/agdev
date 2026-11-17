// Asking the summoner from the one field (user_catalog p7, docs/mycatalog.md *Asking*).
//
// The text of the field, asked instead of put in: an unfinished braindump, an
// instruction or a question. The summoner's workflow `ask` answers in words
// and may propose a few actions from a fixed list. An action is a line under
// the answer; nothing is done before the owner presses *Do it*, and the
// service carries it out through the writer that exists, not the run. The
// text and the answer are kept outside Git beside the draft
// (server/catalogDrafts.ts); the one action that puts the text into Git is the
// hand-over, and its line says so.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isBraindumpId, normalizeTag } from '../shared/catalog.ts'
import { archiveBraindumps, archivedAt, catalogSnapshot, moveBraindump, setTags, upkeepRequest, type CatalogContext } from './catalog.ts'
import { createDraft, adviceRequest, failAdvice, putAdvice, readDraft, recordAdviceRun, saveDraft, updateAsk, type Advice, type AskAction, type AskKind, type TagSuggestion } from './catalogDrafts.ts'
import { linksRequest } from './catalogLinks.ts'
import { adoptRule, CATALOG_TARGET, checkRuleSource, followsWords, publicationRequest, retireRule, rules } from './catalogRules.ts'
import { loadRegistry } from './registry.ts'
import { loadRoles } from './summon.ts'
import { RequestError } from './workspace.ts'

export const ASK_ACTIONS = ['suggest-links', 'review', 'index', 'tags', 'rename', 'archive', 'use-text', 'adopt-rule', 'retire-rule', 'hand-over', 'publish'] as const
export const ASK_KINDS: AskKind[] = ['braindump', 'instruction', 'question']
export const HANDOVER_WORKFLOW = 'freework'
const MAX_ACTIONS = 8
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string' ? v.trim() : ''
const exists = (p: string) => stat(p).then(() => true, () => false)
const hrefOf = (ws: string, wf: string, run: string) => `#/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(wf)}/${encodeURIComponent(run)}`

// Who receives a hand-over: the project that holds the facilitation role, through its workflow freework.
export async function handOverTarget(ctx: CatalogContext): Promise<{ project: string; workspace: string; workflow: string }> {
  const holder = (await loadRoles(ctx.area))?.roles.facilitation
  if (!holder) throw new RequestError(409, 'no project holds the facilitation role here (wfe summon status): there is nobody to hand the text to')
  const ws = (await loadRegistry(ctx.registryFile)).workspaces.find(w => w.id === holder.workspace)
  if (!ws) throw new RequestError(409, `the facilitation role's workspace ${holder.workspace} is not registered here`)
  // A workspace is the folder that holds the project's source/ checkout.
  if (!await exists(join(ws.path, 'source', 'devdocs', 'workflows', `${HANDOVER_WORKFLOW}.yaml`)) && !await exists(join(ws.path, 'devdocs', 'workflows', `${HANDOVER_WORKFLOW}.yaml`))) throw new RequestError(409, `${holder.project} has no workflow ${HANDOVER_WORKFLOW} to receive a request`)
  return { project: holder.project, workspace: ws.id, workflow: HANDOVER_WORKFLOW }
}

// The actions of an answer, checked when it is written: one outside the list, or one that could not be carried out as written, refuses the whole answer.
export async function checkActions(ctx: CatalogContext, raw: unknown, o: { rewrite: boolean }): Promise<AskAction[]> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new RequestError(400, 'actions: a JSON list of {"do": "…", …}')
  if (raw.length > MAX_ACTIONS) throw new RequestError(400, `at most ${MAX_ACTIONS} actions under one answer; propose the few that matter`)
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  const problems: string[] = []
  const out: AskAction[] = []
  const braindump = (x: Record<string, unknown>, at: string): string | null => {
    const id = str(x.braindump).replace(/^\/+|\/+$/g, '')
    if (!snap.braindumps.some(b => b.id === id)) { problems.push(`${at}: no braindump "${id}" in the catalog at ${snap.head.slice(0, 7)}`); return null }
    return id
  }
  for (const [i, x] of raw.entries()) {
    const at = `action ${i + 1}`
    if (!isObj(x)) { problems.push(`${at}: not an object`); continue }
    const what = str(x.do)
    const base = { do: what, ...(str(x.why) ? { why: str(x.why).slice(0, 600) } : {}), state: 'proposed' as const }
    try {
      if (what === 'suggest-links' || what === 'index') out.push(base)
      else if (what === 'review') { if (str(x.braindump)) { const id = braindump(x, at); if (id) out.push({ ...base, braindump: id }) } else out.push(base) }
      else if (what === 'tags') {
        const changes: TagSuggestion[] = []
        for (const c of Array.isArray(x.changes) ? x.changes as unknown[] : []) {
          const n = isObj(c) && (c.op === 'add' || c.op === 'remove') ? normalizeTag(str(c.tag)) : { problem: 'op is "add" or "remove"' }
          if ('problem' in n) { problems.push(`${at}: ${n.problem}`); continue }
          changes.push({ op: (c as { op: 'add' | 'remove' }).op, tag: n.tag, reason: str((c as Record<string, unknown>).reason).slice(0, 2000) })
        }
        if (!changes.length) { problems.push(`${at}: tags needs changes: [{"op": "add"|"remove", "tag", "reason"}]`); continue }
        if (str(x.braindump)) { const id = braindump(x, at); if (id) out.push({ ...base, braindump: id, changes }) } else out.push({ ...base, changes })
      } else if (what === 'rename') {
        const id = braindump(x, at), to = str(x.to).replace(/^\/+|\/+$/g, '')
        if (!id) continue
        if (!isBraindumpId(to) || to === id) { problems.push(`${at}: "${to}" is not a new braindump path`); continue }
        if (snap.braindumps.some(b => b.id === to)) { problems.push(`${at}: the path ${to} is taken`); continue }
        if ((await archivedAt(ctx, to)).length) { problems.push(`${at}: an archived braindump held the path ${to}; choose another`); continue }
        out.push({ ...base, braindump: id, to })
      } else if (what === 'archive') { const id = braindump(x, at); if (id) out.push({ ...base, braindump: id }) }
      else if (what === 'use-text') { if (!o.rewrite) problems.push(`${at}: use-text needs the proposed text (--rewrite)`); else out.push(base) }
      else if (what === 'adopt-rule') { const r = await checkRuleSource(ctx, x); out.push({ ...base, ...('tag' in r ? { tag: r.tag } : {}), ...('project' in r ? { project: r.project } : {}), ...('licence' in r ? { licence: r.licence } : {}), follows: r.follows, source: r.source }) }
      else if (what === 'retire-rule') {
        const cur = await rules(ctx)
        if (!cur.rules.some(r => r.id === str(x.rule))) problems.push(`${at}: no rule "${str(x.rule)}" (${cur.rules.map(r => r.id).join(', ') || 'no rule is adopted'})`)
        else out.push({ ...base, rule: str(x.rule) })
      } else if (what === 'hand-over') {
        if (out.some(y => y.do === 'hand-over')) { problems.push(`${at}: one hand-over at most`); continue }
        const t = await handOverTarget(ctx)
        out.push({ ...base, target: { workspace: t.workspace, workflow: t.workflow } })
      } else if (what === 'publish') {
        // p8: ask the publisher to publish the catalog (no project, or mycatalog) or a project; a private project is refused here.
        const r = await publicationRequest(ctx, { target: str(x.project) || CATALOG_TARGET })
        out.push({ ...base, publishTarget: r.target })
      } else problems.push(`${at}: "${what}" is not an action. The list: ${ASK_ACTIONS.join(', ')}. What fits none of them is answered in words only`)
    } catch (e) { if (e instanceof RequestError) problems.push(`${at} (${what}): ${e.message}`); else throw e }
  }
  if (problems.length) throw new RequestError(400, `the answer was not taken; nothing was kept:\n${problems.map(p => `  ${p}`).join('\n')}`)
  return out
}

// The run's answer: words, the kind it read the text as, and the proposed actions.
export async function answerAsk(ctx: CatalogContext, draft: string, ask: string, o: { text: string; kind?: string; actions?: unknown; rewrite?: string; by: string; head?: string; read?: string }) {
  if (!o.kind || !(ASK_KINDS as string[]).includes(o.kind)) throw new RequestError(400, `--kind says what the text is: ${ASK_KINDS.join(', ')}`)
  const actions = await checkActions(ctx, o.actions, { rewrite: !!o.rewrite?.trim() })
  return putAdvice(ctx, draft, ask, { text: o.text, rewrite: o.rewrite, by: o.by, head: o.head, read: o.read, kind: o.kind as AskKind, actions })
}

// What the line of an action says (the page and the CLI show the same words).
export function actionWords(a: AskAction): string {
  const tags = (a.changes ?? []).map(c => `${c.op === 'add' ? '+' : '−'}${c.tag}`).join(' ')
  switch (a.do) {
    case 'suggest-links': return 'Have the summoner suggest which braindump grounds which project.'
    case 'review': return a.braindump ? `Have the summoner review “${a.braindump}”.` : 'Have the summoner review the braindumps that are due.'
    case 'index': return 'Have the summoner rewrite the list of what is not yet real.'
    case 'tags': return a.braindump ? `Tags of “${a.braindump}”: ${tags}` : `Tags of this text: ${tags}`
    case 'rename': return `Rename “${a.braindump}” to “${a.to}”.`
    case 'archive': return `Archive “${a.braindump}”: it is kept to be read and is no braindump any more.`
    case 'use-text': return 'Use the rewritten text as your text. Nothing is put in the catalog by it.'
    case 'adopt-rule': return `Adopt a rule: ${followsWords({ tag: a.tag, project: a.project, licence: a.licence, follows: a.follows ?? '' })}. From “${a.source!.braindump}”: “${a.source!.sentence}”`
    case 'publish': return a.publishTarget === CATALOG_TARGET ? 'Ask the publisher to publish the catalog (what its public list selects).' : `Ask the publisher to publish ${a.publishTarget}.`
    case 'retire-rule': return `Retire the rule ${a.rule}.`
    case 'hand-over': return `Hand this text to ${a.target?.workspace ?? 'the facilitating project'} as a request for work. Your text will be in that run's request, in Git.`
    default: return a.do
  }
}

type Requester = (o: { workspace: string; workflow: string; text: string; author: string; receipt: string; node?: string }) => Promise<{ ref: { workflow: string; run: string }; duplicate?: boolean }>

// *Do it*: the service carries the action out, in the owner's name. A refusal of the writer marks the action failed with the reason; it can be pressed again.
export async function doAction(ctx: CatalogContext, draft: string, ask: string, n: number, o: { by: string; request: Requester }) {
  const by = o.by.trim()
  if (!by) throw new RequestError(400, 'doing an action needs your name: it is done in your name')
  const cur = await readDraft(ctx, draft)
  const a0 = cur.advice.find(x => x.id === ask)
  const act0 = a0?.actions?.[n - 1]
  if (!a0 || !act0) throw new RequestError(404, `ask ${ask} has no action ${n}`)
  if (act0.state === 'done' || act0.state === 'declined') throw new RequestError(409, `action ${n} was already ${act0.state}`)
  const requested = async (r: { workspace: string; workflow: string; text: string; receipt: string }, what: string) => {
    const q = await o.request({ ...r, author: by })
    return { message: `${q.duplicate ? 'Already asked' : 'Asked'}: ${what} (${r.workspace}/${q.ref.workflow}/${q.ref.run}).`, href: hrefOf(r.workspace, q.ref.workflow, q.ref.run) }
  }
  let result: { message: string; commit?: string; href?: string }
  let ok = true
  try {
    const a = act0
    if (a.do === 'suggest-links') result = await requested(await linksRequest(ctx, { by }), 'the summoner suggests links')
    else if (a.do === 'review') result = await requested(await upkeepRequest(ctx, { kind: 'review', id: a.braindump }), a.braindump ? `a review of ${a.braindump}` : 'the reviews that are due')
    else if (a.do === 'index') result = await requested(await upkeepRequest(ctx, { kind: 'index' }), 'the index')
    else if (a.do === 'tags' && a.braindump) {
      const r = await setTags(ctx, { id: a.braindump, add: a.changes!.filter(c => c.op === 'add').map(c => c.tag), remove: a.changes!.filter(c => c.op === 'remove').map(c => c.tag), author: by, trailer: `Proposed by ${a0.written?.by ?? 'the summoner'} in an answer (${ask}); accepted by ${by}.` })
      result = { message: r.message, commit: r.commit }
    } else if (a.do === 'tags') {
      let next = [...cur.draft.tags]
      for (const c of a.changes!) next = c.op === 'add' ? (next.some(t => t.toLowerCase() === c.tag.toLowerCase()) ? next : [...next, c.tag]) : next.filter(t => t.toLowerCase() !== c.tag.toLowerCase())
      await saveDraft(ctx, draft, { tags: next, base: cur.current, by })
      result = { message: `Tags of this text: ${next.join(', ') || 'none'}.` }
    } else if (a.do === 'rename') { const r = await moveBraindump(ctx, { from: a.braindump!, to: a.to!, author: by }); result = { message: r.message, commit: r.commit } }
    else if (a.do === 'archive') { const r = await archiveBraindumps(ctx, { id: a.braindump!, author: by, note: `Archived from an answer of the summoner (${ask}).` }); result = { message: r.message, ...(r.commit ? { commit: r.commit } : {}) } }
    else if (a.do === 'use-text') {
      if (!a0.rewrite) throw new RequestError(409, 'this answer has no rewritten text')
      await saveDraft(ctx, draft, { text: a0.rewrite, base: cur.current, by })
      result = { message: 'The rewritten text is your text now; the one before is the earlier version. Nothing was put in the catalog.' }
    } else if (a.do === 'adopt-rule') { const r = await adoptRule(ctx, { tag: a.tag, project: a.project, licence: a.licence, follows: a.follows, source: a.source, author: by, proposedBy: a0.written?.by }); result = { message: r.message, commit: r.commit } }
    else if (a.do === 'publish') result = await requested(await publicationRequest(ctx, { target: a.publishTarget, by }), `the publisher publishes ${a.publishTarget === CATALOG_TARGET ? 'the catalog' : a.publishTarget}`)
    else if (a.do === 'retire-rule') { const r = await retireRule(ctx, { id: a.rule!, author: by }); result = { message: r.message, commit: r.commit } }
    else if (a.do === 'hand-over') {
      const t = await handOverTarget(ctx)
      const text = (await readDraft(ctx, draft, { revision: a0.revision })).draft.text
      result = await requested({ workspace: t.workspace, workflow: t.workflow, text, receipt: `catalog-handover-${ask}` }, `${t.project} was handed the text as a request`)
    } else throw new RequestError(400, `"${a.do}" is not an action`)
  } catch (e) {
    if (!(e instanceof RequestError)) throw e
    ok = false
    result = { message: e.message }
  }
  const next = await updateAsk(ctx, draft, ask, async a => {
    const actions = [...(a.actions ?? [])]
    actions[n - 1] = { ...actions[n - 1], state: ok ? 'done' : 'failed', result: { at: new Date().toISOString(), by, ...result } }
    const next: Advice = { ...a, actions }
    return { next, out: next }
  })
  return { ok, message: ok ? result.message : `Not done: ${result.message}`, action: next.actions![n - 1], advice: next, ...(result.commit ? { commit: result.commit } : {}), ...(result.href ? { href: result.href } : {}) }
}

export async function declineAction(ctx: CatalogContext, draft: string, ask: string, n: number, o: { by: string }) {
  if (!o.by.trim()) throw new RequestError(400, 'answering an action needs your name')
  const next = await updateAsk(ctx, draft, ask, async a => {
    const actions = [...(a.actions ?? [])]
    if (!actions[n - 1]) throw new RequestError(404, `ask ${ask} has no action ${n}`)
    if (actions[n - 1].state === 'done') throw new RequestError(409, `action ${n} was already done`)
    actions[n - 1] = { ...actions[n - 1], state: 'declined', result: { at: new Date().toISOString(), by: o.by.trim(), message: 'Declined.' } }
    const next: Advice = { ...a, actions }
    return { next, out: next }
  })
  return { ok: true, message: `Action ${n} was declined; nothing was done.`, advice: next }
}

// Asking: the text is saved as it is on the screen (a new draft when it has none), frozen, and the summoner's `ask` is queued on the local worker.
export async function ask(ctx: CatalogContext, o: { draft?: string; base?: number; text?: string; by: string; request: Requester }) {
  const by = o.by.trim()
  if (!by) throw new RequestError(400, 'asking needs your name')
  let id = o.draft, base = o.base
  if (!id) {
    if (!o.text?.trim()) throw new RequestError(400, 'write what you ask first')
    const d = await createDraft(ctx, { text: o.text, by })
    id = d.draft.id; base = d.draft.revision
  } else if (o.text !== undefined) { const s = await saveDraft(ctx, id, { text: o.text, base: base ?? -1, by }); base = s.draft.revision }
  const r = await adviceRequest(ctx, id, { base: base ?? -1, by })
  if (r.existing) return { ok: true, duplicate: true, message: `Already asked: the summoner is still reading this text (${r.advice.run ? `${r.advice.run.workflow}/${r.advice.run.run}` : 'queued'}).`, advice: r.advice, draft: id, href: r.advice.run?.href ?? '' }
  try {
    const q = await o.request({ workspace: r.workspace, workflow: r.workflow, text: r.text, author: by, receipt: r.receipt, node: r.node })
    const href = hrefOf(r.workspace, q.ref.workflow, q.ref.run)
    const advice = await recordAdviceRun(ctx, id, r.advice.id, { workspace: r.workspace, workflow: q.ref.workflow, run: q.ref.run, href })
    return { ok: true, duplicate: false, message: `Asked the summoner (${r.workspace}/${q.ref.workflow}/${q.ref.run}). Its answer is kept beside the text, outside Git.`, advice, draft: id, href }
  } catch (e) {
    await failAdvice(ctx, id, r.advice.id, { reason: `not asked: ${(e as Error).message}`, by }).catch(() => undefined)
    throw e
  }
}
