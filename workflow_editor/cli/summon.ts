// `wfe summon` (summoner p2, docs/summon.md): a summonplan's projects arrive in
// this installation. The same module the service's api/summon routes use.
import type { SummonContext, SummonStep } from '../server/summon.ts'

export const SUMMON_HELP = `wfe summon apply [<plan>] [--dry-run] [--yes]
wfe summon status [<plan>]
wfe summon acquire <source> <commit> [--name <local name>] [--project <id> --register] [--dry-run]

apply      make this installation match a summonplan of its mind repository
           (default: the plan mind.json names). Shows per entry what will
           change (acquire, move, register, obtain, role, deploy, nothing),
           then with --yes (or an answer at the prompt) performs it: summoned
           entries are acquired from their source into this Gitea at their
           commit with their history and submodules (fast-forward only),
           registered, and given a workspace; roles are recorded in
           <area>/roles.json and the keys they own in workers.json,
           conversations.json and submitters.json are derived from it;
           role deployments run. adopted entries are never fetched. An
           interrupted apply continues where it stopped.
status     per entry: the plan's commit against the present one, the
           upstream recorded, the roles in effect, and whether it is applied
acquire    one repository (and its submodules) into this Gitea, without a
           plan: <owner>/<name from the URL, or --name>; --register also
           registers it as project --project`

export interface SummonCli {
  positional: string[]
  opt: (k: string) => string | undefined
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string) => Error
  ctx: () => Promise<SummonContext>
  confirm: (question: string) => Promise<boolean>
}

const mark: Record<SummonStep['status'], string> = { done: 'done  ', kept: 'kept  ', would: 'would ', refused: 'REFUSE', failed: 'FAILED' }
export const stepLines = (steps: SummonStep[], indent = '  ') => steps.map(s => `${indent}${mark[s.status]} ${s.name}: ${s.detail}`)

const short = (x?: string | null) => (x ? x.slice(0, 10) : '—')
type Report = Awaited<ReturnType<typeof import('../server/summon.ts').apply>>
function applyText(r: Report): string {
  const lines = [r.message, ...(r.continued ? [`(continues the apply started ${r.continued})`] : []), '']
  for (const e of r.entries) {
    lines.push(`${e.project} [${e.state}] ${e.actions.length ? e.actions.join(', ') : 'nothing'}${e.status === 'refused' || e.status === 'failed' ? ` — ${e.status.toUpperCase()}` : ''}`)
    lines.push(...stepLines(e.steps.filter(s => s.status !== 'kept' || e.status !== 'nothing'), '    '))
  }
  lines.push('', `roles${r.roles.changed ? (r.dryRun ? ' (would change)' : ' (written)') : ' (unchanged)'}:`, ...Object.entries(r.roles.roles).map(([k, h]) => `  ${k}: ${h!.project}${h!.workflow ? `/${h!.workflow}` : ''} (workspace ${h!.workspace})`), ...r.roles.problems.map(p => `  problem: ${p}`))
  for (const f of r.files) lines.push(`${f.file}: ${f.changed ? `${r.dryRun ? 'would change' : 'changed'} ${f.keys.join(', ')}` : f.keys.length ? f.keys.join(', ') : 'unchanged'}`)
  if (r.deployments.length) lines.push('deployments:', ...stepLines(r.deployments))
  if (r.observer && !r.dryRun) lines.push(`observer: ${r.observer}`)
  return lines.join('\n')
}

export async function summonCommand(c: SummonCli): Promise<number> {
  const s = await import('../server/summon.ts')
  const { RequestError } = await import('../server/workspace.ts')
  const [sub, a1, a2] = c.positional
  const ctx = await c.ctx()
  try {
    if (sub === 'acquire') {
      if (!a1 || !a2) throw c.usage('wfe summon acquire <source> <commit> [--name <n>] [--project <id> --register]')
      const r = await s.acquireOne(ctx, { url: a1, commit: a2, name: c.opt('name'), project: c.opt('project'), register: c.flag('register'), dry: c.flag('dry-run') })
      c.out([r.message, ...stepLines(r.steps)].join('\n'), r)
      return r.ok ? 0 : 1
    }
    if (sub === 'apply') {
      const plan = a1
      const preview = await s.apply(ctx, { plan, dryRun: true })
      c.out(applyText(preview), preview)
      if (c.flag('dry-run')) return preview.ok ? 0 : 1
      const nothing = preview.entries.every(e => !e.actions.length) && !preview.roles.changed && !preview.files.some(f => f.changed) && !preview.deployments.length
      if (nothing) { console.error('Nothing to change.'); return 0 }
      if (!c.flag('yes') && !await c.confirm('Apply these changes?')) { console.error('Not applied (give --yes to apply without asking).'); return 1 }
      const r = await s.apply(ctx, { plan })
      c.out(applyText(r), r)
      return r.ok ? 0 : 1
    }
    if (sub === 'status' || sub === undefined) {
      const r = await s.status(ctx, { plan: a1 })
      const lines = [
        r.plan ? `summonplan ${r.plan} (mind ${short(r.mind)}); roles.json: ${r.rolesFile ? `plan ${r.rolesFile.plan}, applied ${r.rolesFile.applied}` : 'none (no plan applied here)'}` : r.note,
        '', 'Roles',
        ...Object.entries(r.roles).map(([k, h]) => `  ${k.padEnd(22)} ${h ? `${h.project} (workspace ${h.workspace}${h.workflow ? `, workflow ${h.workflow}` : ''})` : 'not filled'}`),
        '', `Entries${r.entries.length ? '' : ': none'}`,
        ...r.entries.map(e => `  ${e.applied.padEnd(8)} ${e.project.padEnd(14)} ${e.state.padEnd(8)} plan ${short(e.commit)} present ${short(e.present)}  ${e.detail}${e.upstream ? `  upstream ${e.upstream.url} @ ${short(e.upstream.commit)}` : ''}${e.roles.inEffect.length ? `  roles: ${e.roles.inEffect.join(', ')}` : ''}`),
      ]
      if (r.journal && !(r.journal as { finished?: string }).finished) lines.push('', `An apply started ${(r.journal as { started?: string }).started} is unfinished: wfe summon apply continues it.`)
      c.out(lines.join('\n'), r)
      return 0
    }
    throw c.usage(SUMMON_HELP)
  } catch (e) {
    if (e instanceof RequestError) throw c.refused(e.message)
    throw e
  }
}
