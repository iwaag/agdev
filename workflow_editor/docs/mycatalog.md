# The catalog: braindumps, reviews, challenges, summonplans, shared projects (user_catalog p1, p2)

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

## One idea, three ranges

A **braindump** is a person's free description of what they want and why. It
is the ground for work and for the resources that work uses. The word is used
at three ranges:

| Range | Where | Grounds |
| --- | --- | --- |
| A run | `devdocs/runs/<workflow>/<run>/braindump.md` (docs/runs.md) | one run's work |
| A workflow | the workflow's `intent` | every run of that workflow |
| A user | `braindumps/episodes/<path>/braindump.md` in the catalog | the projects an installation has, and why |

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
  challenges/<id>/…                           # the owner's challenges (challenges.md in these docs)
  challenges.md                               # the index of what is not yet real: braindumps and challenges
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

### Braindumps

Free Markdown. A first-level heading on the first line is its title;
without one, the path is the title. There is no front matter and no required
structure, because writing one must cost almost nothing.

Every change is one commit in the catalog. Its Git author is the person or
agent whose words it holds (`--author`). The committer is `agdev`. Nobody's
signature is verified: an agent the person asked to write signs by being the
author.

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
  `braindumps/` or under `challenges/` is newer than the index's last change.
  A commit that only moves files does not count. It is shown as a note; the
  index is rewritten on request (`wfe catalog index request`, **Refresh the
  index** on the Catalog page), not automatically.

### Who keeps reviews and the index

No project owned the catalog's upkeep; the **summoner** does, because it is
the one project every installation has and it already reads the braindumps.
Its workflows `review` (one named braindump, or every braindump with no
review or changed after its review) and `index` are requested with `wfe
catalog review request [<path>]` and `wfe catalog index request`, or from the
Catalog page. Both write through `wfe catalog`, as `summoner-agent`. Without
a summoner the requests are refused with the reason; a person can still write
either by hand.

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
runs the forbidden-word check; nothing else checks a published text for
private names, so the owner reads it.

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
| `wfe catalog status` | `GET api/catalog` | repository, head, plan, braindumps (title, excerpt, review author and date, published) and their projects, the index, the challenges by state, projects with their grounds, issues |
| `wfe catalog braindump list` | (in `GET api/catalog`) | |
| `wfe catalog braindump show <path>` | `GET api/catalog/braindumps/<path>` | text, review, history, projects, plans |
| `wfe catalog braindump add <path> --file/--text --author` | `POST api/catalog/braindumps {id, text, author}` | 409 when it exists |
| `wfe catalog braindump edit <path> --file/--text --author [--base <commit>]` | `PUT api/catalog/braindumps/<path> {text, author, base?}` | 409 when changed after `base` |
| `wfe catalog braindump remove <path> --author [--force]` | `DELETE api/catalog/braindumps/<path> {author, force?}` | refused while a plan's `because` names it, unless forced; removes its review too |
| `wfe catalog review show <path>` | `GET api/catalog/reviews/<path>` | the review, its history, whether the braindump changed after it |
| `wfe catalog review put <path> --file/--text --author [--base <commit>]` | `PUT api/catalog/reviews/<path> {text, author, base?}` | 404 without the braindump; 409 when changed after `base` |
| `wfe catalog review request [<path>] --author` | `POST api/catalog/reviews/request {path?, author}` | requests the summoner's `review`; 409 without a summoner |
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
or `null`) and `changedAfterReview`. `GET api/catalog` carries no full text:
a braindump's `text` and its review's are in `GET
api/catalog/braindumps/<path>`.

The browser shows the same data under **Catalog** on Home (`#/catalog`;
`#/mind` redirects). The page opens with the index (rendered, with its author
and date, the note when something changed since, **Refresh the index**).
Below it are the braindumps grouped by folder path, as titles with excerpts;
a braindump's text and review are read when it is opened, and edited in the
same place; **Ask for a review** is on each. Then the challenges by state,
each linking to its challenge page. Braindumps, reviews and the index are
rendered as Markdown; HTML in a text is shown, not run. Each braindump and
challenge is marked published or internal. A relation diagram and the
projects follow. Each project page has a "Why
this project exists" section. A project with no ground is shown as having
none. It is not hidden.
