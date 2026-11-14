// `wfe mind` (summoner p1, docs/mind.md): this installation's mind repository —
// braindumps as grounds, summonplans, why a project exists. The same module
// the service's api/mind routes use (server/mind.ts).
import { readFile } from 'node:fs/promises'
import type { Issue } from '../shared/model.ts'
import { validateSummonplan } from '../shared/mind.ts'
import type { MindContext } from '../server/mind.ts'

export const MIND_HELP = `wfe mind init --author <who> [--title <text>] [--plan <name>]
wfe mind status
wfe mind braindump list
wfe mind braindump show <slug>
wfe mind braindump add <slug> (--file <md> | --text <text>) --author <who> [--message <m>]
wfe mind braindump edit <slug> (--file <md> | --text <text>) --author <who> [--base <commit>] [--message <m>]
wfe mind braindump remove <slug> --author <who> [--force]
wfe mind why <project>
wfe mind plan show <name> [--yaml]
wfe mind plan check <file>
wfe mind plan put <file> --author <who> [--message <m>]
wfe mind plan use <name>

The mind repository (<owner>/mycatalog on this installation's Gitea) holds a
user's braindumps: free text on what they want and why, the grounds of the
projects here and of the resources they use. A summonplan
(summonplans/<name>.yaml, ag.summonplan.v1) says which projects make those
braindumps concrete, from which Git URL at which commit, filling which roles,
and which braindumps ground each (because). docs/mind.md has the formats.

init       create <owner>/mycatalog on Gitea (mind.yaml, braindumps/,
           summonplans/, catalog.yaml), register it (category mind) and record
           it in <area>/mind.json; an existing mind repository is attached; a
           same-named repository that is not one is refused. --plan names the
           summonplan that describes this installation.
status     the repository, head, plan, braindumps with the projects they
           ground, projects with their grounds (none is said), issues
braindump  each change is one commit authored by --author: the person or agent
           whose words it holds. A braindump is free Markdown; an optional
           "# Title" first line is its title; the slug is its identity.
           edit --base <commit> refuses when someone changed it after that.
           remove refuses while a plan's because names it (--force anyway).
why        the project's entry in this installation's plan, the braindumps
           behind it, and other plans of this mind that list it
plan       show / check (validate a file against the repository, no write) /
           put (validate and commit; errors refuse) / use (which plan
           describes this installation, in mind.json)`

export interface MindCli {
  positional: string[]
  opt: (k: string) => string | undefined
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string) => Error
  ctx: () => Promise<MindContext>
}

const issueLine = (where: string, i: Issue) => `  ${i.severity === 'error' ? 'error  ' : 'warning'} ${where}: ${i.code}: ${i.message}`
const short = (c?: string | null) => (c ? c.slice(0, 7) : '—')

