// `wfe catalog` (user_catalog p1, docs/mycatalog.md): the user's catalog —
// braindumps and their reviews, summonplans, why a project exists. The same
// module the service's api/catalog routes use (server/catalog.ts).
import { readFile } from 'node:fs/promises'
import type { Issue } from '../shared/model.ts'
import { braindumpIdOfPath, validateSummonplan } from '../shared/catalog.ts'
import type { CatalogContext } from '../server/catalog.ts'

export const CATALOG_HELP = `wfe catalog init --author <who> [--title <text>] [--plan <name>]
wfe catalog status
wfe catalog braindump show <path>
wfe catalog braindump add <path> (--file <md> | --text <text>) --author <who> [--message <m>]
wfe catalog braindump edit <path> (--file <md> | --text <text>) --author <who> [--base <commit>] [--message <m>]
wfe catalog braindump remove <path> --author <who> [--force]
wfe catalog braindump archive (<path> | --all) --author <who> [--note <text>] [--dry-run]
wfe catalog braindump move <path> <new path> --author <who> [--reuse-archived]
wfe catalog braindump list [--tag <tag>]
wfe catalog tags show <path>
wfe catalog tags set <path> (--tags <a,b> | --add <a,b> | --remove <a,b>) --author <who> [--base <metadata commit>|none]
wfe catalog tags propose <path> --file <json|-> --author <who> [--run <ref>] [--base <body commit>]
wfe catalog tags proposals [<path>] [--all]
wfe catalog tags accept <proposal> --tags <add:a,remove:b> --author <who>
wfe catalog tags dismiss <proposal> --author <who>
wfe catalog draft list | where
wfe catalog draft use (shared://<share>/<folder>/ | <absolute folder> | --default)
wfe catalog draft new [(--file <md> | --text <text>)] [--tags <a,b>] [--path <path>] [--of <path> --of-base <commit>] --author <who>
wfe catalog draft show <id> [--revision <n>]
wfe catalog draft save <id> (--file <md> | --text <text>) --base <revision> [--tags <a,b>] [--path <path>] --author <who>
wfe catalog draft remove <id> --author <who>
wfe catalog draft preview <id> [--path <path>]
wfe catalog draft register <id> [--path <path>] --base <revision> --author <who> [--reuse-archived]
wfe catalog ask request (<draft> --base <revision> | --file <md> | --text <text>) --author <who>
wfe catalog ask list | show <draft> <ask>
wfe catalog ask answer <draft> <ask> --answer <md|-> --kind braindump|instruction|question [--actions <json>] [--rewrite <md>] [--head <commit>] [--read <text>] --author <who>
wfe catalog ask fail <draft> <ask> --reason <text> --author <who>
wfe catalog ask do <draft> <ask> <n> --author <who>
wfe catalog ask decline <draft> <ask> <n> --author <who>
wfe catalog ask dismiss <draft> <ask> --author <who>
wfe catalog links request --author <who> | show
wfe catalog links suggest --file <json|-> --head <commit> --author <who> [--run <ref>]
wfe catalog links agree (<n>… | --all) --author <who>
wfe catalog links decline (<n>… | --all) --author <who>
wfe catalog rules list
wfe catalog rules adopt --tag <tag> --follows never-publish|suggest-publish --braindump <path> --sentence <text> [--at <commit>] --author <who>
wfe catalog rules adopt --project <id> --follows never-publish|publish --braindump <path> --sentence <text> [--at <commit>] --author <who>
wfe catalog rules adopt --licence <spdx> --follows default-licence --braindump <path> --sentence <text> [--at <commit>] --author <who>
wfe catalog disclosure [<project>]
wfe catalog disclosure agree|decline (<n> | licence) --author <who>
wfe catalog rules retire <id> --author <who>
wfe catalog rules share <id> never|default --author <who>
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
wfe catalog publication check [--source <folder>]
wfe catalog publication add (<path> | rules.yaml) --author <who>
wfe catalog publication put <publication/github.toml | publication/overlay/…> (--file <f> | --remove) --author <who> [--base <commit>] [--message <m>]
wfe catalog publication request [<project>] --author <who> [--note <text>]
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
           move renames a braindump: the files of its folder move to the new
           path and every because naming it names the new one, in one commit;
           a path that holds anything or that was archived is refused. What
           cited the old path shows it removed.
           Tags written in the text (#name after a space or at the start of
           a line, beginning with a letter, outside code) are tags of the
           braindump: each commit of a body adds those the new text writes
           and removes those the old text wrote and the new one does not.
           After add, edit or a draft's registration the service asks the
           summoner by itself for the review, then for the index
           ("the follow-up"; catalog.json "followUp": false turns it off).
tags       optional, free labels of a braindump in metadata.yaml beside it
           (ag.braindump-metadata.v1). None is required, none is refused for
           its meaning; examples: mybraindump (agdev's recommended tag: the
           owner's own conventions for writing, tagging and handling
           braindumps), style, desire, bounty, public, private. A tag asks for
           nothing by itself: public does not publish, style is not a
           preference, bounty opens no challenge. set changes only
           metadata.yaml, in one commit; the body's last change stays.
           propose records a proposal outside Git (the JSON:
           {"changes": [{"op": "add"|"remove", "tag": "…", "reason": "…"}],
           "note": "…"}), against the body and tags read; nothing changes
           until the owner accepts chosen changes (one commit in the owner's
           name naming the proposal) or dismisses it. A proposal made before
           the braindump or its tags changed is stale: shown, not applied.
draft      a braindump before it is one: free text kept outside Git, in the
           folder catalog.json "drafts" names (use: a share reference or an
           absolute folder, prepared with its marker; --default:
           <area>/.local/catalog-drafts/). A root that is not there (an
           unmounted share) refuses; nothing is written elsewhere. A draft has
           an opaque id and needs no path until it is registered; save names
           the revision it was made on (--base) and refuses when someone saved
           after it. A draft is no ground, is not cited, indexed, reviewed or
           published. register
           commits exactly that revision's text and tags as
           braindumps/episodes/<path>/ in one commit (without --path, the
           service names it from the first line, or note-<date>, never a
           taken or archived path), refuses a taken path,
           asks --reuse-archived for an archived one, and marks the draft
           registered only after reading the commit back; a retry after an
           unknown result finds the earlier commit first. The draft and its
           answers stay until removed. A draft made with --of <path>
           --of-base <commit> is a change of that braindump: register edits
           it, refused when it changed after that commit.
ask        the text of the Catalog page's field, asked of the summoner instead
           of put in: an unfinished braindump, an instruction or a question.
           request freezes the revision (or saves --text/--file as a new
           draft) and asks the summoner's workflow ask on the local worker;
           the request names the draft, never its words; the text and the
           answer stay outside Git beside the draft. answer is the run's:
           words, --kind (what it read the text as) and at most 8 proposed
           actions, a JSON list of {"do", "why", …} with do one of
           suggest-links, review [braindump], index, tags (changes
           [{op, tag, reason}], [braindump]), rename (braindump, to), archive
           (braindump), use-text (with --rewrite), adopt-rule (tag, follows,
           source {braindump, commit, sentence}), retire-rule (rule),
           hand-over. An action outside the list, a path that does not exist
           or a rule whose sentence is not in its braindump at that commit
           refuses the whole answer. Nothing is done when the answer is
           written: do carries action <n> out in --author's name through the
           ordinary writer (a refusal marks it failed; do again retries),
           decline answers No. hand-over requests the workflow freework of
           the project that holds the facilitation role with the text as the
           request: the one action that puts the text into Git. dismiss takes
           the ask off the list; the last ask of an instruction or a question
           removes its text with it.
links      a link is one item of a because: braindump → project. request asks
           the summoner's workflow ground to suggest links for the whole
           catalog at its head. suggest is the run's only write (the JSON:
           {"links": [{"braindump", "project", "quote", "why"}], "drop":
           [{"braindump", "project", "why"}], "uncovered": [{"braindump",
           "why"}], "ungrounded": ["<project>"], "note"}); a quote that is
           not in the braindump at --head, an unknown braindump or project
           refuses it. The suggestion is kept outside Git
           (<area>/.local/catalog-links.json); a newer one replaces it. agree
           writes the named links (or --all suggested additions) as one
           commit in --author's name: because of this installation's plan
           and, where the project is listed, of projects.yaml; a link whose
           braindump or project is gone is dropped, not written. Then the
           follow-up asks for the review of the braindumps whose links
           changed, and the index. decline writes nothing.
rules      rules.yaml at the catalog's root (ag.catalog-rules.v1): what the
           owner adopted from a sentence of their own braindump tagged
           mybraindump. Two things can follow from a tag: never-publish (the
           public list cannot select the braindump or its review) and
           suggest-publish (a braindump so tagged and not in the public list
           is offered for it). adopt checks that the braindump is tagged
           mybraindump and that the sentence is in its text at the commit;
           one commit in --author's name. A rule whose source braindump
           changed since stays in force and is marked "its source changed".
           An agent proposes rules (ask answer); only the owner adopts.
           share never: the rule stays in this installation, neither
           published nor offered by a style import (default-licence always
           is); default lets it follow the public list. When rules.yaml is in
           the public list, the publication tool publishes it in a derived
           form: the rules whose braindump the list selects, not never-publish
           on a project, not share never; without the commit; adopted by the
           public account. publication status says which rules are public.
disclosure what the owner's words make of each project (user_catalog p8): private
           (a rule never-publish, or a proposal of the summoner not yet
           answered: agdev-external-publish refuses the project's workspace,
           the publisher declines it), to be published (a rule publish and
           no public repository), public (with the rule), public without a
           statement, not stated; each with the sentence. Then the default
           licence (rule default-licence; never shared as style). agree and
           decline answer a statement of the last link suggestion (its
           number) or its default licence: agree adopts the rule, one commit.
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
           records it in catalog.json). status and check also say what the
           adopted rules make of the selection: check exits 1 when the
           public list selects a braindump (or its review) that a
           never-publish rule covers, names other selected files that name
           such a braindump, and lists what a suggest-publish rule suggests;
           a selected file that names a project kept private is refused (the
           publication tool refuses it as private:<id>) unless the contract
           has an [[allow]] with found = "private:<id>" and why, and check
           exits 1 then too;
           --source reads a folder holding a copy of the catalog instead of
           its head. agdev-external-publish refuses such a candidate by the
           same reading of rules.yaml. add appends the braindump's own files
           to publication/github.toml as a [[tree]], one commit; nothing is
           published by it (rules.yaml with the first braindump tagged
           mybraindump; add rules.yaml adds it alone). put writes the
           contract or an overlay file whole; the check runs on the result
           and a selection a rule refuses is not written (the summoner's
           catalog-publication-edit uses it). request asks the publisher's
           workflow publish for the catalog (no project) or a project; a
           project kept private is refused.
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
  request: (o: { workspace: string; workflow: string; text: string; author: string; receipt: string; node?: string }) => Promise<{ message: string; data: unknown; ref?: { workflow: string; run: string } }>
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
        ...v.braindumps.map(b => `  ${b.id.padEnd(32)} ${b.title}${b.published ? '  [published]' : ''}${b.tags.length ? `  tags: ${b.tags.join(', ')}` : ''}${b.proposals ? `  (${b.proposals} tag proposal${b.proposals === 1 ? '' : 's'})` : ''}\n  ${''.padEnd(32)} ${b.projects.length ? `grounds: ${b.projects.join(', ')}` : `grounds no project in ${v.plan || 'the plan'}`}\n  ${''.padEnd(32)} ${reviewLine(b)}${b.cited ? `; cited ${b.cited} time${b.cited === 1 ? '' : 's'}` : ''}`),
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
        const tag = c.opt('tag')
        const list = tag ? v.braindumps.filter(b => b.tags.some(t => t.toLowerCase() === tag.replace(/^#+/, '').toLowerCase())) : v.braindumps
        c.out(list.map(b => `${b.id.padEnd(32)} ${b.title}  [${b.projects.join(', ') || 'no project'}]  ${short(b.updated?.commit)} ${b.updated?.author ?? ''}  ${reviewLine(b)}${b.tags.length ? `  tags: ${b.tags.join(', ')}` : ''}`).join('\n') || (tag ? `No braindump is tagged ${tag}.` : 'No braindumps yet.'), list)
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
      if (a1 === 'move' || a1 === 'rename') {
        const a3 = c.positional[3]
        if (!a3) throw c.usage('wfe catalog braindump move <path> <new path> --author <who> [--reuse-archived]')
        const r = await m.moveBraindump(ctx, { from: a2, to: a3, author: author(), reuseArchived: c.flag('reuse-archived') })
        c.out(r.message, r)
        return 0
      }
      if (a1 === 'show') {
        const b = await m.braindump(ctx, a2)
        c.out([`${b.path} @ ${short(b.updated?.commit)} (${b.updated?.author ?? '?'}, ${b.updated?.at ?? '?'})`,
          `tags: ${b.tags.length ? b.tags.join(', ') : 'none'}${b.metadata?.updated ? `  (metadata ${short(b.metadata.updated.commit)}, ${b.metadata.updated.author})` : ''}${b.metadata?.problem ? `  (metadata.yaml cannot be read: ${b.metadata.problem})` : ''}${b.proposals.length ? `; ${b.proposals.length} open tag proposal${b.proposals.length === 1 ? '' : 's'} (wfe catalog tags proposals ${b.id})` : ''}`,
          `grounds: ${b.projects.join(', ') || 'no project in this installation\'s plan'}${b.plans.length ? `  (plans: ${b.plans.join(', ')})` : ''}`, reviewLine(b),
          ...(b.citedBy.length ? [`cited by (${b.citedBy.length}):`, ...b.citedBy.map(x => `  ${x.at.slice(0, 16)}Z ${x.label} by ${x.by} at ${short(x.commit)}${x.changed ? ' (changed since)' : ''}`)] : ['cited by: nothing yet']),
          '', b.text ?? ''].join('\n'), b)
        return 0
      }
      if (a1 === 'add' || a1 === 'edit') { const r = await m.changeBraindump(ctx, { op: a1, id: a2, text: await textArg(), author: author(), base: c.opt('base'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      if (a1 === 'remove') { const r = await m.changeBraindump(ctx, { op: 'remove', id: a2, author: author(), force: c.flag('force'), message: c.opt('message') }); c.out(r.message, r); return 0 }
      throw c.usage('wfe catalog braindump list | show | add | edit | remove | archive')
    }
    if (sub === 'tags' || sub === 'tag') {
      const csv = (k: string) => { const v = c.opt(k); return v === undefined ? undefined : v.split(',').map(x => x.trim()).filter(Boolean) }
      const proposalLine = (p: Awaited<ReturnType<typeof m.tagProposals>>[number]) => [`${p.id}  ${p.braindump}  by ${p.by}${p.run ? ` (${p.run})` : ''}, ${p.at.slice(0, 16)}Z  ${p.state}${p.stale ? ` — stale: ${p.staleReason}` : ''}${p.decided ? ` (${p.decided.by}${p.decided.commit ? `, ${short(p.decided.commit)}` : ''})` : ''}`,
        ...p.changes.map(x => `  ${x.op === 'add' ? '+' : '-'}${x.tag}: ${x.reason}`), ...(p.note ? [`  note: ${p.note}`] : [])].join('\n')
      if (a1 === 'show') {
        if (!a2) throw c.usage('wfe catalog tags show <path>')
        const b = await m.braindump(ctx, a2)
        c.out([`${b.id}: ${b.tags.length ? b.tags.join(', ') : 'no tags'}`, `metadata: ${b.metadata ? `${b.metadata.path}${b.metadata.updated ? ` @ ${short(b.metadata.updated.commit)} (${b.metadata.updated.author})` : ''}${b.metadata.problem ? `; cannot be read: ${b.metadata.problem}` : ''}` : 'none (base: none)'}`,
          ...b.proposals.map(proposalLine)].join('\n'), { id: b.id, tags: b.tags, metadata: b.metadata, proposals: b.proposals })
        return 0
      }
      if (a1 === 'set') {
        if (!a2) throw c.usage('wfe catalog tags set <path> (--tags <a,b> | --add <a,b> | --remove <a,b>) --author <who>')
        const r = await m.setTags(ctx, { id: a2, tags: c.opt('tags') === undefined ? undefined : csv('tags'), add: csv('add'), remove: csv('remove'), author: author(), base: c.opt('base'), message: c.opt('message') })
        c.out(r.message, r); return 0
      }
      if (a1 === 'propose') {
        if (!a2) throw c.usage('wfe catalog tags propose <path> --file <json|-> --author <who>')
        const f = c.opt('file')
        if (!f) throw c.usage('give the proposal with --file <json> (or - for stdin): {"changes": [{"op": "add", "tag": "…", "reason": "…"}]}')
        let raw: { changes?: unknown; note?: unknown }
        try { raw = JSON.parse(f === '-' ? await readStdin() : await readFile(f, 'utf8')) } catch (e) { throw c.usage(`the proposal is not JSON: ${(e as Error).message}`) }
        const r = await m.proposeTags(ctx, { id: a2, changes: Array.isArray(raw.changes) ? raw.changes : [], by: author(), run: c.opt('run'), note: typeof raw.note === 'string' ? raw.note : undefined, base: c.opt('base') })
        c.out(r.message, r); return 0
      }
      if (a1 === 'proposals' || a1 === undefined) {
        const list = await m.tagProposals(ctx, { id: a2, all: c.flag('all') })
        c.out(list.map(proposalLine).join('\n') || 'No open tag proposal.', list); return 0
      }
      if (a1 === 'accept' || a1 === 'dismiss') {
        if (!a2) throw c.usage(`wfe catalog tags ${a1} <proposal>`)
        const r = await m.decideTagProposal(ctx, { proposal: a2, accept: csv('tags'), dismiss: a1 === 'dismiss', author: author() })
        c.out(r.message, r); return 0
      }
      throw c.usage('wfe catalog tags show | set | propose | proposals | accept | dismiss')
    }
    if (sub === 'draft' || sub === 'drafts') {
      const d = await import('../server/catalogDrafts.ts')
      const rev = (k = 'base') => { const v = c.opt(k); if (v === undefined || !/^\d+$/.test(v)) throw c.usage(`--${k} <revision> is required: the revision you read (wfe catalog draft show)`); return Number(v) }
      const csv = (k: string) => { const v = c.opt(k); return v === undefined ? undefined : v.split(',').map(x => x.trim()).filter(Boolean) }
      const optText = async () => (c.opt('file') || c.opt('text') !== undefined) ? await textArg() : undefined
      if (a1 === 'list' || a1 === undefined) {
        const r = await d.listDrafts(ctx)
        c.out([`drafts in ${r.where}`, ...r.drafts.map(x => `${x.id}  r${x.revision}  ${x.state === 'registered' ? `registered as ${x.registration?.path} (${short(x.registration?.commit)})` : x.registration?.state === 'pending' ? `registering as ${x.registration.path}` : 'draft'}  ${x.title}${x.tags.length ? `  tags: ${x.tags.join(', ')}` : ''}  ${x.saved.by} ${x.saved.at.slice(0, 16)}Z${x.advice.total ? `  advice ${x.advice.written}/${x.advice.total}` : ''}`)].join('\n'), r)
        return 0
      }
      if (a1 === 'where') { const r = await d.draftRoot(ctx); c.out(`${r.where}${r.configured ? '' : ' (the default)'} → ${r.dir}`, r); return 0 }
      if (a1 === 'use') { const r = await d.useDraftRoot(ctx, c.flag('default') ? null : a2 ?? (() => { throw c.usage('wfe catalog draft use (shared://<share>/<folder>/ | <absolute folder> | --default)') })()); c.out(r.message, r); return 0 }
      if (a1 === 'new') { const r = await d.createDraft(ctx, { text: await optText() ?? '', tags: csv('tags'), path: c.opt('path'), of: c.opt('of'), ofBase: c.opt('of-base'), by: author() }); c.out(r.message, r); return 0 }
      if (!a2) throw c.usage(`wfe catalog draft ${a1} <id>`)
      if (a1 === 'show') {
        const r = await d.readDraft(ctx, a2, { revision: c.opt('revision') ? Number(c.opt('revision')) : undefined })
        const x = r.draft
        c.out([`draft ${x.id}, revision ${x.revision}${r.snapshot ? ` (a snapshot; the draft is at revision ${r.current})` : ''}, sha256 ${x.sha256.slice(0, 12)}; ${x.state}${x.path ? `; path ${x.path}` : ''}`,
          `tags: ${x.tags.join(', ') || 'none'}; saved by ${x.saved.by} at ${x.saved.at}`, '', x.text].join('\n'), r)
        return 0
      }
      if (a1 === 'save') { const r = await d.saveDraft(ctx, a2, { text: await optText(), tags: csv('tags'), path: c.opt('path'), base: rev(), by: author() }); c.out(r.message, r); return 0 }
      if (a1 === 'remove') { const r = await d.removeDraft(ctx, a2, { by: author() }); c.out(r.message, r); return 0 }
      if (a1 === 'preview') {
        const r = await d.previewRegistration(ctx, a2, { path: c.opt('path') })
        c.out([`would register revision ${r.revision} as ${r.path ?? '(no path yet)'} (catalog ${short(r.head)}); tags: ${r.tags.join(', ') || 'none'}`, ...r.problems.map(p => `  problem ${p}`), ...r.warnings.map(w => `  warning ${w}`)].join('\n'), r)
        return r.problems.length ? 1 : 0
      }
      if (a1 === 'register') { const r = await d.registerDraft(ctx, a2, { path: c.opt('path'), base: rev(), by: author(), reuseArchived: c.flag('reuse-archived') }); c.out(r.message, r); return 0 }
      throw c.usage('wfe catalog draft list | where | use | new | show | save | remove | preview | register')
    }
    if (sub === 'ask') {
      const d = await import('../server/catalogDrafts.ts')
      const k = await import('../server/catalogAsk.ts')
      const a3 = c.positional[3]
      const request = async (o: { workspace: string; workflow: string; text: string; author: string; receipt: string; node?: string }) => { const q = await c.request(o); if (!q.ref) throw c.refused(q.message); return { ref: q.ref, duplicate: /^Already/.test(q.message) } }
      const actionLine = (x: import('../server/catalogDrafts.ts').AskAction, i: number) => `  ${i + 1}. [${x.state}] ${k.actionWords(x)}${x.why ? `  (${x.why})` : ''}${x.result ? `\n     ${x.result.by}, ${x.result.at.slice(0, 16)}Z: ${x.result.message}` : ''}`
      if (a1 === 'list' || a1 === undefined) {
        const list = await d.listAsked(ctx)
        c.out(list.map(x => `${x.draft} ${x.id}  ${x.state}${x.kind ? ` (${x.kind})` : ''}  ${x.title}  ${x.requested.by} ${x.requested.at.slice(0, 16)}Z${x.run ? `  ${x.run.workflow}/${x.run.run}` : ''}${x.actions.length ? `  actions: ${x.actions.map(y => `${y.do} ${y.state}`).join(', ')}` : ''}`).join('\n') || 'Nothing is asked.', list)
        return 0
      }
      if (a1 === 'request') {
        const by = author()
        const hasText = !!c.opt('file') || c.opt('text') !== undefined
        if (!a2 && !hasText) throw c.usage('wfe catalog ask request (<draft> --base <revision> | --file <md> | --text <text>) --author <who>')
        const base = c.opt('base')
        if (a2 && (base === undefined || !/^\d+$/.test(base))) throw c.usage('--base <revision> is required with a draft: the revision you read')
        const r = await k.ask(ctx, { draft: a2, base: base === undefined ? undefined : Number(base), text: hasText ? await textArg() : undefined, by, request })
        c.out(`${r.message} Draft ${r.draft}, ask ${r.advice.id}.`, r); return 0
      }
      if (!a2 || !a3) throw c.usage(`wfe catalog ask ${a1} <draft> <ask>`)
      if (a1 === 'show') {
        const r = await d.readDraft(ctx, a2)
        const x = r.advice.find(y => y.id === a3)
        if (!x) throw c.refused(`draft ${a2} has no ask ${a3}`)
        c.out([`${x.id} on revision ${x.revision} (sha256 ${x.sha256.slice(0, 12)}): ${x.state}${x.kind ? `, read as ${x.kind}` : ''}${x.written ? `, by ${x.written.by} at ${x.written.at}` : ''}${x.dismissed ? '; dismissed' : ''}`, ...(x.ask ? ['', 'The owner asks:', x.ask, ''] : []), ...(x.written?.read ? [`read: ${x.written.read}`] : []),
          ...(x.text ? ['', x.text] : []), ...(x.actions?.length ? ['', 'actions:', ...x.actions.map(actionLine)] : []), ...(x.rewrite ? ['', '--- proposed text ---', '', x.rewrite] : [])].join('\n'), x)
        return 0
      }
      if (a1 === 'answer') {
        const f = c.opt('answer')
        if (!f) throw c.usage('--answer <md file|-> is required (write it outside the working copy, or give it on stdin)')
        const text = f === '-' ? await readStdin() : await readFile(f, 'utf8')
        const rw = c.opt('rewrite'), af = c.opt('actions')
        let actions: unknown
        if (af) try { actions = JSON.parse(await readFile(af, 'utf8')) } catch (e) { throw c.usage(`--actions: not a JSON list: ${(e as Error).message}`) }
        const r = await k.answerAsk(ctx, a2, a3, { text, kind: c.opt('kind'), actions, rewrite: rw ? await readFile(rw, 'utf8') : undefined, by: author(), head: c.opt('head'), read: c.opt('read') })
        c.out(r.message, r); return 0
      }
      if (a1 === 'fail') { const r = await d.failAdvice(ctx, a2, a3, { reason: c.opt('reason') ?? 'no reason given', by: author() }); c.out(r.message, { ok: true }); return 0 }
      if (a1 === 'dismiss') { const r = await d.dismissAsk(ctx, a2, a3, { by: author() }); c.out(r.message, r); return 0 }
      if (a1 === 'do' || a1 === 'decline') {
        const n = Number(c.positional[4])
        if (!Number.isInteger(n) || n < 1) throw c.usage(`wfe catalog ask ${a1} <draft> <ask> <n> --author <who>`)
        const r = a1 === 'do' ? await k.doAction(ctx, a2, a3, n, { by: author(), request }) : await k.declineAction(ctx, a2, a3, n, { by: author() })
        c.out(r.message, r); return r.ok ? 0 : 1
      }
      throw c.usage('wfe catalog ask request | list | show | answer | fail | do | decline | dismiss')
    }
    if (sub === 'links' || sub === 'link') {
      const l = await import('../server/catalogLinks.ts')
      if (a1 === 'request') {
        const by = author()
        const r = await l.linksRequest(ctx, { by })
        const q = await c.request({ workspace: r.workspace, workflow: r.workflow, text: r.text, author: by, receipt: r.receipt })
        c.out(q.message, { ...r, request: q.data }); return 0
      }
      if (a1 === 'suggest') {
        const f = c.opt('file')
        if (!f) throw c.usage('wfe catalog links suggest --file <json|-> --head <commit> --author <who> [--run <ref>]')
        let raw: unknown
        try { raw = JSON.parse(f === '-' ? await readStdin() : await readFile(f, 'utf8')) } catch (e) { throw c.usage(`the suggestion is not JSON: ${(e as Error).message}`) }
        const r = await l.suggestLinks(ctx, { suggestion: raw, head: c.opt('head') ?? '', by: author(), run: c.opt('run') })
        c.out(r.message, r); return 0
      }
      if (a1 === 'agree' || a1 === 'decline') {
        const numbers = c.positional.slice(2).map(Number)
        if (numbers.some(n => !Number.isInteger(n))) throw c.usage(`wfe catalog links ${a1} (<n>… | --all) --author <who>`)
        const r = await (a1 === 'agree' ? l.agreeLinks : l.declineLinks)(ctx, { numbers, all: c.flag('all'), author: author() })
        c.out(r.message, r); return 0
      }
      if (a1 !== 'show' && a1 !== undefined) throw c.usage('wfe catalog links request | show | suggest | agree | decline')
      const v = await l.links(ctx, { maxAgeMs: 0 })
      const s = v.suggestion
      c.out([s ? `suggestion ${s.id} on catalog ${short(s.head)}${s.behind ? ' (the catalog moved on since)' : ''} by ${s.by}${s.run ? ` (${s.run})` : ''}, ${s.at.slice(0, 16)}Z: ${s.open} open` : 'No links are suggested.',
        ...(s?.links ?? []).map(x => `  ${String(x.n).padStart(2)}. [${x.state}] ${x.braindump} ${x.kind === 'add' ? '→' : '✕ (drop)'} ${x.project}${x.quote ? `\n      “${x.quote}”` : ''}${x.why ? `\n      ${x.why}` : ''}${x.decided?.reason ? `\n      ${x.decided.reason}` : ''}`),
        ...(s?.uncovered.length ? ['  no project serves:', ...s.uncovered.map(u => `    ${u.braindump}: ${u.why}`)] : []),
        ...(s?.ungrounded.length ? [`  without a ground: ${s.ungrounded.join(', ')}`] : []), ...(s?.note ? [`  note: ${s.note}`] : []),
        v.pending.length ? `${v.pending.length} braindump${v.pending.length === 1 ? ' has' : 's have'} no suggested links yet: ${v.pending.join(', ')} (wfe catalog links request)` : ''].filter(Boolean).join('\n'), v)
      return 0
    }
    if (sub === 'rules' || sub === 'rule') {
      const r = await import('../server/catalogRules.ts')
      if (a1 === 'adopt') { const x = await r.adoptRule(ctx, { tag: c.opt('tag'), project: c.opt('project'), licence: c.opt('licence'), follows: c.opt('follows'), source: { braindump: c.opt('braindump'), commit: c.opt('at'), sentence: c.opt('sentence') }, author: author() }); c.out(x.message, x); return 0 }
      if (a1 === 'retire') { if (!a2) throw c.usage('wfe catalog rules retire <id> --author <who>'); const x = await r.retireRule(ctx, { id: a2, author: author() }); c.out(x.message, x); return 0 }
      if (a1 === 'share') { const v = c.positional[3]; if (!a2 || !v) throw c.usage('wfe catalog rules share <id> never|default --author <who>'); const x = await r.shareRule(ctx, { id: a2, share: v, author: author() }); c.out(x.message, x); return 0 }
      if (a1 !== 'list' && a1 !== undefined) throw c.usage('wfe catalog rules list | adopt | retire | share')
      const v = await r.rules(ctx, { maxAgeMs: 0 })
      c.out([...(v.problem ? [`rules.yaml cannot be read: ${v.problem}`] : []), ...v.rules.map(x => `${x.id}: ${r.followsWords(x)}${x.share === 'never' && x.kind !== 'licence' ? ' (share: never)' : ''}${x.sourceChanged ? `  [its source changed: ${x.sourceNote}]` : ''}\n  from ${x.source.braindump}@${short(x.source.commit)}: “${x.source.sentence}”\n  adopted by ${x.adopted.by}, ${x.adopted.at.slice(0, 16)}Z`)].join('\n') || 'No rule is adopted.', v)
      return 0
    }
    if (sub === 'disclosure') {
      const r = await import('../server/catalogRules.ts')
      if (a1 === 'agree' || a1 === 'decline') {
        if (!a2) throw c.usage(`wfe catalog disclosure ${a1} (<n> | licence) --author <who>`)
        const l = await import('../server/catalogLinks.ts')
        const x = await l.answerDisclosure(ctx, { n: a2 === 'licence' ? 'licence' : Number(a2), agree: a1 === 'agree', author: author() })
        c.out(x.message, x); return 0
      }
      const d = await r.disclosure(ctx, { maxAgeMs: 0, project: a1 })
      c.out(r.disclosureLines(d).join('\n'), d); return 0
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
      const rr = await import('../server/catalogRules.ts')
      if (a1 === 'check') {
        const x = await rr.publicationCheck(ctx, { source: c.opt('source'), maxAgeMs: 0 })
        c.out([`${x.where}: ${x.rules} rule${x.rules === 1 ? '' : 's'}${x.contract ? '' : '; no publication/github.toml (nothing is selected)'}`, ...rr.checkLines(x).map(l => `  ${l}`), x.refusals.length ? `Refused: ${x.refusals.length} selected file${x.refusals.length === 1 ? '' : 's'} may not be published.` : x.projectMentions.some(m => m.allowed === undefined) ? 'No rule refuses this selection; the publication tool refuses the private names above.' : 'No rule refuses this selection.'].join('\n'), x)
        return x.refusals.length || x.problem || x.projectMentions.some(m => m.allowed === undefined) ? 1 : 0
      }
      if (a1 === 'put') {
        if (!a2) throw c.usage('wfe catalog publication put <publication/…> (--file <f> | --remove) --author <who> [--base <commit>]')
        const f = c.opt('file')
        if (!f && !c.flag('remove')) throw c.usage('--file <f> or --remove')
        const x = await rr.putPublicationFile(ctx, { path: a2, text: f ? (f === '-' ? await readStdin() : await readFile(f, 'utf8')) : null, author: author(), base: c.opt('base'), message: c.opt('message') })
        c.out([x.message, ...x.check.map(l => `  ${l}`)].join('\n'), x); return 0
      }
      if (a1 === 'request') {
        const by = author()
        const r = await rr.publicationRequest(ctx, { target: a2, by, note: c.opt('note') })
        const q = await c.request({ workspace: r.workspace, workflow: r.workflow, text: r.text, author: by, receipt: r.receipt })
        c.out(q.message, { ...r, request: q.data }); return 0
      }
      if (a1 === 'add') { if (!a2) throw c.usage('wfe catalog publication add <path> --author <who>'); const x = await rr.publicationAdd(ctx, { id: a2, author: author() }); c.out(x.message, x); return 0 }
      if (a1 !== 'status' && a1 !== undefined) throw c.usage('wfe catalog publication status | check [--source <folder>] | add <path> | put <path> | request [<project>] | use <folder>')
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
        ...(r.check.rules ? ['', `Rules (${r.check.rules}): ${r.check.refusals.length ? 'this selection is refused' : r.check.projectMentions.some(m => m.allowed === undefined) ? 'no rule refuses this selection; the publication tool refuses a private name in it' : 'no rule refuses this selection'}`, ...rr.checkLines(r.check).map(l => `  ${l}`)] : []),
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
