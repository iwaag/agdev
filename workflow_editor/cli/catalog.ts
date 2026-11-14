// `wfe catalog` (user_catalog p1, docs/mycatalog.md): the user's catalog —
// braindumps and their reviews, summonplans, why a project exists. The same
// module the service's api/catalog routes use (server/catalog.ts).
import { readFile } from 'node:fs/promises'
import type { Issue } from '../shared/model.ts'
import { braindumpIdOfPath, validateSummonplan } from '../shared/catalog.ts'
import type { CatalogContext } from '../server/catalog.ts'

export const CATALOG_HELP = `wfe catalog init --author <who> [--title <text>] [--plan <name>]
wfe catalog status
wfe catalog braindump list
wfe catalog braindump show <path>
wfe catalog braindump add <path> (--file <md> | --text <text>) --author <who> [--message <m>]
wfe catalog braindump edit <path> (--file <md> | --text <text>) --author <who> [--base <commit>] [--message <m>]
wfe catalog braindump remove <path> --author <who> [--force]
wfe catalog review show <path>
wfe catalog review put <path> (--file <md> | --text <text>) --author <who> [--base <commit>] [--message <m>]
wfe catalog why <project>
wfe catalog plan show <name> [--yaml]
wfe catalog plan check <file>
wfe catalog plan put <file> --author <who> [--message <m>]
wfe catalog plan use <name>
wfe catalog migrate --author <who> [--dry-run]

The catalog (<owner>/mycatalog on this installation's Gitea; one per user) is
the record of what drives the user's development and where its results are.
Braindumps are free text on what is wanted and why: the grounds of the
projects here. A review is free text about a braindump: what became real,
where, what did not. A summonplan (summonplans/<name>.yaml, ag.summonplan.v1)
says which projects make braindumps concrete in one installation, from which
Git URL at which commit, filling which roles, and because of which braindumps.
projects.yaml lists the projects the user shares. docs/mycatalog.md has the
formats. The GitHub copy <user>/mycatalog is the published part of the same
repository.

The one rule: any braindump.md under braindumps/episodes/, at any depth, is a
braindump; its folder path below braindumps/episodes/ is its identity (<path>,
e.g. summoning or agdev_philosophy/p3); a review.md beside it is its review.
Other files there are the owner's and are not read.

init       create <owner>/mycatalog on Gitea (mycatalog.yaml, projects.yaml,
           braindumps/episodes/, summonplans/, README.md), register it
           (category catalog) and record it in <area>/catalog.json; an
           existing catalog is attached; a same-named repository that is not
           one is refused. --plan names the summonplan that describes this
           installation.
status     the repository, head, plan, braindumps with their reviews and the
           projects they ground, projects with their grounds (none is said),
           issues
braindump  each change is one commit authored by --author: the person or agent
           whose words it holds. A braindump is free Markdown; a "# Title" on
           its first line is its title, otherwise its path is.
           edit --base <commit> refuses when someone changed it after that.
           remove refuses while a plan's because names it (--force anyway),
           and removes its review with it.
review     put writes review.md beside the braindump, one commit authored by
           --author (an agent signs by being the author); --base as for edit.
           No structure is required. show also says whether the braindump
           changed after its review (derived from Git).
why        the project's entry in this installation's plan, the braindumps
           behind it, and other plans of this catalog that list it
plan       show / check (validate a file against the repository, no write) /
           put (validate and commit; errors refuse) / use (which plan
           describes this installation, in catalog.json)
migrate    a repository in the layout before user_catalog p1 (mind.yaml,
           catalog.yaml, braindumps/<slug>.md), in one commit: files moved,
           schema lines, every because, publication/github.toml file entries.
           Refuses on a repository already in the new layout. --dry-run
           prints the changes.`

export interface CatalogCli {
  positional: string[]
  opt: (k: string) => string | undefined
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string) => Error
  ctx: () => Promise<CatalogContext>
}

const issueLine = (where: string, i: Issue) => `  ${i.severity === 'error' ? 'error  ' : 'warning'} ${where}: ${i.code}: ${i.message}`
const short = (c?: string | null) => (c ? c.slice(0, 7) : '—')
type Reviewed = { review: { updated: { commit: string; at: string; author: string } | null } | null; changedAfterReview: boolean }
const reviewLine = (b: Reviewed) => !b.review ? 'no review' : `review: ${b.review.updated ? `${b.review.updated.author}, ${b.review.updated.at.slice(0, 10)}, ${short(b.review.updated.commit)}` : 'not committed'}${b.changedAfterReview ? '; the braindump changed after its review' : ''}`

