# Summoning: a plan's projects arrive in an installation (summoner p2)

A summonplan (`ag.summonplan.v1`, [mind.md](mind.md)) says which projects an
installation has, from which Git URL, at which commit, and which roles of the
core each fills. `wfe summon apply` makes the installation match it: it
acquires what is missing into the local Gitea, registers it, obtains a
workspace, and wires the roles. It is how projects arrive in a new
installation. The installer names no project.

## Acquisition

For an entry with `state: summoned`:

1. **Fetch.** The source is fetched into a service-owned bare mirror,
   `<area>/.local/summon/mirrors/<host>/<path>.git`, all branches, once per apply
   (a dry run fetches too: it is how it knows the commit exists). The entry's
   `commit` must be a commit of that mirror, on any branch; otherwise the entry is
   refused. The root's `project.yaml` at `commit` must name the entry's `project`.
2. **Local repository.** The target is `<gitea owner>/<repository name>` on this
   installation's Gitea. The name is the last path segment of `source`
   without `.git`. It is created when absent.
3. **Push, fast-forward only.** `commit` is pushed to the local `main`, with
   its history as it is. Nothing is stripped. If the local `main` already is
   `commit`, or contains it, nothing is pushed. If the local `main` is an
   ancestor of `commit`, `main` moves forward. Otherwise the entry is refused,
   and the refusal names both heads and their merge base. When they have no
   common history, the refusal says that they are unrelated. Merging is a
   person's or an agent's work, not apply's.
4. **Submodules.** `.gitmodules` is read at `commit`, and so is the gitlink of
   each path. A relative URL (`../x.git`) is resolved against `source`. Each
   submodule is acquired, recursively, at the commit the superproject pins and
   under the same owner, so that the relative URLs still resolve there. A
   submodule whose URL leaves that owner (`../../other/x.git`) or is absolute
   to another host is refused. It would not resolve after acquisition.
   For a submodule, fast-forward is checked against the pinned commit in the
   same way.
5. **Registration.** The root is registered as the project (`registerGiteaProject`,
   project id from its `project.yaml`). That id must equal the entry's
   `project`. Each submodule is registered with the category its path gives
   (`devdocs`, `study/…`, `wedo/…`, else `other`), the same rule the workspace
   view uses (`server/workspace.ts` `categoryOf`). Every acquired repository's
   registry entry records `upstream: {url, commit}`.
6. **Workspace.** When the project has no workspace here, one is obtained
   (`obtainWorkspace`). When it has one and `main` moved, its checkout is
   fast-forwarded if it is on `main` and clean. Otherwise apply reports that
   it was left as it is.

`state: adopted` entries are never fetched. Apply only uses their registered
project and workspace for the role wiring.

Repeating apply for a satisfied entry does nothing. Every step looks at what is
there.

### Reading a source that needs a credential

A source URL is fetched with no credential unless one of these applies:

- its origin is this installation's Gitea: the service's own token
  (`gitea.json`);
- the credential inventory (`<root>/config/credentials.json`, [credentials](../../docs/credentials.md))
  has an `active` entry of type `gitea-token` or `token` whose `target` has
  the same origin (scheme, host, port), stored as a file. Its value then
  reaches Git as an HTTP header for that origin only.

The value is never written into a URL, a remote, the mirror's configuration or a
record.

## Roles

`<area>/roles.json` is the one record of who fills which role here. Apply
writes it from the plan (adopted and summoned entries alike):

```json
{
  "schema": "ag.roles.v1",
  "plan": "my-plan", "mind": "<mind head the plan was read at>", "applied": "<time>",
  "roles": {
    "recovery":     { "project": "warden", "workspace": "warden", "workflow": "recover" },
    "coordination": { "project": "warden", "workspace": "warden", "workflow": "coordinate" },
    "facilitation": { "project": "ponderer", "workspace": "ponderer", "workflow": "conduct" },
    "conversation-archive": { "project": "ponderer", "workspace": "ponderer" },
    "conversation-page":    { "project": "aghangout", "workspace": "aghangout" },
    "dialogue-renderer":    { "project": "aghangout", "workspace": "aghangout" }
  }
}
```

The workspace is the project's registered workspace on this host (its first).
A role whose project has no workspace is reported and left unfilled.

Apply derives only the keys the roles own, and keeps every other key:

