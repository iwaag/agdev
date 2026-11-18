# The catalog: braindumps, reviews, challenges, summonplans, shared projects (user_catalog p1–p6, p6 ex1–ex2)

agdev's core is the workflow and the record of *why* projects exist. The
projects themselves (warden, ponderer, aghangout and every other) are outside
the core: an installation summons them. What a user wants, what was made of
it, and where that is found, is written down in one place per user: the
**catalog**, the repository `<owner>/mycatalog`.

"Catalog" alone always means this repository: in documents, `wfe catalog`,
`api/catalog`, the **Catalog** page and the area files. The node catalog
(reusable node templates) is a different thing: [node-catalog.md](node-catalog.md).

## What a catalog is

A catalog is the record of what drives one's development: the motives, wishes,
thoughts, problems and ideas (**braindumps**), and where the results of that
development are found. It also holds what lowers the cost for others to use
those results or learn from them, and an assessment of how far each braindump
has become real (**reviews**).

It holds what is **not yet real** too, because a record of what one made and
how is the natural place for what one has not made, and publishing that in
the right range lets someone who can make it join. What is not yet real has
two origins, and they stay two kinds:

| Kind | Comes from | Where | Written by |
| --- | --- | --- | --- |
| A **braindump** that was not carried out | above: a wish | `braindumps/episodes/<path>/`, with its review saying what is not real | the person, or an agent they asked |
| A **challenge** | below: a problem met during work | `challenges/<id>/`, with trials and evidence ([challenges.md](challenges.md)) | anyone working, often an agent, through `wfe challenge` |

Neither becomes the other: a challenge is not rewritten as a braindump when
it grows, and a braindump is not filed as a challenge when it waits. The
**index** (`challenges.md`) lists both.

By range, the catalog is two things:

- **The cluster's copy** (this repository, on the cluster's Gitea) is the
  catalog of everything this cluster is meant to make real: every braindump,
  review, challenge and plan.
- **The published part** (GitHub, `<user>/mycatalog`) holds the problems and
  ideas the owner judges should be worked on in the open, and the results
  that may serve others and deserve to be kept under version control for
  long. Nothing is public unless the owner lists it.

There is **one catalog per user**. The copy on GitHub is the published part
of the same repository, not a second catalog. There is no catalog per node or
per installation: `summonplans/<name>.yaml` is the part that belongs to one
installation.

## Three ranges, three words

What is wanted, and why, is stated at three ranges, each with its own word
(user_catalog p3):

