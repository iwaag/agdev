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
wfe catalog braindump archive (<path> | --all) --author <who> [--note <text>] [--dry-run]
wfe catalog review show <path>
wfe catalog review put <path> (--file <md> | --text <text>) --author <who> [--base <commit>] [--message <m>]
wfe catalog review request [<path>] --author <who>
wfe catalog preference list
wfe catalog preference show <name>
wfe catalog preference put <name> (--file <md> | --text <text>) --author <who> [--base <commit>] [--message <m>]
wfe catalog preference remove <name> --author <who>
wfe catalog index show
wfe catalog index put (--file <md> | --text <text>) --author <who> [--base <commit>] [--message <m>]
wfe catalog index request --author <who>
wfe catalog publication status
wfe catalog publication use <folder>
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

The owner's challenges (problems found during work; wfe challenge) live in the
same repository under challenges/<id>/; challenges.md beside them is the index
of what is not yet real.

The owner's standing preferences are preferences/<name>.md: how the owner
wants work done (the language of documents, how results are handed over, …),
free Markdown, one file per subject. Every file there is given to every run
and every authoring session as system context (wfe context show: sources
system/preference/<name>, with the catalog commit). A preference is not what
is wanted (a braindump) and not a fact about a machine (the system context's
local blocks). An agent writes one only with what the owner said or confirmed,
as its own --author.

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
           projects they ground, the archive folders, projects with their
           grounds (none is said), issues