export async function mindCommand(c: MindCli): Promise<number> {
  const m = await import('../server/mind.ts')
  const { RequestError } = await import('../server/workspace.ts')
  const [sub, a1, a2] = c.positional
  const ctx = await c.ctx()
  const author = () => { const v = c.opt('author'); if (!v?.trim()) throw c.usage('--author <who> is required: the person or agent whose words the change holds'); return v.trim() }
  const textArg = async () => {
    const f = c.opt('file'), t = c.opt('text')
    if (!!f === !!t) throw c.usage('give the text with --file <md> or --text <text>')
    return f ? (f === '-' ? await readStdin() : await readFile(f, 'utf8')) : t!
  }
  const steps = (r: { message: string; steps?: { name: string; status: string; detail: string }[] }) => [r.message, ...(r.steps ?? []).map(s => `  ${s.status.padEnd(6)} ${s.name}: ${s.detail}`)].join('\n')
  try {
    if (sub === 'init') { const r = await m.initMind(ctx, { author: author(), title: c.opt('title'), plan: c.opt('plan') }); c.out(steps(r), r); return 0 }
    if (sub === 'status' || sub === undefined) {
      const v = await m.mindView(ctx, { maxAgeMs: 0 })
      if (!v.configured) { c.out(v.reason, v); return 1 }
      const lines = [
        `${v.repository} @ ${short(v.head)}  ${v.title ? `"${v.title}"  ` : ''}${v.web}`,
        `this installation's plan: ${v.plan || '(none named; wfe mind plan use <name>)'}`,
        '', `Braindumps (${v.braindumps.length})`,
        ...v.braindumps.map(b => `  ${b.slug.padEnd(32)} ${b.title}${b.projects.length ? `\n  ${''.padEnd(32)} grounds: ${b.projects.join(', ')}` : `\n  ${''.padEnd(32)} grounds no project in ${v.plan || 'the plan'}`}`),
        '', `Projects (${v.projects.length})`,
        ...v.projects.map(p => `  ${p.project.padEnd(20)} ${!p.registered ? '(not registered) ' : ''}${!p.entry ? 'not in the plan' : p.braindumps.length ? p.braindumps.map(b => b.slug + (b.missing ? ' (missing)' : '')).join(', ') : 'no ground'}${p.entry && Object.keys(p.entry.roles).length ? `  roles: ${Object.entries(p.entry.roles).map(([k, x]) => x === true ? k : `${k}=${x}`).join(', ')}` : ''}`),
        '', `Plans: ${v.plans.map(p => `${p.name} (${p.entries} entries${p.errors ? `, ${p.errors} errors` : ''}${p.warnings ? `, ${p.warnings} warnings` : ''})`).join(', ') || 'none'}`,
        ...v.problems.map(p => `  problem ${p}`),
        ...v.issues.map(x => issueLine(x.where, x.issue)),
      ]
      c.out(lines.join('\n'), v)
      return v.problems.length || v.issues.some(x => x.issue.severity === 'error') ? 1 : 0
    }
    if (sub === 'braindump' || sub === 'braindumps') {
      if (a1 === 'list' || a1 === undefined) {
        const v = await m.mindView(ctx, { maxAgeMs: 0 })
        if (!v.configured) { c.out(v.reason, v); return 1 }
        c.out(v.braindumps.map(b => `${b.slug.padEnd(32)} ${b.title}  [${b.projects.join(', ') || 'no project'}]  ${short(b.updated?.commit)} ${b.updated?.author ?? ''}`).join('\n') || 'No braindumps yet.', v.braindumps)
        return 0
      }
      if (!a2) throw c.usage(`wfe mind braindump ${a1} <slug>`)
      if (a1 === 'show') {
        const b = await m.braindump(ctx, a2)
        c.out([`${b.path} @ ${short(b.updated?.commit)} (${b.updated?.author ?? '?'}, ${b.updated?.at ?? '?'})`, `grounds: ${b.projects.join(', ') || 'no project in this installation\'s plan'}${b.plans.length ? `  (plans: ${b.plans.join(', ')})` : ''}`, '', b.text ?? ''].join('\n'), b)
        return 0
      }
      if (a1 === 'add' || a1 === 'edit') { const r = await m.changeBraindump(ctx, { op: a1, slug: a2, text: await textArg(), author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      if (a1 === 'remove') { const r = await m.changeBraindump(ctx, { op: 'remove', slug: a2, author: author(), force: c.flag('force'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      throw c.usage('wfe mind braindump list | show | add | edit | remove')
    }
    if (sub === 'why') {
      if (!a1) throw c.usage('wfe mind why <project>')
      const w = await m.why(ctx, a1)
      const lines = [
        `${w.project}${w.registered ? '' : ' (not registered here)'}`,
        !w.entry ? `  not in this installation's plan (${w.plan || 'none named'})` : `  plan ${w.plan}: ${w.entry.state}, ${w.entry.source} @ ${short(w.entry.commit)}${Object.keys(w.entry.roles).length ? `, roles ${Object.entries(w.entry.roles).map(([k, x]) => x === true ? k : `${k}=${x}`).join(', ')}` : ''}`,
        ...(w.entry?.note ? [`  note: ${w.entry.note}`] : []),
        ...(w.entry && !w.braindumps.length ? ['  no ground: no braindump says why this project is here'] : []),
        ...w.braindumps.flatMap(b => [``, `  ${b.slug}${b.missing ? ' (missing from the repository)' : ''}: ${b.title}`, ...b.excerpt.split('\n').slice(0, 6).map(l => `    ${l}`)]),
        ...w.elsewhere.map(e => `  also in plan ${e.plan}: ${e.entry.because.join(', ') || 'no ground'}`),
      ]
      c.out(lines.join('\n'), w)
      return 0
    }
    if (sub === 'plan' || sub === 'plans') {
      if (a1 === 'show') {
        if (!a2) throw c.usage('wfe mind plan show <name>')
        const p = await m.plan(ctx, a2)
        if (c.flag('yaml')) { c.out(p.text, p); return 0 }
        const pl = p.plan
        const lines = pl ? [
          `${p.path}${p.current ? ' (this installation)' : ''}  grounds ${short(pl.grounds)}  mind head ${short(p.head)}`, `intent: ${pl.intent}`, '',
          ...pl.entries.map(e => `  ${e.project.padEnd(20)} ${e.state.padEnd(9)} ${short(e.commit)}  ${e.because.map(b => b.replace(/^braindumps\/|\.md$/g, '')).join(', ') || 'no ground'}${Object.keys(e.roles).length ? `  roles: ${Object.entries(e.roles).map(([k, x]) => x === true ? k : `${k}=${x}`).join(', ')}` : ''}`),
          ...p.issues.map(i => issueLine(p.path, i)),
        ] : [`${p.path} cannot be read: ${p.problem}`]
        c.out(lines.join('\n'), p)
        return p.plan && !p.issues.some(i => i.severity === 'error') ? 0 : 1
      }
      if (a1 === 'check') {
        if (!a2) throw c.usage('wfe mind plan check <file>')
        const { parseSummonplan } = await import('../server/yamlDoc.ts')
        const r = parseSummonplan(await readFile(a2, 'utf8'))
        if (!r.ok) { c.out(`cannot be read: ${r.problem.message}`, r.problem); return 1 }
        const snap = await m.mindSnapshot(ctx, { maxAgeMs: 0 })
        const issues = validateSummonplan(r.model, { braindumps: snap.braindumps.map(b => b.path) }, r.model.name)
        c.out(issues.map(i => issueLine(a2, i)).join('\n') || `${a2}: no issues (against mind ${short(snap.head)})`, { issues, head: snap.head })
        return issues.some(i => i.severity === 'error') ? 1 : 0
      }
      if (a1 === 'put') {
        if (!a2) throw c.usage('wfe mind plan put <file> --author <who>')
        const r = await m.putPlan(ctx, { text: await readFile(a2, 'utf8'), author: author(), message: c.opt('message') })
        c.out([r.message, ...r.issues.map(i => issueLine(a2, i))].join('\n'), r)
        return 0
      }
      if (a1 === 'use') { if (!a2) throw c.usage('wfe mind plan use <name>'); const r = await m.setInstallationPlan(ctx, a2); c.out(r.message, r); return 0 }
      throw c.usage('wfe mind plan show | check | put | use')
    }
    throw c.usage(MIND_HELP)
  } catch (e) {
    if (e instanceof RequestError) throw c.refused(e.message)
    throw e
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const ch of process.stdin) chunks.push(ch as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