| Role | Derived key |
| --- | --- |
| `coordination` | `workers.json` `coordination` `{worker, lane, workspace, workflow}`. `worker` and `lane` are kept when present, else the default worker and `coordination`. |
| `facilitation` | `conversations.json` `facilitator` `{workspace, workflow}` |
| `conversation-archive` | `conversations.json` `archive` `{workspace}` |
| `dialogue-renderer` | `conversations.json` `dialogue.renderer` (the contract's path below). The other `dialogue` keys are kept. |
| `recovery` | `submitters.json`: the `Observer` submitter's workflows are `["<project>/<workflow>"]`. Other submitters are kept. |

A role that is not filled removes its key. The `Observer` submitter is then
removed. A file is written only when its parsed content changes. WFE reads
these files on each request, so no restart is needed.

The observer's configuration is the installer's: `agdevctl services-config`
(and `area-init`, `bootstrap-projects`) render `[recovery]` of the Observer's
`workflow.toml` from `roles.json`. They use `workflow = "<project>/<workflow>"`,
`workspace`, and `exempt` = the coordination workflow. When the recovery role
is not filled, they write `enabled = false`. Without a `roles.json` (an
installation that never applied a plan), the existing `[recovery]` section is
kept exactly as it is.

### What a project provides for a role

| Role | The project provides |
| --- | --- |
| `recovery`, `coordination`, `facilitation` | the named workflow in `devdocs/workflows/` |
| `conversation-archive` | a checkout WFE may write the archive into (`conversations/`, `discussions/`) |
| `conversation-page` | `scripts/deploy.sh`: builds the page from the checkout's `HEAD` and installs it under `$AGDEV_DEPLOY_DIR`, with `$AGDEV_DEPLOY_DIR/current/` being what `/hangout/` serves |
| `dialogue-renderer` | the same `scripts/deploy.sh`, leaving the renderer at `$AGDEV_DEPLOY_DIR/renderer-current/renderer/render.ts` (`node <it> <command>`, `ag.dialogue-renderer.v1`) |

`AGDEV_DEPLOY_DIR` is `<area>/hangout`, which the web origin mounts. Apply runs
the deployment as the service's account in the workspace's checkout,
after the workspace is obtained or moved, and when `<area>/hangout/current` is
missing. The deployment runs once per apply, even when one project fills both
roles. Its last output line is reported.

### Conversation participants

`conversations.json` `projects` is not a role. When apply obtains a summoned
project, the project takes part in conversations with the workflows it has:
`converse` when `devdocs/workflows/converse.yaml` exists, `discuss` when
`discuss.yaml` does. Apply adds such a project when it is not yet listed and
never removes one. Adopted entries leave the list as it is.

### Absent roles

The core assumes roles are filled. When one is not:

| Role | Behaviour |
| --- | --- |
| `recovery` | The observer opens the incident and alerts the owner. No recovery request is made. |
| `coordination` | One attempt per lane, as before coordination existed. |
| `facilitation`, `conversation-archive`, `conversation-page`, `dialogue-renderer` | The feature that needs the role says which role is not filled. |

## The journal

`<area>/.local/summon/journal.json` holds one apply: the plan, the mind commit
it was read at, its start, and for each entry the outcome so far (`done`,
`nothing`, `refused`, `failed`) with its steps. An entry an interrupted apply
finished stays `done` when the continuation finds nothing left. The journal is written after every
entry. An apply that finds an unfinished journal for the same plan continues it.
Entries already `done` are checked again, which is cheap and changes nothing,
and the rest are performed. A finished journal is kept as `last.json`.

## Status

`wfe summon status` compares, per entry, the plan's commit with the present
`main` of the project's registered root repository (the local `main` is fetched
into the mirror for that, never the source) and gives one indicator:

| Indicator | Meaning |
| --- | --- |
| `applied` | summoned, `main` is the plan's commit, workspace present, roles as planned |
| `ahead` | `main` contains the plan's commit and local work after it (run records, local changes). Normal after use. |
| `differs` | `main` is behind (apply moves it), diverged (apply refuses), or not comparable; the detail says which |
| `adopted` | adopted entry, registered with a workspace, roles as planned |
| `absent` | not on this Gitea, not registered, or no workspace |
| `unwired` | the roles in effect (`roles.json`) are not the planned ones |

Without a mind repository or a plan, status lists every role as not filled.
An installation's own runs make its entries `ahead` quickly. A plan revision can
then only fast-forward to a commit that contains that local work; otherwise
apply refuses and someone merges first (summoner p2, step 7).

## Bootstrap

`agdevctl bootstrap-projects --plan <file> [--dry-run]` is how a new
installation receives its projects: `wfe mind init` when there is no mind
repository, `wfe mind plan put` and `plan use` for the file, the dry run, then
`wfe summon apply --yes`, and the observer's settings rendered from
`roles.json` with a restart. Without `--plan` it applies the plan the mind
repository names, and continues an interrupted apply ([install.md](../../docs/install.md)).

When the mind names no plan yet, `bootstrap-projects` without `--plan` uses the
core's one reference, `install/bootstrap/summonplan.yaml`: one `summoned` entry,
the **summoner** (`https://github.com/iwaag/pj-summoner`), at an exact commit,
with no roles and no grounds. It is written as the plan named after the
installation's slug. The summoner's `propose` workflow then turns the person's
braindumps into the rest of the plan: it reads catalogs (`<user>/agdev-mind`),
proposes, asks, and only after agreement calls `wfe mind plan put` and
`wfe summon apply`. That is the only project the core names. Moving the
reference to a newer summoner is a change of that file's `commit`, published
with the core.

## Surfaces

| CLI | API | |
| --- | --- | --- |
| `wfe summon apply [<plan>] [--dry-run] [--yes]` | `POST api/summon/apply {plan?, dryRun?}` | default plan: `mind.json` `plan`. The CLI always shows the dry run first; without `--yes` it asks, and without a terminal it does not apply. |
| `wfe summon status [<plan>]` | `GET api/summon` | as above |
| `wfe summon acquire <source> <commit> [--name] [--project --register] [--dry-run]` | | one repository and its submodules, without a plan |

The Mind page shows the indicator as a chip in the Entry column of "Projects and
why they are here", with the detail, upstream and roles in its tooltip.
`/hangout/` answers 503 naming the conversation-page role while nothing is
deployed.