braindump  show also lists what cited it, newest first ("cited by"): the
           conversations' messages and the runs whose request named it
           (wfe conversation post --cite <path>, wfe request … --cite <path>,
           wfe run create … --cite <path>), each with the commit it was cited
           at and whether the text changed since. A citation gives the
           receiving run the braindump as it was then, with its review and
           the names of the projects grounded on it, as the ground of that
           request: not an instruction to carry out in full, not a preference.
           A preference is never cited: every run has it already.
           each change is one commit authored by --author: the person or agent
           whose words it holds. A braindump is free Markdown; a "# Title" on
           its first line is its title, otherwise its path is.
           edit --base <commit> refuses when someone changed it after that.
           remove refuses while a plan's because names it (--force anyway),
           and removes its review with it. It is for a braindump that should
           not be kept in the tree at all; otherwise archive.
           archive moves the braindump with its review to
           braindumps/archive/<date>/<path>/, in one commit that also takes it
           out of every because (summonplans/*.yaml and projects.yaml; a list
           left empty is "no ground", nothing is written in its place) and
           lists it in that folder's README.md with its title, its last commit
           and the projects that named it. --all archives every braindump.
           Only what is below braindumps/episodes/ is a braindump: an archived
           one grounds nothing, is not reviewed, not indexed and cannot be
           cited; it stays readable in the repository. The tag archive/<date>
           is set on the commit before (a later archive of the same day:
           archive/<date>.2, …). What cited the braindump keeps the text it
           cited, shown as removed. A path already in the day's folder gets a
           numbered folder. --note is written in the README and the commit.
           --dry-run prints the moves and each because that would change.
review     put writes review.md beside the braindump, one commit authored by
           --author (an agent signs by being the author); --base as for edit.
           No structure is required. show also says whether the braindump
           changed after its review (derived from Git).
           request asks the summoner's workflow review to write or refresh
           the review of <path>, or of every braindump with no review or
           changed after its review. Refused when no summoner is here.
index      challenges.md at the catalog's root: what is not yet real, from
           both origins (a braindump not carried out, a challenge not
           resolved), each with its kind, a link and a line or two. An agent
           writes it; nothing reads meaning from it. show also says what
           changed under braindumps/ or challenges/ since it was written
           (derived from Git). put writes it whole, one commit authored by
           --author. request asks the summoner's workflow index to rewrite it.
publication  status: the public paths publication/github.toml selects,
           grouped as braindumps, reviews, challenges and the rest; what is
           not selected is internal. The last public commit is read from the
           journal of the folder the catalog is published from (use <folder>
           records it in catalog.json).
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
  request: (o: { workspace: string; workflow: string; text: string; author: string; receipt: string }) => Promise<{ message: string; data: unknown }>
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
        ...v.braindumps.map(b => `  ${b.id.padEnd(32)} ${b.title}${b.published ? '  [published]' : ''}\n  ${''.padEnd(32)} ${b.projects.length ? `grounds: ${b.projects.join(', ')}` : `grounds no project in ${v.plan || 'the plan'}`}\n  ${''.padEnd(32)} ${reviewLine(b)}${b.cited ? `; cited ${b.cited} time${b.cited === 1 ? '' : 's'}` : ''}`),
        ...(v.archived.length ? [`  archived: ${v.archived.map(a => `${a.name} (${a.braindumps})  ${a.web}`).join('; ')}`] : []),
        '', `Preferences (${v.preferences.length}): ${v.preferences.map(p => p.name).join(', ') || 'none'}`,
        '', `Challenges: ${v.challenges.available ? `${v.challenges.items.length} (${Object.entries(v.challenges.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})${v.challenges.inCatalog ? '' : `; ${v.challenges.reason}`}` : v.challenges.reason}`,
        `Index (${v.index.path}): ${v.index.updated ? `${v.index.updated.author}, ${v.index.updated.at.slice(0, 10)}, ${short(v.index.updated.commit)}${v.index.note ? `; ${v.index.note}` : ''}` : v.index.note}`,
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
        c.out(v.braindumps.map(b => `${b.id.padEnd(32)} ${b.title}  [${b.projects.join(', ') || 'no project'}]  ${short(b.updated?.commit)} ${b.updated?.author ?? ''}  ${reviewLine(b)}`).join('\n') || 'No braindumps yet.', v.braindumps)
        return 0
      }
      if (a1 === 'archive') {
        const all = c.flag('all'), dry = c.flag('dry-run')
        if (!!a2 === all) throw c.usage('wfe catalog braindump archive (<path> | --all) --author <who> [--note <text>] [--dry-run]')
        const r = await m.archiveBraindumps(ctx, { id: a2, all, author: dry ? (c.opt('author') ?? '') : author(), note: c.opt('note'), dryRun: dry })
        c.out([r.message, ...r.lines.map(l => `  ${l}`)].join('\n'), r)
        return 0
      }
      if (!a2) throw c.usage(`wfe catalog braindump ${a1} <path>`)
      if (a1 === 'show') {
        const b = await m.braindump(ctx, a2)
        c.out([`${b.path} @ ${short(b.updated?.commit)} (${b.updated?.author ?? '?'}, ${b.updated?.at ?? '?'})`, `grounds: ${b.projects.join(', ') || 'no project in this installation\'s plan'}${b.plans.length ? `  (plans: ${b.plans.join(', ')})` : ''}`, reviewLine(b),
          ...(b.citedBy.length ? [`cited by (${b.citedBy.length}):`, ...b.citedBy.map(x => `  ${x.at.slice(0, 16)}Z ${x.label} by ${x.by} at ${short(x.commit)}${x.changed ? ' (changed since)' : ''}`)] : ['cited by: nothing yet']),
          '', b.text ?? ''].join('\n'), b)
        return 0
      }
      if (a1 === 'add' || a1 === 'edit') { const r = await m.changeBraindump(ctx, { op: a1, id: a2, text: await textArg(), author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      if (a1 === 'remove') { const r = await m.changeBraindump(ctx, { op: 'remove', id: a2, author: author(), force: c.flag('force'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      throw c.usage('wfe catalog braindump list | show | add | edit | remove | archive')
    }
    if (sub === 'review' || sub === 'reviews') {
      if (a1 === 'request') {
        const r = await m.upkeepRequest(ctx, { kind: 'review', id: a2 })
        const q = await c.request({ workspace: r.workspace, workflow: r.workflow, text: r.text, author: author(), receipt: r.receipt })
        c.out(q.message, { ...r, request: q.data }); return 0
      }
      if (!a2 || (a1 !== 'show' && a1 !== 'put')) throw c.usage('wfe catalog review show <path> | put <path> (--file <md> | --text <text>) --author <who> [--base <commit>] | request [<path>] --author <who>')
      if (a1 === 'put') { const r = await m.putReview(ctx, { id: a2, text: await textArg(), author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      const r = await m.review(ctx, a2)
      c.out([`${r.id}: ${r.title}`, `braindump: ${r.braindump.updated ? `${r.braindump.updated.author}, ${r.braindump.updated.at.slice(0, 10)}, ${short(r.braindump.updated.commit)}` : '?'}`, reviewLine(r), ...(r.review ? ['', r.review.text ?? ''] : [])].join('\n'), r)
      return 0
    }
    if (sub === 'preference' || sub === 'preferences') {
      if (a1 === 'list' || a1 === undefined) {
        const r = await m.preferences(ctx, { maxAgeMs: 0 })
        c.out(r.preferences.map(p => `${p.name.padEnd(32)} ${p.title}  ${short(p.updated?.commit)} ${p.updated?.author ?? ''} ${p.updated?.at.slice(0, 10) ?? ''}${p.published ? '  [published]' : ''}`).join('\n') || 'No preferences yet (preferences/<name>.md).', r)
        return 0
      }
      if (!a2) throw c.usage(`wfe catalog preference ${a1} <name>`)
      if (a1 === 'show') {
        const p = await m.preference(ctx, a2)
        c.out([`${p.path} @ ${short(p.updated?.commit)} (${p.updated?.author ?? '?'}, ${p.updated?.at ?? '?'})  catalog head ${short(p.head)}`, '', p.text].join('\n'), p)
        return 0
      }
      if (a1 === 'put') { const r = await m.changePreference(ctx, { op: 'put', name: a2, text: await textArg(), author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      if (a1 === 'remove') { const r = await m.changePreference(ctx, { op: 'remove', name: a2, author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      throw c.usage('wfe catalog preference list | show <name> | put <name> (--file <md> | --text <text>) --author <who> [--base <commit>] | remove <name> --author <who>')
    }
    if (sub === 'index') {
      if (a1 === 'put') { const r = await m.putIndex(ctx, { text: await textArg(), author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      if (a1 === 'request') {
        const r = await m.upkeepRequest(ctx, { kind: 'index' })
        const q = await c.request({ workspace: r.workspace, workflow: r.workflow, text: r.text, author: author(), receipt: r.receipt })
        c.out(q.message, { ...r, request: q.data }); return 0
      }
      if (a1 !== 'show' && a1 !== undefined) throw c.usage('wfe catalog index show | put (--file <md> | --text <text>) --author <who> [--base <commit>] | request --author <who>')
      const r = await m.index(ctx, { maxAgeMs: 0 })
      c.out([`${r.path} @ ${short(r.updated?.commit)}${r.updated ? ` (${r.updated.author}, ${r.updated.at})` : ''}  catalog head ${short(r.head)}`, ...(r.note ? [r.note] : []), ...(r.text === null ? [] : ['', r.text])].join('\n'), r)
      return 0
    }
    if (sub === 'publication') {
      if (a1 === 'use') { if (!a2) throw c.usage('wfe catalog publication use <folder>'); const r = await m.setPublicationWorkspace(ctx, a2); c.out(r.message, r); return 0 }
      if (a1 !== 'status' && a1 !== undefined) throw c.usage('wfe catalog publication status | use <folder>')
      const r = await m.publicationStatus(ctx, { maxAgeMs: 0 })
      if (!r.contract) { c.out('The catalog has no publication/github.toml: nothing is published.', r); return 0 }
      const list = (name: string, xs: string[]) => [`${name} (${xs.length})`, ...xs.map(x => `  ${x}`)]
      c.out([
        `${r.destination}  catalog head ${short(r.head)}`,
        r.last ? `last public commit ${short(r.last.publicCommit)} from catalog ${short(r.last.sourceRev)} at ${r.last.at}` : `last public commit: ${r.note}`,
        '', ...list('Braindumps', r.braindumps.map(b => `${b.id} → ${b.public}`)),
        ...list('Reviews', r.reviews.map(b => `${b.id} → ${b.public}`)),
        ...list('Challenges', r.challenges.map(x => `${x.id} (${x.files} file${x.files === 1 ? '' : 's'})`)),
        ...list('The rest', r.rest.map(e => e.from === e.public ? e.public : `${e.from} → ${e.public}`)),
        '', `Internal braindumps (${r.internal.braindumps.length}): ${r.internal.braindumps.join(', ') || 'none'}`,
      ].join('\n'), r)
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