| Range | Word | Where | Grounds |
| --- | --- | --- | --- |
| A run | a **request** | `devdocs/runs/<workflow>/<run>/request.md` ([runs.md](runs.md#input)) | one run's work |
| A workflow | an **intent** | the workflow's `intent` | every run of that workflow |
| A user | **braindumps** | `braindumps/episodes/<path>/braindump.md` in the catalog | the projects an installation has, and why |

A **braindump** is a person's free description of what they want and why, kept
in their catalog (or in a development episode). A run's input was called a
braindump until user_catalog p3; it is a request, whether a person or an agent
made it. Beside the braindumps the catalog holds the owner's **preferences**
(`preferences/<name>.md`): how the owner wants work done, given to every run
(*Preferences* below). A braindump says what is wanted and why; a preference
says how; facts about hosts are in neither.

A project's own `intent` (`project.yaml`) still describes the project itself.
The relation between a user's braindumps and the projects of an installation
is recorded in a **summonplan**, not in the projects: the same project can be
grounded differently in two installations.

## Layout

An ordinary Gitea repository with a fixed name, `mycatalog`, owned by the user
it belongs to.

```text
mycatalog/
  mycatalog.yaml                              # ag.mycatalog.v1: owner, title
  projects.yaml                               # ag.projects.v1: the projects this user shares
  braindumps/episodes/<path>/braindump.md     # free text
  braindumps/episodes/<path>/review.md        # free text, optional
  braindumps/episodes/<path>/metadata.yaml    # ag.braindump-metadata.v1: optional tags
  braindumps/archive/<date>/<path>/…          # archived braindumps with their reviews; README.md lists them. Not read
  challenges/<id>/…                           # the owner's challenges (challenges.md in these docs)
  challenges.md                               # the index of what is not yet real: braindumps and challenges
  preferences/<name>.md                       # free text: how the owner wants work done; given to every run
  summonplans/<name>.yaml                     # ag.summonplan.v1; one per installation or style
  publication/                                # what the published part holds (optional)
  README.md
```

**Free text stays free; YAML stays checked.** The layout is advice: it is
written in the `README.md` that `wfe catalog init` generates, where a new user
sees it. agdev acts on the YAML files, so those are validated. It reads
braindumps by one rule only.

The marker file is `mycatalog.yaml`, not `catalog.yaml`: a reader of the
earlier layout that finds a `catalog.yaml` expects the project list, and must
fail clearly instead of misreading.

### The one rule for braindumps

**Any `braindump.md` under `braindumps/episodes/`, at any depth, is a
braindump. Its folder path below `braindumps/episodes/` is its identity. A
`review.md` beside it is its review. Every other file there is the owner's
and is not read.**

- An episode is a thought, or thoughts the owner grouped as they like:
  `summoning/`, or `agdev_philosophy/p3/`. Splitting into `p1/`, `p2/` is one
  person's style, not a recommendation. A folder may hold a braindump and
  have folders with braindumps below it.
- Each path segment is lower-case letters and digits, with `-`, `_` and `.`
  inside (`^[a-z0-9][a-z0-9_.-]{0,63}$`); at most 8 segments. A folder whose
  name does not match is not entered.
- `because` names the file: `braindumps/episodes/<path>/braindump.md`.
- Moving a folder makes a different braindump.
- Only `braindumps/episodes/` is read. A `braindump.md` below
  `braindumps/archive/` is not a braindump (*Archiving* below).

### Braindumps

Free Markdown. A first-level heading on the first line is its title (a line
of tags only, such as `#public #todo`, above it does not count);
without one, the path is the title. There is no front matter and no required
structure, because writing one must cost almost nothing.

Every change is one commit in the catalog. Its Git author is the person or
agent whose words it holds (`--author`). The committer is `agdev`. Nobody's
signature is verified: an agent the person asked to write signs by being the
author.

### Writing a braindump (p6 ex2)

On the Catalog page:

1. Write in the field at the top. It is saved as you type (outside Git; *Saved* says so).
2. Press **Put it in the catalog**. The text becomes a braindump in one commit in your name. Its
   path is given by the service from the first line (`# Calm mornings` → `calm-mornings`; a title
   with fewer than three of `a-z 0-9` → `note-<yyyymmdd>`), never a taken path or one that an
   archived braindump held (then `-2`, `-3`, …). Words such as `#style` in the text are its tags.
3. Later, read the review on its card: the summoner is asked by itself (*The follow-up*), and the
   card shows *the summoner is reading it* meanwhile. Where tags are suggested, answer **OK** (all
   of them) or **No** on the one line.

**Ask** gives the text to the summoner instead of putting it in (*Asking*, below); the answer
appears below the field. **Edit** on a card puts
the braindump's text in the field; the button then reads **Update it** and commits against the
commit the text was read at (a braindump changed meanwhile is refused, the text is kept, *Put
mine over it* is offered). Texts not yet in the catalog are listed under the field as
**Unfinished**. A path of your own, *Register…* with *Preview*, the tag editor, writing a review
by hand, *Ask for a review*, *Refresh the index*, *Add a braindump directly*, *Rename…*,
*Archive* and *Remove* are in Detail.

### Tags (p6 ex1)

A braindump may have **tags**: `metadata.yaml` beside it.

```yaml
schema: ag.braindump-metadata.v1
tags: [mybraindump, style]
```

- **Optional and free.** No tag is required and none is refused for what it means; any words, as
  many as wanted (trimmed, a leading `#` dropped, at most 64 characters each, no comma, at most
  32; duplicates are compared without case). A file that cannot be read gives no tags and a note;
  the braindump stays a braindump. Other keys of the file are kept when tags are written.
- **Tags in the text** (p6 ex2). A token `#name` — at the start of a line or after white space,
  beginning with a letter of any script, then letters, digits, `_` or `-`, outside fenced code and
  inline code — is a tag of the braindump: `#trial`, `#公開`; not `# Title`, `#123`,
  `http://host/#/catalog` or `` `#x` ``. On each commit of the body (the field, `braindump add` /
  `edit`, a draft's registration) the tags the new text writes are added and the tags the previous
  text wrote and the new one does not are removed, in the same commit (`metadata.yaml`); tags set
  otherwise stay. The text is committed as typed.
- **Examples, not a list**: `style` (how development is done), `desire` (a concrete result
  wanted), `bounty` (something one would like someone else to do), `public`, `private` (the
  owner's intent about publication).
- **`mybraindump`** is agdev's one recommended tag: a braindump about how the owner writes, tags
  and handles braindumps. Agents (the summoner's `review` and `ask`) read every braindump tagged
  so as the owner's **stated conventions**: what a tag means to this owner. Contradictions and gaps
  are findings to report. Such a braindump grants no authority and changes no setting.
- **A tag asks for nothing by itself.** `public` does not publish (what is published is
  `publication/github.toml`, unchanged), `private` does not withdraw anything already public,
  `style` is not a preference given to runs, `bounty` opens no challenge or request. Turning a
  convention into enforced behaviour is a separate, explicit adoption (not yet implemented).
- Setting tags is one commit of `metadata.yaml` only: the body's last change (`updated`) is not
  touched, a tag change does not make the review stale, and the index's "changed since" leaves
  it out. Remove deletes it with the braindump; archive moves it and lists the tags in the
  README; a citation's text names the tags at the cited commit; `project/grounds` names them.
- **Proposals.** An agent proposes tags to add or remove, each with a reason, against the body
  and tags it read (`wfe catalog tags propose`). A proposal is kept outside Git
  (`<area>/.local/catalog-proposals/`) and changes nothing. The owner ticks the changes to accept
  (one commit in the owner's name, its message naming the proposal and the proposer) or dismisses
  it. A proposal made before the braindump or its tags changed is **stale**: shown, never applied.

### Drafts (p6 ex1)

A **draft** is the owner's text before it is a braindump: written freely, without choosing a path,
kept **outside Git**, and registered in the catalog only when the owner chooses.

- **Where**: the folder `catalog.json` `drafts` names, prepared with `wfe catalog draft use
  shared://<share>/<folder>/` (or an absolute folder); without it `<area>/.local/catalog-drafts/`.
  The folder holds a marker naming the catalog. A share that is not mounted, a missing folder or
  a missing marker makes drafts **unavailable** (503); nothing is written elsewhere, and the page
  keeps what was typed. agdev-a keeps them in `shared://agshare/catalog-drafts/`.
- **What a draft is not**: a ground, a citation, an entry of the index, something reviewed or
  published. A draft's tags are its own until registration.
- **Saving**: each save is a new revision (an integer) with the text's sha256, written atomically;
  a save names the revision it was made on and is refused when someone saved after it. The page
  saves as one types and says *Saving…*, *Saved, revision n*, or *Not saved: why* — the text stays
  in the editor, and this browser also keeps a copy of text that never reached the service.
- **Asking**: *Ask* freezes the saved revision and queues the summoner's workflow `ask` on the
  area's local worker (where the draft can be read); see *Asking (p7)*. The answer is kept beside
  the draft, labelled with the revision it read; an answer on an older revision says so. Nothing
  is registered by asking.
- **Registering**: the path is optional (p6 ex2): without one the service gives it as in *Writing a
  braindump*. A draft made with `of: <path>` and `ofBase: <commit>` (the page's *Edit*, `draft new
  --of`) is a change of that braindump: registering it is an edit against that commit, with the
  same receipt and trailer; a braindump changed meanwhile answers 409 `changed`. The page's main
  button is `POST api/catalog/drafts/<id>/put`: save, then register, in one call.
  Detail's *Register…*: choose a path, preview (the text, tags, problems, a warning when the path was a
  braindump that is now archived), register. It is one catalog commit of `braindump.md` and
  `metadata.yaml`, in the owner's name, of exactly the previewed revision. A taken path is refused
  and the draft is unchanged; an archived path needs a confirmation that it is the same braindump.
  The draft records a receipt before the commit and is marked registered only after the commit is
  read back; a retry after an unknown result finds the earlier commit (its `Draft-Registration`
  trailer) before making one. Registering publishes nothing, maps no project and writes no
  preference. The draft and its advice stay until the owner removes them.
- **Records and retention**: the draft, its snapshots and advice are files in the draft folder.
  The advice run's request, node outcomes and run folder (committed to the summoner's repository)
  hold ids, hashes and counts only. The model harness's session log on the executing host does
  keep what the agent read and wrote; it is outside Git, and it is a record of the text.
- **Limits**: advice runs only on the local worker; with drafts on a share another host could
  read, a remote worker still does not read them. Drafts have no history beyond their snapshots
  for advice; removal is final.

### Asking (p7)

The field has a second button, **Ask**. **The button decides what the text is; the service never
guesses**: *Put it in the catalog* makes the text a braindump; *Ask* gives it to the summoner to
read and answer, and nothing of it enters the catalog. The text may be an unfinished braindump
(the answer is advice on it: ambiguities, related braindumps, possible projects, your
conventions), an instruction ("suggest the links", "rename this braindump", "make my tag
conventions rules") or a question. A text that holds a wish and an instruction is put and asked
in two steps.

The summoner's workflow `ask` answers in words and may propose **at most a few actions from a
fixed list**, each one line under the answer with **Do it** and **No**:

| Action (`do`) | **Do it** carries out |
| --- | --- |
| `suggest-links` | asks the summoner to suggest links for the whole catalog (*Links*) |
| `review` (one braindump, or those that are due), `index` | the request the buttons of Detail make |
| `tags` | tags of one braindump in one commit in your name, or of the asked text; its line is **OK** / **No** |
| `rename`, `archive` | *Renaming*, *Archiving*, of the one braindump named |
| `use-text` | the summoner's rewritten text becomes your text in the field; nothing is put in |
| `adopt-rule`, `retire-rule` | *Rules* |
| `hand-over` | a request to the workflow `freework` of the project that holds the `facilitation` role, with your text as the request |

Nothing is done before the click, and the service carries the action out, not the run. An action
the writer refuses (a path taken meanwhile) says why on its line and can be tried again. What
fits none of the actions is answered in words only. No action removes a braindump, writes a plan
entry's `source`, `commit` or `roles`, summons or retires a project, or publishes. The hand-over
is the way out for everything that is not about the catalog, and **the one action that puts the
text into Git** (the request of that run): its line says so.

**What stays outside Git**: the asked text and the answer, beside the draft in the drafts folder
(`<draft>/advice/<ask>.json`, `ag.catalog-ask.v1`: the kind the summoner read the text as, its
words, each action with its state). The run's request names the draft and the ask by id; its
record has ids and counts only. The summoner does not read `braindumps/archive/`.

Under the field, after *Unfinished*: **Asked**, one line per asked text with the state of its
answer and of its actions, until you press **Dismiss**. A text the summoner read as an
instruction or a question is listed there and not under *Unfinished*, and dismissing its last
answer removes the text; an unfinished braindump that was asked about stays in *Unfinished*.
Without a summoner here Ask says so and nothing is recorded.

### Links (p7)

A **link** is one item of a `because`: this braindump is a ground of that project. Links are
suggested by the summoner and agreed by the owner; nothing else writes them but a person editing
the plan (and `propose`, when it adds a project).

1. Write braindumps. The page then shows, under *Braindumps and projects*: *N braindumps have no
   suggested links yet:* **Suggest links** (or ask for it in the field).
2. The summoner's workflow `ground` reads the whole catalog at one commit and, for every project
   of this installation's plan and of `projects.yaml`, suggests the braindumps that ground it,
   each with the sentences of the braindump that say so; links that exist and that it would drop,
   with why; what no project serves; which projects have no ground. It adds and removes no
   project, writes no plan and does not read `braindumps/archive/`. Its only write is `wfe
   catalog links suggest`, kept outside Git (`<area>/.local/catalog-links.json`) with the commit
   it read; a newer suggestion replaces it. A quote that is not in the braindump at that commit
   refuses the suggestion.
3. The diagram draws suggested links dashed. Under it, *Suggested links*: one line per link with
   the quoted sentence, **OK** and **No**, and **OK to all**. One click is one commit in your
   name, writing `because` in the plan and, where the project is listed there, in `projects.yaml`
   (the plan's `grounds` becomes the commit it was written on). A link whose braindump or project
   is gone by then is dropped, not written. *OK to all* is every suggested addition; a suggested
   drop is answered on its own line.
4. The follow-up then asks for the review of the braindumps whose links changed (a review reads
   the projects its braindump grounds), then for the index.

Links are suggested when you ask, not by themselves. "No project serves this" is one line on the
braindump's card; a project without a ground stays in Detail's table. Creating a project for a
wish is `propose` (reachable by the hand-over).

### Rules (p7)

What stays local and what is published follows the five principles of *What stays local, what is published* in the core's docs/external-publication.md; this section does not restate them.

Tags ask for nothing by themselves. A **rule** makes one of your own tag conventions binding: it
is adopted **by the owner, from a sentence the owner wrote** in a braindump tagged `mybraindump`.
Reading a convention never activates anything, yours or an imported one.

`rules.yaml` at the catalog's root:

```yaml
schema: ag.catalog-rules.v1
rules:
  - id: private-never-publish          # <tag>-<follows>
    tag: private
    follows: never-publish             # or suggest-publish
    source: {braindump: mybraindump, commit: <40 hex>, sentence: "…"}
    adopted: {by: <who>, at: <time>}
```

Two things can follow from a tag, no more:

- **`never-publish`**: the public file list cannot select the braindump or its review. `wfe
  catalog publication check` (and `status`) refuses a selection that holds either, naming the
  rule and its source, and reports every other selected file that names the braindump by its path
  or title (the index, another review) for you to read. `agdev-external-publish` refuses to build
  such a candidate by the same reading of `rules.yaml` at the pinned revision (it needs PyYAML for
  a catalog that has rules; a repository without `rules.yaml` is published as before). Adopting
  the rule does not erase what was public before.
- **`suggest-publish`**: a braindump so tagged and not in the public list shows **Add to the
  public list**, which appends its folder as a `[[tree]]` to `publication/github.toml` in one
  commit (`wfe catalog publication add <path>`). Nothing is pushed by it: publishing stays your
  act with the publication tool.

A braindump with both tags: `never-publish` wins and its card says so. With neither: nothing
follows. Other tags have a meaning, not a consequence.

**Adopting**: ask once in the field (for example "make my tag conventions rules"); the summoner
reads the `mybraindump` braindumps and proposes each rule as an action naming the braindump, its
commit and the sentence; **Do it** writes it in your name. Or `wfe catalog rules adopt`. The
service refuses a rule whose braindump is not tagged `mybraindump` or whose sentence is not in
its text at that commit. **A changed source**: when the source braindump changes after the
adoption, the rule stays in force and is marked *its source changed*; asking again proposes what
to adopt again, change or retire. Disclosure is never widened without a click. Simple shows a
rule only where it acts (a card kept private, a card suggested for the public list) and in an
answer that proposes one; the adopted rules with their sources and **Retire** are in Detail.

#### Rules on projects, and the default licence (p8)

What a braindump **states about a project's disclosure** becomes a rule the same way, from a
sentence of any braindump (not only `mybraindump`): `rules.yaml` is `ag.catalog-rules.v2` (v1 is
still read) and holds two more kinds.

```yaml
  - id: project-example-never-publish     # project-<project>-<follows>
    project: example
    follows: never-publish                # or publish
    source: {braindump: private_projects, commit: <40 hex>, sentence: "…"}
    adopted: {by: <who>, at: <time>}
  - id: default-licence
    follows: default-licence
    licence: CC0-1.0                      # an SPDX id
    share: never                          # the owner's own preference: never part of an imported style
    source: {braindump: note-20261117-2, commit: <40 hex>, sentence: "…"}
    adopted: {by: <who>, at: <time>}
```

- **`never-publish` on a project**: no tool of this installation publishes it.
  `agdev-external-publish` refuses `build`, `stage` and `push` for the project's workspace (code
  `rule`, naming the rule and its sentence), and the publisher declines a request for it in
  `scope`. Retiring the rule does not publish anything; adopting it does not withdraw what was
  public before (the page says so).
- **`publish` on a project**: the project is *to be published*; the Catalog page offers **Ask the
  publisher**, and the request names the rule as the owner's authorization for a new public
  repository `github.com/<owner>/pj-<id>`. What is worth publishing stays the publisher's
  judgment.
- **`default-licence`**: the licence of a project's first publication. The publisher uses it and
  asks only where the candidate holds another's material or the project states another licence.
  Existing public repositories keep theirs. `share: never`: a style import never shows or
  proposes it.
- **`share: never` on any rule** (improve_publish p1): the rule stays in this installation; it is
  neither published nor offered by a style import. `wfe catalog rules share <id> never|default`
  sets or removes it (one commit); the default licence is always `never`. Nothing forces a rule
  public.

#### Rules on run records, workflows and episodes (improve_publish p2)

What a braindump states about a **kind of content** of a project is a fourth kind of rule, from a
sentence of any braindump:

```yaml
  - id: runs-suggest-publish              # <content>[-<project>]-<follows>
    content: runs                         # runs | workflows | episodes
    project: gimmickimg                   # optional: this project only
    follows: suggest-publish              # or never-publish
    source: {braindump: agdev_philosophy/p4, commit: <40 hex>, sentence: "…"}
    adopted: {by: <who>, at: <time>}
```

- **`suggest-publish`**: the sentence is the criterion the publisher reads when it judges a
  project's runs (`wfe catalog disclosure runs <project>`). It selects nothing: each run the
  publisher proposes is published only after the owner's or Omni's answer on the list.
- **`never-publish`**: the publication tool refuses a contract that selects that content (code
  `rule`).
- A rule for one project decides over a general one; between equals `never-publish` wins.
- **Without a rule, run records and episodes stay local**: the publisher proposes none and the tool
  refuses to select them. Workflows follow their project (the publisher's guide); a `workflows`
  rule exists only when the owner states something about workflows.
- The `ground` run proposes them with the links, each with its sentence; a statement about one
  project's runs is a rule for that project. A proposed `never-publish` already refuses; a proposed
  `suggest-publish` does nothing until **OK**. `wfe catalog rules adopt --content runs [--project
  <id>] --follows suggest-publish|never-publish …` adopts one directly.
- Public form, as for every rule: public when its braindump is in the public list and it is not
  `share: never`; a rule naming a project kept private never is.

`wfe catalog disclosure` prints, after the projects, the statements on content in force and those
waiting for **OK**.

**One `rules.yaml`, published as its public part.** The file on Gitea holds every rule, private
and public, and is the only one the installation enforces. When it is in the public list, the
publication tool publishes it in a derived form: the rules whose braindump the list selects, that
are not `never-publish` on a project and not `share: never`, without `source.commit`, with
`adopted.by` the public account. It is selected as one plain `[[file]]`; nobody edits or trims it.
`wfe catalog publication status` (and `check`) prints a `rules` line: which rules are public, and
for each other one why not.

**Proposed by the summoner, answered by the owner.** The `ground` run (*Links*) also reads what
each braindump states about each project — *stated private*, *stated public*, or nothing, each
with its sentence; a tag on a braindump is not a statement about the projects it names — and the
default licence, and proposes them with the links. They wait under **Waiting for you** with **OK**
(adopt the rule, one commit) and **No**. A **proposed `never-publish` already refuses**: from the
proposal on, the tool refuses the project until the owner answers **No**. A proposed `publish`
does nothing until **OK**. Disclosure is never widened by a reading. Both stated for one project:
private wins, and the line says so.

`wfe catalog disclosure [<project>]` prints per project *private*, *to be published*, *public*
(with its repositories, from the workspace's publication journal), *public without a statement*
or *not stated*, the statement that decides and the default licence; `--json` is what the
publisher reads. `wfe catalog disclosure agree|decline (<n> | licence)` answers a proposal.

### Reviews

A review is free text about a braindump: what became real, where, and what
did not. It is `review.md` beside the braindump. It has no score, no state
field and no required structure.

- One commit per change; the Git author is the writer.
- "The braindump changed after its review" is derived from Git: the
  braindump's last content change is newer than the review's. It is shown as a
  note. Nothing inside `review.md` is needed for it. A commit that only moves
  a file does not count as a change of what it says.
- Removing a braindump removes its review with it.

### Archiving

A braindump that is no longer what the owner wants to stand on is
**archived**, not deleted (user_catalog p6): `wfe catalog braindump archive
<path>`, or **Archive** on its card. `--all` archives every braindump, to
clear a catalog in order before writing it again; that is a command only.

- **What moves.** `braindump.md` and `review.md` go from
  `braindumps/episodes/<path>/` to `braindumps/archive/<date>/<path>/` (the
  service's local date). A second archive on the same day adds to the same
  folder; a path already there gets a numbered folder (`<path>.2`), never an
  overwrite. Other files of the episode folder are the owner's and stay.
- **What it is afterwards.** No braindump: it grounds nothing, is not
  reviewed, not listed for the index, not offered for citing, and not
  validated. It stays readable in the repository's tree. `GET api/catalog` and
  `wfe catalog status` list the archive folders with their counts and links
  (`archived`); the page shows them at the end of *Braindumps* in Detail.
- **`because` is emptied of it, not rewritten.** The same commit takes the
  braindump out of every `because` in `summonplans/*.yaml` and in
  `projects.yaml`, keeping the files' comments and order. A list left empty
  is `because: []`, "no ground". No ground is written in its place; the
  agents of such a project are told that it has no ground here.
- **The mapping is kept.** `braindumps/archive/<date>/README.md` lists each
  archived braindump with its title, its last commit, its review, and the
  projects that named it, per plan and in `projects.yaml`. `--note` is
  written there and in the commit message.
- **One commit, and a tag before it.** The move, the README and the `because`
  changes are one commit, so that no commit of the catalog has a `because`
  that points at nothing. The tag `archive/<date>` (then `archive/<date>.2`,
  …) is set on its parent: the last state with the braindumps in place.
- **What was cited stays as it was.** Citation records are not edited. A
  message or a run that cited an archived braindump keeps the text at its
  pinned commit; where the citation is shown it says *removed*. A new
  braindump at the same path would be listed as cited by those, so a path is
  reused only when the same braindump is meant.
- **Not done by it.** The index is not rewritten (it is shown as older than
  the catalog; ask for it again). A `[[tree]]` of `publication/github.toml`
  that names the folder is reported and left to the owner.

`wfe catalog braindump remove` is for a braindump that should not be in the
tree at all; it stays only in the history, and is refused while a plan names
it.

### Renaming (p6 ex2)

`wfe catalog braindump move <path> <new path> --author <who>` (*Rename…* in Detail) is one commit:
the files directly in the braindump's folder move (`braindump.md`, `review.md`, `metadata.yaml`,
any other file there; folders below it are other braindumps and stay), and every `because` naming
it in `summonplans/*.yaml` and `projects.yaml` names the new path. A new path that holds a file,
or that an archived braindump held (unless `--reuse-archived`), is refused. What cited the old
path shows it removed, as after an archive; the follow-up rewrites the index.

### Challenges

The owner's challenges are in the catalog, under `challenges/<id>/`, in the
layout and with the contract of [challenges.md](challenges.md): `wfe
challenge`, `api/challenges` and the challenge pages are unchanged, and
`<area>/challenges.json` names the catalog as the challenge repository (`wfe
catalog init` writes it when the area has none). Every installation of one
owner on a cluster names that owner's catalog; a second user would have their
own, and sharing challenges between users is not built.

Two writers push to the repository: the catalog's (`server/catalog.ts`,
braindumps, reviews, plans, the index) and the challenge writer
(`server/challenges.ts`, through its journal). Each starts again from the new
head when its push is refused; neither force-pushes. A challenge attached to
a message or a run is pinned as `{id, commit}`, so the commits that hold
challenges are never rewritten. Evidence files (images, audio, video) stay in
Git; the published part leaves files out with `exclude`.

When `challenges.json` lists `mirrors`, the whole catalog is copied there:
after a challenge publication and after a catalog commit.

### The index: `challenges.md`

`challenges.md` at the root is the index of what is not yet real: for each
such thing its kind (braindump or challenge), a link, and one or two lines on
what is missing. A braindump with no review is listed as not reviewed, not
judged.

- **An agent writes it, not a parser.** Reviews are free text, so "not yet
  real" is a reading. The summoner's workflow `index` reads every braindump
  with its review and every challenge whose state is not `resolved` or
  `withdrawn`, and rewrites the file whole with `wfe catalog index put`, as
  its own author. Its first line says which catalog commit was read.
- **The core stores and shows it and reads nothing from it.** It is not a
  second place to keep state: a challenge's state is in its `summary.md`, a
  braindump's in its review.
- **"Changed since the index"** is derived from Git: the newest commit under
  `braindumps/episodes/` or under `challenges/` is newer than the index's last change.
  A commit that only moves files does not count. It is shown as a note; the
  index is rewritten by the follow-up after a braindump is put in, changed,
  renamed, archived or removed (p6 ex2), or on request (`wfe catalog index
  request`, **Refresh the index** in Detail).

### Who keeps reviews and the index

No project owned the catalog's upkeep; the **summoner** does, because it is
the one project every installation has and it already reads the braindumps.
Its workflows `review` (one named braindump, or every braindump with no
review or changed after its review) and `index` are requested with `wfe
catalog review request [<path>]` and `wfe catalog index request`, or from the
Catalog page. Both write through `wfe catalog`, as `summoner-agent`. Without
a summoner the requests are refused with the reason; a person can still write
either by hand.

### The follow-up (p6 ex2)

After a braindump is put in or changed (the field, `braindump add` / `edit`, a draft's
registration), the service asks the summoner by itself: the **review** of that braindump, then the
**index** once no review is waiting or open. A rename, an archive and a removal ask for the index
only. The requests are the ones the buttons make, in the name of the person who made the change,
and one open request per review or index holds (asking again returns the open run).

- **One round per two minutes**: a round starts two minutes after the first change noted since the
  last one; later changes join it. A change while its run is open starts the next round when the
  run ends.
- **When it is not done**: a run that ends (completed, cancelled, stopped) without a review newer
  than the braindump is asked once more; after that the card says *not reviewed* and why. A request
  that is refused (no summoner here, the queue refuses) is not retried. *Ask for a review* and
  *Refresh the index* in Detail remain; a later change starts over.
- **Where it is**: `<area>/.local/catalog-followup.json` (paths, names and runs; no text), written
  by the writers wherever they run on this host, acted on by the WFE service every 15 s. `GET
  api/catalog` carries it as `followUp`; the card links the run, which is an ordinary run of the
  summoner, seen and cancelled on its page.
- **Off**: `"followUp": false` in `<area>/catalog.json`. Nothing is noted, nothing is asked; the
  buttons work as before. (`WFE_NO_CATALOG_FOLLOWUP=1` keeps a service's loop off.)

### Preferences

`preferences/<name>.md` holds the owner's standing preferences: how they want
work done in every project (the language of documents, what a report starts
with, how a result is handed over). Free Markdown, one file per subject;
`<name>` follows the pattern of a braindump path segment. No front matter and
no manager field: the Git author is the writer.

- **Every file is given whole to every run and every authoring session**, as
  a system-scope context source `system/preference/<name>` whose provenance is
  the catalog repository, the path and the commit of the file's last change
  ([context.md](context.md)). A change is used from the next attempt. An
  installation without a catalog has no such sources; a catalog that cannot
  be read is noted and never stops an attempt.
- **What belongs where.** A preference says *how* the owner wants work done.
  A braindump says *what* is wanted and why. Facts about hosts (addresses,
  what runs where) are in neither: they stay in the system context's local
  blocks, which are not in Git.
- **Who writes.** The owner, on the Catalog page or with `wfe catalog
  preference put`. An agent may write one as its own author, and only what
  the owner said or confirmed (a lesson the owner agreed to, a correction the
  owner gave); it says in the commit message where the owner said it.
- **Publication** is the owner's choice, by the same file list as braindumps
  (`[[tree]]` for `preferences`). Nothing publishes them by default.

Until user_catalog p3 these were two local system blocks (`developer`,
`developer-preferences`). On an installation with a catalog the block store
refuses to create blocks with those ids and points here.

### `ag.mycatalog.v1`

```yaml
schema: ag.mycatalog.v1
owner: developer
title: "developer's catalog"
```

### `ag.summonplan.v1`

```yaml
schema: ag.summonplan.v1
name: my-plan                       # = the file name
intent: "one line on what this set of projects is for"
grounds: <commit of the catalog the plan was written against>
entries:
  - project: warden                 # the managed project id
    source: http://gitea.example/<owner>/pj-warden.git   # any Git URL
    commit: <sha>                   # exact revision (40 hex)
    because: [braindumps/episodes/nondeterministic-recovery/braindump.md]
    roles: {recovery: recover, coordination: coordinate}
    state: adopted
    note: optional free text
```

| Field | Meaning | Checked |
| --- | --- | --- |
| `grounds` | The catalog commit whose braindumps the plan was derived from. Braindumps may change afterwards; the plan still says which wording it followed. | 40 hex; missing = warning |
| `project` | The project id. | id pattern, unique in the plan |
| `source` | Where the project comes from: any Git URL. | http(s)/ssh/git/file URL, `user@host:path` or an absolute path |
| `commit` | The exact revision `wfe summon apply` acquires ([summon.md](summon.md)). | 40 hex; missing is an error for `summoned`, a warning for `adopted` |
| `because` | The braindumps that ground the entry. `[]` is allowed and shown as "no ground". Do not invent a ground to fill the field. | each `braindumps/episodes/<path>/braindump.md`, present in the repository |
| `roles` | Roles of the core this project fills (below). | known names, value shape, each role filled once |
| `state` | `adopted`: already present, described after the fact, never fetched. `summoned`: to be obtained from `source` at `commit`. | one of the two |

#### Roles

The core assumes these are filled. `wfe summon apply` records who fills them in
`<area>/roles.json` and derives the configuration keys each owns; what a project
must provide for a role, and what happens while one is not filled, is in
[summon.md](summon.md).

| Role | Value | What the core asks of it | Filled by (one installation's choice) |
| --- | --- | --- | --- |
| `recovery` | workflow | recovers runs the observer finds stuck or failed | warden `recover` (`submitters.json`, observer) |
| `coordination` | workflow | coordinates runs across workers and projects | warden `coordinate` (`workers.json` `coordination`) |
| `facilitation` | workflow | conducts facilitated conversations | ponderer `conduct` (`conversations.json` `facilitator`) |
| `conversation-archive` | `true` | holds archived conversations | ponderer (`conversations.json` `archive`) |
| `conversation-page` | `true` | serves the conversation page (`/hangout/`) | aghangout |
| `dialogue-renderer` | `true` | renders character dialogue lines | aghangout (`conversations.json` `dialogue.renderer`) |

### `ag.projects.v1`

`projects.yaml`: the projects this user shares, for a summoner to choose from. An entry has a plan
entry's shape without `state`: whoever writes a plan from it copies `project`, `source`, `commit`
and `roles`, and writes `because` from their own braindumps.

```yaml
schema: ag.projects.v1
owner: iwaag
projects:
  - project: ponderer
    source: https://github.com/iwaag/pj-ponderer.git
    commit: <sha>            # optional: a recommended revision
    description: "orchestration: …"
    roles: {facilitation: conduct, conversation-archive: true}   # optional: the core roles it can fill
    because: []              # optional: braindumps of this catalog behind it (they may stay private)
```

`roles` is checked like a plan's (known names, value shape), except that two entries may offer the
same role: choosing between them is the plan's work.

## The published part

What stays local and what is published follows the five principles of *What stays local, what is published* in the core's docs/external-publication.md; this part does not restate them. The catalog on Gitea is the one the installation acts on;
the public `<github user>/mycatalog` is its derivative.

Publication is the owner's choice. The repository always stays on the
cluster's Gitea. A copy on GitHub, if any, is made with the external
publication tools (docs/external-publication.md in the core), under the same
fixed name: `<github user>/mycatalog`. A summoner looks there for a user's
shared projects. What is public is what `publication/github.toml` lists;
everything else is private.

**What is public is chosen per braindump and per challenge.** The owner adds
one `[[tree]]` per folder to the file list:

```toml
[[tree]]                                   # a braindump with its review
public = "braindumps/episodes/summoning"
from = "source:braindumps/episodes/summoning"

[[tree]]                                   # a challenge without its evidence files
public = "challenges/ch-0004"
from = "source:challenges/ch-0004"
exclude = ["*.png", "*.mp4", "*.wav"]
```

`wfe catalog publication status` shows the public paths the list selects,
grouped as braindumps, reviews, challenges and the rest, and the last public
commit (from the journal of the folder the catalog is published from: `wfe
catalog publication use <folder>` records it in `catalog.json`). The Catalog
page marks each braindump and challenge **published** or **internal** from
the same reading. Before a push the publication tool shows the candidate and
runs the forbidden-word check and the search for the names of private
projects; the publisher still reads every file. When the owner adopted rules (*Rules*),
`wfe catalog publication check [--source <folder>]` says what they make of
the selection and exits 1 on a refusal, and the publication tool refuses a
candidate that holds a braindump a `never-publish` rule covers.

**What the check reads (p8).** Beside the tag rules: a selected `projects.yaml` whose `because`
names a braindump a tag rule keeps private is **refused** (an item whose braindump is merely not
public stays: it says that grounds exist). Every selected file that names a project kept private
is **refused** by the publication tool (improve_publish p1; `refused … names project` lines) unless
the contract has an `[[allow]]` for it with `found = "private:<id>"` and why the public text needs
the name (`project … kept by [[allow]]` lines); `check` exits 1 on a name not allowed. What tells
more than the name (what the project is, its state, its runs, its files) is removed or generalized
by the owning agent, never allowed. Braindumps no tag rule covers are listed as
*not decided*: they stay internal. `rules.yaml` joins the public list with the first braindump
tagged `mybraindump` (`wfe catalog publication add rules.yaml` adds it alone): it is what makes
the conventions more than words for a reader.

**Publishing it (p8).** Every publication of the catalog is a `publish` run of the publisher
(target `mycatalog`): the Catalog page's *The public list changed since the last publication:*
**Ask the publisher**, `wfe catalog publication request`, or the action `publish` of an answer.
The publisher reads every selected file, the reviews above all, and delegates the catalog's
changes to the summoner's workflow `catalog-publication-edit` (the catalog's owning agent), which
writes them through `wfe catalog publication put | add` and `review put` only; the check runs on
each written contract and refuses what a rule refuses. The Catalog page's **Public** section
lists what is public now (the catalog, the projects with their repositories), what waits (the
list changed, braindumps tagged for the list and not in it, projects to be published), what is
kept private and by which sentence, and what is not decided.

The owner of this core publishes `iwaag/mycatalog` with `projects.yaml`,
`mycatalog.yaml` (its `owner` becomes the public account) and a README, and
the braindumps and challenges its file list names. Summonplans stay internal.
An entry's `because` whose braindump is not published only says that grounds
exist; a published one can be opened. Nothing in the catalog
may hold host facts, credentials or cluster addresses that are not already in
a `source` URL. Cluster facts belong to the system context.

## How an installation finds it

`<area>/catalog.json`, written by `wfe catalog init`:

```json
{ "repository": { "id": 412, "owner": "developer", "name": "mycatalog" }, "branch": "main", "plan": "my-plan" }
```

`plan` names the summonplan that describes this installation. An optional
`publicationWorkspace` is the folder the catalog is published from. The repository
is also in the registry as category `catalog`. The service keeps its own
clone at `<area>/.local/catalog/`. It reads from that clone, refreshed from
Gitea at most every 10 s, and writes through it. Before each write the clone
is reset to Gitea, and a change counts only once Gitea has it. A push that
loses a race is tried once more on the new head. The clone never holds work
of its own. The Gitea credentials are the service's own (`gitea.json`).

`wfe catalog init` refuses when `<owner>/mycatalog` exists with content that
is not a catalog (no `mycatalog.yaml` with `ag.mycatalog.v1`). A catalog that
already exists is attached, not recreated. Installations that share one Gitea
user share one catalog.

### The layout before user_catalog p1

Earlier the repository was called the *mind repository*: `mind.yaml`
(`ag.mind.v1`), `catalog.yaml` (`ag.catalog.v1`), `braindumps/<slug>.md`,
`<area>/mind.json`, `<area>/.local/mind/`, registry category `mind`,
`wfe mind`, `api/mind`, `#/mind`. None of these is read any more.

- The area files are renamed once by the service at start (and by the first
  `wfe catalog` command), when only the old names exist. The registry's
  category `mind` is read as `catalog`.
- A repository with `mind.yaml` and no `mycatalog.yaml` is reported as an old
  layout. `wfe catalog migrate --author <a>` converts it in one commit: files
  moved, schema lines, every `because` in `summonplans/*.yaml` and
  `projects.yaml`, and the file entries of `publication/github.toml`.
  `--dry-run` prints the changes. It refuses on a repository already in the
  new layout. `README.md` is the owner's text and is not rewritten.
- A public catalog that still has `catalog.yaml` is not read by
  `wfe summon style`; its owner migrates and publishes again.

## Importing a development style

A public catalog, your own included, is a **reference** (principle 1 of docs/external-publication.md
in the core): importing reads it and proposes; nothing of it is adopted as it stands, and the local
rules built from it may say the opposite. A rule marked `share: never` is never offered.

A user who publishes `<github user>/mycatalog` on GitHub, public, with a valid
`projects.yaml` on `main`, has a development style that others can import by
naming the user: `wfe summon style <user> --author <who>`, `POST
api/summon/style {user, author, dryRun?}`, or *Import a development style* on
the Catalog page. The core reads `projects.yaml` at the head of `main`,
refuses a user without such a repository or with a list that has errors or no
projects, and requests `summoner/propose` with the wish to reproduce that
user's style, naming the catalog and the commit it read. The summoner proposes
the listed projects that are not present, explains them, and asks; nothing
is acquired, registered or wired before the person agrees in that run. A user's
catalog on another host is read only when a braindump or request names it; the
convention by user name is GitHub's.

## Citing a braindump

A person who talks in a conversation, or asks a workflow for work, can **cite**
braindumps of the catalog (user_catalog p4). Citing is offered and never
required: a request may stand alone.

- **What a citation is.** `{kind: braindump, id: <path>, commit, title,
  sha256}`: the braindump's path, the catalog commit it was cited at (the
  catalog's head when the message or request was accepted, or the commit named
  with `<path>@<commit>`), the title it had and the hash of its text then. A
  path or a commit that does not resolve is refused when the message is sent.
  Only this installation's catalog can be cited.
- **What the receiving run gets.** One file per cited braindump,
  `attachments/braindump-<path with "/" as "--">@<commit12>.md` (for example
  `attachments/braindump-agdev_philosophy--p3@0123456789ab.md`), and the
  reference with that file in `run.json` `input.attachments[]`. The file says
  what it is, then holds the braindump's text at the cited commit, its review
  as it was then with its author and date (or that none existed), and the
  names of the projects this installation's plan grounded on it then. The
  projects' records are not included. A later edit of the braindump never
  changes the file; `wfe catalog braindump show <path>` is the present text.
- **How it is labelled.** As the ground of this request: what the person
  stands on when asking. It is not an instruction to carry out in full, and it
  is not a preference. The run's brief names cited braindumps apart from
  challenges and files, in those words.
- **Where it is made.** `cites` on a person's message (`POST
  api/conversations/<id>/messages`, the creation route with `text`, the
  facilitation start; `wfe conversation post|start --cite <path>[@<commit>]`),
  and on a request (`POST api/workspaces/<id>/runs`; `wfe request … --cite`,
  `wfe run create … --cite`). In a conversation the citation is stored with
  the message, beside its challenges (the store's `attachments` rows, kind
  `braindump`), and every run started for that message is given it: a
  one-to-one partner's run, the conductor's, and a project's run the
  conductor asked about that message ([conversations.md](conversations.md)).
- **Changed since.** The conversation view lists the citations of each
  message with `changed` (the last change of the braindump's text when it is
  no longer what was cited, else `null`) and `removed`. What was cited stays
  as it was.
- **A preference is never cited.** Every run has every preference already. A
  challenge keeps its own attachment ([challenges.md](challenges.md)); the two
  kinds stay two kinds.

### Back references

Each citation is recorded where it is made, one line in
`<area>/.local/citations.jsonl`: `{braindump, commit, at, by, where}`, with
`where` a conversation's message (`{kind: conversation, conversation,
message}`) or a run whose request named it (`{kind: run, workspace, project,
workflow, run}`). A run started for a conversation's message is reached
through that conversation and has no record of its own. Runs and
conversations are never scanned for citations, and nothing from before
user_catalog p4 exists to be found.

`GET api/catalog/braindumps/<path>` and `wfe catalog braindump show <path>`
return them as `citedBy`, newest first, each with `label`, `href` (a run's
view; a conversation opens in the conversation client) and `changed` (whether
the text differs now from the cited commit). `GET api/catalog` gives the
count per braindump (`cited`). The summoner's `review` reads `citedBy` as
evidence of work done toward a braindump.

### From the Catalog page

An opened braindump card has, beside *Ask for a review*, **Talk about this**
(a new conversation in the conversation client with the braindump cited in
its composer: `<hangout>/?cite=<path>`) and **Request work** (a project and
one of its published workflows are chosen and the request is written; it is
sent as the person's request with the citation). Each entry of the index
that links to a braindump or to a challenge has the same two; an entry of a
challenge attaches the challenge (`<hangout>/?attach=<id>`, the request
route's `challenges`). The card lists **Cited by**. A preference card has
none of this.

## Why a project is here, in its runs

Every agent of a project the plan names is told why the project is here
(summoner p5): the run context's project scope has a source
`project/grounds` ([context.md](context.md)) with the plan's entry for the
project (state, source and commit, the roles it fills, its note), the full
text of each braindump in its `because`, and after each braindump its review
when it has one, labelled as a review with its author and date. A summoned
project's agent therefore knows that it was summoned, for what, on whose
words, and what of that was already said to be real. `wfe catalog why
<project>` shows the relation.

## Surfaces

`<path>` is a braindump's identity, for example `summoning` or `agdev_philosophy/p3`.

| CLI | API | |
| --- | --- | --- |
| `wfe catalog init [--title] [--plan <name>] --author <a>` | | create or attach |
| `wfe catalog status` | `GET api/catalog` | repository, head, plan, braindumps (title, excerpt, review author and date, published) and their projects, the index, the archive folders (`archived`), the challenges by state, projects with their grounds, issues |
| `wfe catalog braindump list` | (in `GET api/catalog`) | |
| `wfe catalog braindump show <path>` | `GET api/catalog/braindumps/<path>` | text, review, history, projects, plans, `citedBy` |
| `wfe conversation post … --cite <path>[@<commit>]`, `wfe request … --cite`, `wfe run create … --cite` | `cites` of `POST api/conversations/<id>/messages` and of `POST api/workspaces/<id>/runs` | cite a braindump (*Citing a braindump*) |
| `wfe catalog braindump add <path> --file/--text --author` | `POST api/catalog/braindumps {id, text, author}` | 409 when it exists |
| `wfe catalog braindump edit <path> --file/--text --author [--base <commit>]` | `PUT api/catalog/braindumps/<path> {text, author, base?}` | 409 when changed after `base` |
| `wfe catalog braindump remove <path> --author [--force]` | `DELETE api/catalog/braindumps/<path> {author, force?}` | refused while a plan's `because` names it, unless forced; removes its review too |
| `wfe catalog braindump archive (<path> \| --all) --author [--note <text>] [--dry-run]` | `POST api/catalog/braindumps/archive {path?, all?, author, note?, dryRun?}` | one commit: moved to `braindumps/archive/<date>/`, out of every `because`, listed in the folder's README; `--dry-run` prints the moves and each `because` that would change (*Archiving*) |
| `wfe catalog braindump move <path> <new path> --author [--reuse-archived]` | `POST api/catalog/braindumps/move {from, to, author, reuseArchived?}` | p6 ex2: one commit, `because` rewritten; 409 `taken`, `archived-path` |
| | `GET api/catalog` `followUp` | p6 ex2: per braindump `{state: waiting \| reading \| not-done, reason?, href?, run?, dueAt?}` and the index's; `openProposals` per braindump |
| `wfe catalog braindump list --tag <tag>` | (in `GET api/catalog`: `tags`, `metadata`, `proposals`) | braindumps with that tag |
| `wfe catalog tags show <path>` | (in `GET api/catalog/braindumps/<path>`: `tags`, `metadata`, `proposals`) | |
| `wfe catalog tags set <path> (--tags \| --add \| --remove) --author [--base <commit>\|none]` | `PUT api/catalog/braindumps/<path>?tags=1 {tags?, add?, remove?, author, base?}` | one commit of `metadata.yaml` |
| `wfe catalog tags propose <path> --file <json\|-> --author [--run] [--base]` | `POST api/catalog/tag-proposals {braindump, changes, author, run?, note?, base?}` | outside Git |
| `wfe catalog tags proposals [<path>] [--all]` | `GET api/catalog/tag-proposals[?braindump=&all=1]` | open ones, with `stale` |
| `wfe catalog tags accept <id> --tags add:a,remove:b --author` / `dismiss <id> --author` | `POST api/catalog/tag-proposals/<id> {accept \| dismiss, author}` | 409 `stale` |
| `wfe catalog draft list \| where \| use <root>` | `GET api/catalog/drafts` | |
| `wfe catalog draft new \| show <id> [--revision] \| save <id> --base \| remove <id>` | `POST api/catalog/drafts`, `GET\|PUT\|DELETE api/catalog/drafts/<id>` | 409 `stale` with the present revision |
| `wfe catalog draft preview <id> [--path]` / `register <id> [--path] --base [--reuse-archived]` | `POST api/catalog/drafts/<id>/preview\|register` | 409 `taken`, `archived-path`, `stale`, `changed` (p6 ex2, a draft `of` a braindump); 502 `unknown` keeps the receipt; no path: the service names it |
| `wfe catalog draft new --of <path> --of-base <commit>` | `POST api/catalog/drafts {text, of, ofBase, author}` | p6 ex2: a change of a registered braindump |
| | `POST api/catalog/drafts/<id>/put {text, base, author, path?, ofBase?, reuseArchived?}` | p6 ex2: the page's main button: save, then register |
| `wfe catalog ask request (<draft> --base \| --file \| --text)` / `list` / `show <draft> <ask>` | `POST api/catalog/ask {draft, base, author}`, `GET api/catalog/ask` | p7: queues `summoner/ask` on the local worker; 409 without a summoner |
| `wfe catalog ask answer <draft> <ask> --answer --kind [--actions] [--rewrite]` / `fail` | | p7: the run's answer; 400 names each action that cannot be taken |
| `wfe catalog ask do \| decline <draft> <ask> <n>` / `dismiss <draft> <ask>` | `POST api/catalog/ask/<draft>/<ask>/do\|decline\|dismiss {action, author}` | p7: `ok: false` with the reason when the writer refused |
| `wfe catalog links show` / `request` | `GET api/catalog/links`, `POST api/catalog/links/request {author}` | p7: the suggestion, the braindumps without one; requests `summoner/ground` (one open request per head) |
| `wfe catalog links suggest --file --head` | `POST api/catalog/links {suggestion, head, author, run?}` | p7: 400 names each link that cannot be taken |
| `wfe catalog links agree \| decline (<n>… \| --all)` | `POST api/catalog/links/agree\|decline {numbers \| all, author}` | p7: agree is one commit |
| `wfe catalog rules list` / `adopt` / `retire <id>` | `GET\|POST api/catalog/rules`, `POST api/catalog/rules/retire {id, author}` | p7 |
| `wfe catalog publication check [--source <folder>]` / `add <path>` | `GET api/catalog/publication/check`, `POST api/catalog/publication/add {path, author}` | p7: exit 1 on a refusal; 409 `rule` |
| `wfe catalog review show <path>` | `GET api/catalog/reviews/<path>` | the review, its history, whether the braindump changed after it |
| `wfe catalog review put <path> --file/--text --author [--base <commit>]` | `PUT api/catalog/reviews/<path> {text, author, base?}` | 404 without the braindump; 409 when changed after `base` |
| `wfe catalog review request [<path>] --author` | `POST api/catalog/reviews/request {path?, author}` | requests the summoner's `review`; 409 without a summoner |
| | | p6 ex1: a review, the index or advice asked again while the same one (same target and catalog head; for advice the same revision and question) is still open returns that run (`duplicate: true`) instead of a second one; the page shows "Asked: <run> (open)" in place of the button until the run ends |
| `wfe catalog preference list` | `GET api/catalog/preferences` | every preference with its text, author and date |
| `wfe catalog preference show <name>` | `GET api/catalog/preferences/<name>` | the text and its history |
| `wfe catalog preference put <name> --file/--text --author [--base <commit>]` | `PUT api/catalog/preferences/<name> {text, author, base?}` | creates or replaces; one commit; 409 when changed after `base` |
| `wfe catalog preference remove <name> --author` | `DELETE api/catalog/preferences/<name> {author}` | one commit |
| `wfe catalog index show` | `GET api/catalog/index` | `challenges.md`, its author and date, what changed since |
| `wfe catalog index put --file/--text --author [--base <commit>]` | `PUT api/catalog/index {text, author, base?}` | one commit; 409 when changed after `base` |
| `wfe catalog index request --author` | `POST api/catalog/index/request {author}` | requests the summoner's `index` |
| `wfe catalog publication status` | `GET api/catalog/publication` | the public paths the file list selects, grouped; the last public commit |
| `wfe catalog publication use <folder>` | | the folder the catalog is published from |
| `wfe catalog why <project>` | `GET api/catalog/why/<project>` | entry, braindumps, other plans |
| `wfe catalog plan show <name>` | `GET api/catalog/plans/<name>` | |
| `wfe catalog plan put <file> --author` | `PUT api/catalog/plans {text, author}` | validated against the repository; errors refuse |
| `wfe catalog plan check <file>` | | validate without writing |
| `wfe catalog plan use <name>` | | which plan describes this installation |
| `wfe catalog migrate --author <a> [--dry-run]` | | the earlier layout, in one commit |

In JSON a braindump carries `id` (its path), `path` (the file), `title`,
`excerpt`, `updated`, `published`, `review` (`path`, `updated`, `published`,
or `null`), `changedAfterReview` and `cited` (how many citations). `GET api/catalog` carries no full text:
a braindump's `text` and its review's are in `GET
api/catalog/braindumps/<path>`.

`excerpt` is the text's first words after its title line; a first paragraph
that is only a note in emphasis (`_…_`, as on a reconstructed braindump) is
skipped when text follows it.

The browser shows the same data under **Catalog** on Home (`#/catalog`;
`#/mind` redirects), in the two modes of every screen (the Simple/Detail
toggle in the page head; Simple when nothing is stored). Both modes are the
same page: Detail adds to what Simple shows.

| Part | Simple | Detail adds |
| --- | --- | --- |
| Drafts (p6 ex1) | **Write a draft**; the drafts with state, tags, revision, who and when; the editor (saved as typed, its status, tags, **Ask for advice**, the advice with its revision, **Register…** with a preview, **Remove the draft**) | the draft folder, the draft's id |
| Writing (p6 ex2, p7) | the field with **Put it in the catalog** and **Ask**; the summoner's answer with its actions (**Do it** / **No**), **Dismiss**; *Unfinished*; *Asked* | the path, the kind and revision an answer read, its run |
| Braindumps and projects (p7) | the diagram with suggested links dashed; *N braindumps have no suggested links yet:* **Suggest links**; *Suggested links* with **OK** / **No** / **OK to all** | the suggestion's commit, run and counts, the projects without a ground, **Suggest links again** |
| Rules (p7) | on a card: *Kept private by your rule*, **Add to the public list**, *No project serves this* | the adopted rules with their sources, *its source changed*, **Retire**, what the check says of the public list |
| Head | the catalog's title, **Write a draft** | the repository and head, the explanation, **Author of changes**, **Add a braindump directly** (one commit now, not a draft), the catalog's problems and issues (Simple says only how many there are) |
| Summary | four counts, each a way to its part: braindumps, entries of the index, open challenges, preferences; **Write the index** when there is none | |
| Braindumps | a grid of cards: title, two lines of excerpt, the grounded projects, one mark (reviewed, not reviewed, changed after its review). Folders are headings, after the braindumps that are in none. Tags as chips, and a row of the tags in use that filters the list. An opened card spans the grid: its tags with **Add tags**/**Edit tags** and the open tag proposals (a box per change, **Accept the ticked**, **Dismiss**), the text, the review, **Talk about this**, **Request work**. With no braindump: one sentence on what a braindump is, and **New braindump** | rows instead of cards; path, author, date, commit, the link to Gitea, published or internal, the cited count; **Edit**, **Archive** (its confirmation names the projects that lose this ground), **Remove**; the archive folders with their counts, linked to Gitea; the review's author and date, **Ask for a review**, **Edit review**; **Cited by** |
| Not yet real | one line per entry of the index (a list item that links to a braindump or a challenge): its kind as an icon, its title, the rest on one line. An entry opens to its full text with **Talk about this** and **Request work**. One line with **Refresh** when the catalog changed after the index. An index with no such entry is shown whole | the index's whole text as written, its file, author, date and commit; **Refresh the index**, **Ask for the reviews that are due** |
| Braindumps and projects | the diagram with the braindumps and the projects that have a ground; a project leads to its page. Not shown while there is no braindump | every project, with "no ground" and "not in plan"; a project leads to its row of the table |
| Challenges | those neither resolved nor withdrawn: title and projects, each linking to its challenge page | the other states, id, trials, who and when, published or internal |
| Preferences | each as a title and its first line; opened: the text | every text whole, its name, author, date, commit, the link to Gitea; **New preference**, **Edit**, **Remove** |
| Projects and why they are here | | the table |
| Import a development style | | the card |

A title that is the braindump's path, or that repeats in its folder, is told
apart in Simple by the last segment of the path. Free text is rendered as
Markdown; HTML in a text is shown, not run. The name changes are made in is
remembered per browser; when an action needs it and it is not known, the page
asks for it where the action was started. Each project page has a "Why this
project exists" section. A project with no ground is shown as having none. It
is not hidden.
