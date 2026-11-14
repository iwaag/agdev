# The mind repository: braindumps as grounds, summonplans (summoner p1)

agdev's core is the workflow and the record of *why* projects exist. The
projects themselves (warden, ponderer, aghangout and every other) are outside
the core: an installation summons them. What it summons, and why, is written
down in one place per user: the **mind repository**.

## One idea, three ranges

A **braindump** is a person's free description of what they want and why. It
is the ground for work and for the resources that work uses. The word is used
at three ranges:

| Range | Where | Grounds |
| --- | --- | --- |
| A run | `devdocs/runs/<workflow>/<run>/braindump.md` (docs/runs.md) | one run's work |
| A workflow | the workflow's `intent` | every run of that workflow |
| An installation, a user | `braindumps/<slug>.md` in the mind repository | the projects an installation has, and why |

A project's own `intent` (`project.yaml`) still describes the project itself.
The relation between a user's braindumps and the projects of an installation
is recorded in a **summonplan**, not in the projects: the same project can be
grounded differently in two installations.

## The repository

An ordinary Gitea repository with a fixed name, `mycatalog`, owned by the user
it belongs to (for example `<owner>/mycatalog`). The repository is called the
*mind repository* in this document and in `wfe mind`; its fixed name is the
name under which others find it.

```text
mycatalog/
  mind.yaml                  # ag.mind.v1: owner, title
  braindumps/<slug>.md       # free text; the file name is the identity
  summonplans/<name>.yaml    # ag.summonplan.v1; one per installation or style
  catalog.yaml               # ag.catalog.v1; projects this user shares
  README.md
```

**Publication** is the owner's choice. The repository always stays on the
cluster's Gitea. A copy on GitHub, if any, is made with the external
publication tools (docs/external-publication.md in the core), under the same
fixed name: `<github user>/mycatalog`. A summoner looks there for a user's
shared projects. The owner of this core publishes `iwaag/mycatalog`, with
`catalog.yaml` and `mind.yaml` only (its `owner` becomes the public account);
braindumps and summonplans stay internal, and a catalog entry's `because`
then only says that grounds exist. Nothing in the
mind repository may hold host facts, credentials or cluster addresses that
are not already in a `source` URL. Cluster facts belong to the system context.

### Braindumps

Free Markdown. An optional first-level heading on the first line is its
title. Without one, the slug is the title. There is no front matter and no
required structure, because writing one must cost almost nothing. The slug is
lower-case letters, digits and `-`. Renaming a file makes it a different
braindump.