export async function catalogCommand(c: CatalogCli): Promise<number> {
  const m = await import('../server/catalog.ts')
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
    if (sub === 'init') { const r = await m.initCatalog(ctx, { author: author(), title: c.opt('title'), plan: c.opt('plan') }); c.out(steps(r), r); return 0 }
    if (sub === 'status' || sub === undefined) {
      const v = await m.catalogView(ctx, { maxAgeMs: 0 })
      if (!v.configured) { c.out(v.reason, v); return 1 }
      const lines = [
        `${v.repository} @ ${short(v.head)}  ${v.title ? `"${v.title}"  ` : ''}${v.web}`,
        `this installation's plan: ${v.plan || '(none named; wfe catalog plan use <name>)'}`,
        '', `Braindumps (${v.braindumps.length})`,
        ...v.braindumps.map(b => `  ${b.id.padEnd(32)} ${b.title}\n  ${''.padEnd(32)} ${b.projects.length ? `grounds: ${b.projects.join(', ')}` : `grounds no project in ${v.plan || 'the plan'}`}\n  ${''.padEnd(32)} ${reviewLine(b)}`),
        '', `Projects (${v.projects.length})`,
        ...v.projects.map(p => `  ${p.project.padEnd(20)} ${!p.registered ? '(not registered) ' : ''}${!p.entry ? 'not in the plan' : p.braindumps.length ? p.braindumps.map(b => b.id + (b.missing ? ' (missing)' : '')).join(', ') : 'no ground'}${p.entry && Object.keys(p.entry.roles).length ? `  roles: ${Object.entries(p.entry.roles).map(([k, x]) => x === true ? k : `${k}=${x}`).join(', ')}` : ''}`),
        '', `Plans: ${v.plans.map(p => `${p.name} (${p.entries} entries${p.errors ? `, ${p.errors} errors` : ''}${p.warnings ? `, ${p.warnings} warnings` : ''})`).join(', ') || 'none'}`,
        ...v.problems.map(p => `  problem ${p}`),
        ...v.issues.map(x => issueLine(x.where, x.issue)),
      ]
      c.out(lines.join('\n'), v)
      return v.problems.length || v.issues.some(x => x.issue.severity === 'error') ? 1 : 0
    }
    if (sub === 'braindump' || sub === 'braindumps') {
      if (a1 === 'list' || a1 === undefined) {
        const v = await m.catalogView(ctx, { maxAgeMs: 0 })
        if (!v.configured) { c.out(v.reason, v); return 1 }
        c.out(v.braindumps.map(b => `${b.id.padEnd(32)} ${b.title}  [${b.projects.join(', ') || 'no project'}]  ${short(b.updated?.commit)} ${b.updated?.author ?? ''}  ${reviewLine(b)}`).join('\n') || 'No braindumps yet.', v.braindumps.map(({ text: _t, ...b }) => b))
        return 0
      }
      if (!a2) throw c.usage(`wfe catalog braindump ${a1} <path>`)
      if (a1 === 'show') {
        const b = await m.braindump(ctx, a2)
        c.out([`${b.path} @ ${short(b.updated?.commit)} (${b.updated?.author ?? '?'}, ${b.updated?.at ?? '?'})`, `grounds: ${b.projects.join(', ') || 'no project in this installation\'s plan'}${b.plans.length ? `  (plans: ${b.plans.join(', ')})` : ''}`, reviewLine(b), '', b.text ?? ''].join('\n'), b)
        return 0
      }
      if (a1 === 'add' || a1 === 'edit') { const r = await m.changeBraindump(ctx, { op: a1, id: a2, text: await textArg(), author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      if (a1 === 'remove') { const r = await m.changeBraindump(ctx, { op: 'remove', id: a2, author: author(), force: c.flag('force'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      throw c.usage('wfe catalog braindump list | show | add | edit | remove')
    }
    if (sub === 'review' || sub === 'reviews') {
      if (!a2 || (a1 !== 'show' && a1 !== 'put')) throw c.usage('wfe catalog review show <path> | put <path> (--file <md> | --text <text>) --author <who> [--base <commit>]')
      if (a1 === 'put') { const r = await m.putReview(ctx, { id: a2, text: await textArg(), author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      const r = await m.review(ctx, a2)
      c.out([`${r.id}: ${r.title}`, `braindump: ${r.braindump.updated ? `${r.braindump.updated.author}, ${r.braindump.updated.at.slice(0, 10)}, ${short(r.braindump.updated.commit)}` : '?'}`, reviewLine(r), ...(r.review ? ['', r.review.text] : [])].join('\n'), r)
      return 0
    }
    if (sub === 'migrate') {
      const dry = c.flag('dry-run')
      const r = await m.migrate(ctx, { author: dry ? (c.opt('author') ?? '') : author(), dryRun: dry })
      c.out([r.message, ...r.lines.map(l => `  ${l}`)].join('\n'), r)
      return 0
    }
    if (sub === 'why') {
      if (!a1) throw c.usage('wfe catalog why <project>')
      const w = await m.why(ctx, a1)
      const lines = [
        `${w.project}${w.registered ? '' : ' (not registered here)'}`,
        !w.entry ? `  not in this installation's plan (${w.plan || 'none named'})` : `  plan ${w.plan}: ${w.entry.state}, ${w.entry.source} @ ${short(w.entry.commit)}${Object.keys(w.entry.roles).length ? `, roles ${Object.entries(w.entry.roles).map(([k, x]) => x === true ? k : `${k}=${x}`).join(', ')}` : ''}`,
        ...(w.entry?.note ? [`  note: ${w.entry.note}`] : []),
        ...(w.entry && !w.braindumps.length ? ['  no ground: no braindump says why this project is here'] : []),
        ...w.braindumps.flatMap(b => [``, `  ${b.id}${b.missing ? ' (missing from the repository)' : ''}: ${b.title}`, ...b.excerpt.split('\n').slice(0, 6).map(l => `    ${l}`)]),
        ...w.elsewhere.map(e => `  also in plan ${e.plan}: ${e.entry.because.join(', ') || 'no ground'}`),
      ]
      c.out(lines.join('\n'), w)
      return 0
    }
    if (sub === 'plan' || sub === 'plans') {
      if (a1 === 'show') {
        if (!a2) throw c.usage('wfe catalog plan show <name>')
        const p = await m.plan(ctx, a2)
        if (c.flag('yaml')) { c.out(p.text, p); return 0 }
        const pl = p.plan
        const lines = pl ? [
          `${p.path}${p.current ? ' (this installation)' : ''}  grounds ${short(pl.grounds)}  catalog head ${short(p.head)}`, `intent: ${pl.intent}`, '',
          ...pl.entries.map(e => `  ${e.project.padEnd(20)} ${e.state.padEnd(9)} ${short(e.commit)}  ${e.because.map(b => braindumpIdOfPath(b) ?? b).join(', ') || 'no ground'}${Object.keys(e.roles).length ? `  roles: ${Object.entries(e.roles).map(([k, x]) => x === true ? k : `${k}=${x}`).join(', ')}` : ''}`),
          ...p.issues.map(i => issueLine(p.path, i)),
        ] : [`${p.path} cannot be read: ${p.problem}`]
        c.out(lines.join('\n'), p)
        return p.plan && !p.issues.some(i => i.severity === 'error') ? 0 : 1
      }
      if (a1 === 'check') {
        if (!a2) throw c.usage('wfe catalog plan check <file>')
        const { parseSummonplan } = await import('../server/yamlDoc.ts')
        const r = parseSummonplan(await readFile(a2, 'utf8'))
        if (!r.ok) { c.out(`cannot be read: ${r.problem.message}`, r.problem); return 1 }
        const snap = await m.catalogSnapshot(ctx, { maxAgeMs: 0 })
        const issues = validateSummonplan(r.model, { braindumps: snap.braindumps.map(b => b.path) }, r.model.name)
        c.out(issues.map(i => issueLine(a2, i)).join('\n') || `${a2}: no issues (against catalog ${short(snap.head)})`, { issues, head: snap.head })
        return issues.some(i => i.severity === 'error') ? 1 : 0
      }
      if (a1 === 'put') {
        if (!a2) throw c.usage('wfe catalog plan put <file> --author <who>')
        const r = await m.putPlan(ctx, { text: await readFile(a2, 'utf8'), author: author(), message: c.opt('message') })
        c.out([r.message, ...r.issues.map(i => issueLine(a2, i))].join('\n'), r)
        return 0
      }
      if (a1 === 'use') { if (!a2) throw c.usage('wfe catalog plan use <name>'); const r = await m.setInstallationPlan(ctx, a2); c.out(r.message, r); return 0 }
      throw c.usage('wfe catalog plan show | check | put | use')
    }
    throw c.usage(CATALOG_HELP)
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