Every change is one commit in the mind repository. Its Git author is the
person or agent whose words it holds (`--author`, as for a run's braindump).
The committer is `agdev`.

### `ag.mind.v1`

```yaml
schema: ag.mind.v1
owner: developer
title: "developer's mind"
```

### `ag.summonplan.v1`

```yaml
schema: ag.summonplan.v1
name: my-plan                       # = the file name
intent: "one line on what this set of projects is for"
grounds: <commit of the mind repository the plan was written against>
entries:
  - project: warden                 # the managed project id
    source: http://gitea.example/<owner>/pj-warden.git   # any Git URL
    commit: <sha>                   # exact revision (40 hex)
    because: [braindumps/nondeterministic-recovery.md]
    roles: {recovery: recover, coordination: coordinate}
    state: adopted
    note: optional free text
```

| Field | Meaning | Checked |
| --- | --- | --- |
| `grounds` | The mind commit whose braindumps the plan was derived from. Braindumps may change afterwards; the plan still says which wording it followed. | 40 hex; missing = warning |
| `project` | The project id. | id pattern, unique in the plan |
| `source` | Where the project comes from: any Git URL. | http(s)/ssh/git/file URL, `user@host:path` or an absolute path |
| `commit` | The exact revision `wfe summon apply` acquires ([summon.md](summon.md)). | 40 hex; missing is an error for `summoned`, a warning for `adopted` |
| `because` | The braindumps that ground the entry. `[]` is allowed and shown as "no ground". Do not invent a ground to fill the field. | each `braindumps/<slug>.md`, present in the repository |
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

### `ag.catalog.v1`

The projects this user shares, for a summoner to choose from. A catalog entry has a plan entry's
shape without `state`: whoever writes a plan from it copies `project`, `source`, `commit` and
`roles`, and writes `because` from their own braindumps.

```yaml
schema: ag.catalog.v1
owner: iwaag
projects:
  - project: ponderer
    source: https://github.com/iwaag/pj-ponderer.git
    commit: <sha>            # optional: a recommended revision
    description: "orchestration: …"
    roles: {facilitation: conduct, conversation-archive: true}   # optional: the core roles it can fill
    because: []              # optional: braindumps of this mind behind it (they may stay private)
```

`roles` is checked like a plan's (known names, value shape), except that two catalog entries may
offer the same role: choosing between them is the plan's work.

## How an installation finds it

`<area>/mind.json`, written by `wfe mind init`:

```json
{ "repository": { "id": 412, "owner": "developer", "name": "mycatalog" }, "branch": "main", "plan": "my-plan" }
```

`plan` names the summonplan that describes this installation. The repository
is also in the registry as category `mind`. The service keeps its own clone at
`<area>/.local/mind/`. It reads from that clone, refreshed from Gitea at most
every 10 s, and writes through it. Before each write the clone is reset to
Gitea, and a change counts only once Gitea has it. A push that loses a race is
tried once more on the new head. The clone never holds work of its own. The
Gitea credentials are the service's own (`gitea.json`).

`wfe mind init` refuses when `<owner>/mycatalog` exists with content that is
not a mind repository (no `mind.yaml` with `ag.mind.v1`). A mind repository
that already exists is attached, not recreated.

## Importing a development style

A user who publishes `<github user>/mycatalog` on GitHub, public, with a valid
`catalog.yaml` on `main`, has a development style that others can import by
naming the user: `wfe summon style <user> --author <who>`, `POST
api/summon/style {user, author, dryRun?}`, or *Import a development style* on
the Mind page. The core reads `catalog.yaml` at the head of `main`, refuses a
user without such a repository or with a catalog that has errors or no
projects, and requests `summoner/propose` with the wish to reproduce that
user's style, naming the catalog and the commit it read. The summoner proposes
the catalog's projects that are not present, explains them, and asks; nothing
is acquired, registered or wired before the person agrees in that run. A user's
catalog on another host is read only when a braindump or request names it; the
convention by user name is GitHub's.

## Why a project is here, in its runs

Every agent of a project the plan names is told why the project is here
(summoner p5): the run context's project scope has a source
`project/grounds` ([context.md](context.md)) with the plan's entry for the
project (state, source and commit, the roles it fills, its note) and the full
text of each braindump in its `because`. A summoned project's agent therefore
knows that it was summoned, for what, and on whose words. `wfe mind why
<project>` shows the same relation.

## Surfaces

| CLI | API | |
| --- | --- | --- |
| `wfe mind init [--title] [--plan <name>] --author <a>` | | create or attach |
| `wfe mind status` | `GET api/mind` | repository, head, plan, braindumps with their projects, projects with their grounds, issues |
| `wfe mind braindump list` | (in `GET api/mind`) | |
| `wfe mind braindump show <slug>` | `GET api/mind/braindumps/<slug>` | text, history, projects, plans |
| `wfe mind braindump add <slug> --file/--text --author` | `POST api/mind/braindumps {slug, text, author}` | 409 when it exists |
| `wfe mind braindump edit <slug> --file/--text --author [--base <commit>]` | `PUT api/mind/braindumps/<slug> {text, author, base?}` | 409 when changed after `base` |
| `wfe mind braindump remove <slug> --author [--force]` | `DELETE api/mind/braindumps/<slug> {author, force?}` | refused while a plan's `because` names it, unless forced |
| `wfe mind why <project>` | `GET api/mind/why/<project>` | entry, braindumps, other plans |
| `wfe mind plan show <name>` | `GET api/mind/plans/<name>` | |
| `wfe mind plan put <file> --author` | `PUT api/mind/plans {text, author}` | validated against the repository; errors refuse |
| `wfe mind plan check <file>` | | validate without writing |
| `wfe mind plan use <name>` | | which plan describes this installation |

The browser shows the same data under **Mind** on Home (`#/mind`): the
braindumps with their projects, a relation diagram, and editing. Each project
page has a "Why this project exists" section. A project with no ground is
shown as having none. It is not hidden.
