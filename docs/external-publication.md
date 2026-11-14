# External publication

External publication makes an edited, selected **public** derivative of a project's internal
repositories, for example on GitHub. It is not the workflow publication of runs to Gitea and not
a mirror: the internal (Gitea) repositories stay the development authority, the public
repositories have their own histories, and every transfer between them is explicit and reviewed.

Tool: `install/agdev-external-publish` (Python 3.11+ standard library), installed with each
activation as `<installation>/config/install/agdev-external-publish`. `--help` lists the commands.

## Where things live

| What | Where | Versioned with |
| --- | --- | --- |
| Contract (what each public file is made from, destination, licence, forbidden strings, reviewed exceptions, submodules) | `<repository>/publication/github.toml` | the owning internal repository |
| Overlay (public-only text: README, NOTICE, licences, examples) | `<repository>/publication/overlay/` | the owning internal repository |
| Public checkout | `<workspace>/published/` (one repository) or `<workspace>/published/<name>/` (each repository of a graph) | the public repository |
| Journal (source/public pairs, staged work, conflicts, operations) | `<workspace>/.agdev/publication/github.json` | not versioned (internal) |
| Admitted workspace inputs, kept by sha256 | `<workspace>/.agdev/publication/inputs/` | not versioned |

Editorial decisions live in the contract and overlay, never only in a public checkout. Host
names, editorial rules and project settings stay in the project's contract; the tool has none.
`local_secrets` names workspace KEY=VALUE files whose values must not occur in a candidate; a
finding names the key, never the value.

## The contract (schema `agdev.publication.v1`)

```toml
schema = "agdev.publication.v1"            # forge.publication.v1 (P2) is still read at old revisions
destination = "https://github.com/<owner>/<repo>.git"
branch = "main"
visibility = "public"
license = "CC0-1.0"
local_secrets = ["forge.env"]              # optional
forbidden = ["internal-host", "/Users/"]   # literal, case-insensitive

[[allow]]                                  # a reviewed exception: file glob + finding label + reason
file = "NOTICE.md"
found = "internal-host"
why = "…"

[[tree]]                                   # a directory: every file under it, minus exclusions
public = ""                                # where it goes in the public tree ("" = the root)
from = "source:workflow_editor"            # source:<dir> | overlay:<dir>; "source:" = the whole repository
exclude = ["devdocs/runs", "**/*.local.*"] # globs relative to `from`; a glob matching a directory drops it

[[file]]                                   # one per public path; decides a path a [[tree]] also selects
public = "docs/route.md"
from = "overlay:docs/route.md"             # source:<path> | overlay:<path> | workspace:<path> (+ sha256 = "…")
[[file.edit]]                              # literal replacement; must occur `count` times (default 1)
old = "…"
new = "…"

[[submodule]]                              # published with this repository, dependencies first
path = "wedo/wedo-sfx"
contract = "publication/github.toml"       # the child's contract, inside the child repository

[[exclude]]                                # a submodule deliberately left out of the public tree
path = "private/thing"
why = "…"
```

A `[[tree]]` selects a whole directory at the pinned revision. It never copies gitlinks (submodules are
`[[submodule]]`s), `.gitmodules`, symbolic links, or the source's own `publication/` folder. Two trees
selecting one public path stop the build; a `[[file]]` for a path a tree selects replaces the tree's copy,
which is how a file inside a tree gets edits (for example dropping a workflow's `node:` pin). A tree that
selects nothing stops the build. The forbidden and secret searches cover every selected file, and every
selected file is still read before publication: a new file under a selected directory becomes public
with the next update, so read the delta.

Everything is read at one pinned revision (`git cat-file`), never from a work tree. A child's
input commit is the parent's **gitlink** at that revision; its relative `.gitmodules` URL is
resolved against the parent's internal remote; its own contract is read at that commit.

## Repository graph

- **Identity** of a repository = the path of its internal URL (`owner/name`), host-independent.
- **Traversal** is recursive: a declared submodule is prepared before its parent. The public
  `.gitmodules` is generated with each child's public destination, and the public gitlink is the
  child's *public* commit for that source commit, never a locally checked-out HEAD. A child published
  under the same host and owner as its parent gets `../<name>.git`: Git and `wfe summon` resolve it
  beside wherever the parent came from, and summon accepts only that form. A repository first
  published with absolute URLs keeps them publicly until that line is edited there (an update
  applies only the change between two candidates, and both now say `../<name>.git`).
- **Mapping** (journal, per repository): each publication records `source_rev`, `candidate_tree`
  (what the contract assembled), `public_commit` and `public_tree` (what was committed, which can
  differ once public edits were preserved), `public_base`, `gitlinks` (path, repository, child
  source revision, child public commit) and `status`. An internal-only change whose candidate
  equals the last published one is recorded as a pair that reuses that public commit.
- **Stopped before any write:** a submodule neither declared nor excluded; a declared one missing
  at the revision; a pinned commit not available locally or from the internal remote; a cycle;
  two repositories with one destination; a contract destination that differs from the journal's;
  a public file path colliding with a submodule path; a selected `.gitmodules`; and — **not
  supported** — one repository needed at two different revisions in one graph (the same revision
  at two paths is deduplicated).

## Operations

| Command | Effect |
| --- | --- |
| `plan [--rev R]` | the graph: identities, pins, destinations, checkouts, last pairs, problems |
| `build [--rev R] --out DIR` | every candidate in `DIR/<name>/` with its tree id and search findings |
| `stage [--rev R] --message M` | per repository, dependencies first: a first publication is a root commit; an update rebuilds the last published candidate, and applies the change from it to the new candidate onto the public head (fetched first). Refuses a checkout whose head is neither the remote nor the staged candidate |
| `resolve --repo ID --note …` / `abort --repo ID` | after a conflict: accept the resolved checkout (re-searched as the actual candidate) or drop it |
| `push [--stop-before ID]` | dependencies first; each push only after every gitlink's child commit is on its public branch; the remote is read before (already there → recorded as published, nothing pushed) and after (decides the outcome) |
| `status` | the journal |
| `convert-journal` | P2 forge journal → this schema, keeping `github.forge-v1.json` |

Pushes are ordinary branch pushes (`<commit>:refs/heads/<branch>`): no force, no mirror, no tags.
Pushes of several repositories are not atomic: a failed parent leaves an already published child in
place (it is a valid public commit), and `push` resumes from the journal. One lock file serialises
operations on a workspace.

**Ownership of a whole publication.** The lock covers one command. `stage --owner <O>` (a workflow run,
e.g. `publisher/publish/run-003`) records who the staging belongs to; `push`, `resolve` and `abort` then
need the same `--owner`; `push --operation <stage id>` refuses when the staging the caller assessed was
replaced; staging over another owner's unfinished staging (staged, partial, conflict) is refused unless
`--take-over <reason>`, which supersedes it and is recorded (`took_over`). Before each push the tool also
checks that the remote is still the recorded public base and the checkout is the staged commit.
Stagings without an owner (by hand) behave as before.

**Stop codes.** Every refusal prints `agdev-external-publish [<code>]: <reason>` and exits 1:
`conflict`, `stale-public-head`, `unavailable-source`, `child-not-public`, `graph`, `contract`,
`check-failed`, `checkout-state`, `owner`, `busy`, `infrastructure`, `usage`. A workflow maps them to
its next action; the code is a category, the reason says what to look at.

## Procedures

Run the installed tool (`<installation>/config/install/agdev-external-publish`) with
`--workspace <project workspace>`; the root source is `<workspace>/source`.

**First publication or update.** Change the internal repositories as usual; change the contract
and overlay where the public text must follow; commit and push them to Gitea (a child first, then
the parent's pin). `plan`, then `build --out <scratch>` and read every candidate file — the
searches assist, they do not prove a file may be public. `stage --message …`, check what the
delta touches, `push`. A new repository, visibility, licence or a scope change needs the owner's
decision on the concrete staged candidate; routine updates inside an approved scope do not.

**Partial graph publication.** Pushes are per repository, dependencies first, and each result
is journaled. After any stop (`--stop-before`, a refused or failed push, a lost session) run
`status`, then `push` again: repositories already published are skipped, a staged commit already
on its remote is recorded as published without pushing, and a parent waits until its children's
public commits are verifiable on their remotes. Nothing is rolled back.

**Public-side edits.** Edits made in a public repository (by the owner or a contributor) are
kept: `stage` fetches the public head and applies only the change between the last published
candidate and the new one onto it. The journal then records a public tree that differs from the
candidate tree. If a public edit is worth keeping internally, import it (below); otherwise it simply
stays public-only.

**Conflicts.** When the internal change and a public edit touch the same lines, `stage` stops with
the checkout in a cherry-pick and records base, desired candidates, files and output; `push` and
`stage` refuse until the conflict is settled. Either (a) `abort --repo ID`, change the contract,
overlay or source so the decision is recorded where it is owned, and stage again; or (b) resolve
in the checkout (`git add`, `git cherry-pick --continue`) and `resolve --repo ID --note …`, which
re-searches the resolved tree. When both sides changed the same line, recording the decision in the
overlay is not enough for a clean 3-way (the last *published* candidate still differs on both
sides): record it, stage, and resolve by taking the candidate side. Once that is published, later
updates apply cleanly.

**Importing a public correction.** Take the public commit's diff of the files concerned
(`git -C published/<repo> diff <base> <commit> -- <path>`) and apply it to the owning file — the
overlay (`git apply --directory=publication/overlay`), or the source file a `source:` entry selects
— commit with the public URL and author of the change, and push to Gitea. Do not merge the public
history. The next `stage` reports "already contained in the public head" and records the pair
without pushing.

**What is decided by people or agents, not by the tool.** What to select; how internal facts
become public statements (with dates, scope and evidence limits); reading every file; which
exceptions are acceptable; which samples may be published; how to resolve an overlap; which checks a
delta needs; whether a change of scope needs a new decision. The tool does the repeatable parts:
pinned builds, searches, deltas, graph order, public pins, journaled pushes and reconciliation.

## As a workflow

The managed project `publisher` serves publication requests about other projects with its `publish`
workflow (investigate and scope, edit a draft, assess and revise, have the owning project integrate the
change through its `publication-edit` workflow, publish and verify, record the outcome). It runs this
tool with `--workspace <target workspace> --source <draft clone>`, so the target's checkout is never
edited, and stages with its run as owner. See the publisher project's `agent/publish.md`.

A target project needs a `publication-edit` workflow (the project's own agent, the publisher's
`agent/source-change.md` guide) for the delegation; the core has one too.

## What is public, and where

| Public repository | What it is | Internal authority |
| --- | --- | --- |
| `github.com/iwaag/agdev` | this core (WFE, executor, observer, installer, docs) | the core's Gitea repository |
| `github.com/iwaag/pj-warden` | warden: the `recovery` and `coordination` roles | `pj-warden` |
| `github.com/iwaag/pj-ponderer` with `study-argue`, `wedo-argue` | ponderer: `facilitation`, `conversation-archive` | `pj-ponderer` and its submodules |
| `github.com/iwaag/pj-aghangout` | aghangout: `conversation-page`, `dialogue-renderer` | `pj-aghangout` |
| `github.com/iwaag/mycatalog` | the owner's catalog (`catalog.yaml`, `mind.yaml`) | the owner's mind repository |
| `github.com/iwaag/pj-forge`, `pj-agsfx`, `wedo-sfx` | other shared projects (not role projects) | their Gitea repositories |

Each is an edited derivative with its own history. A public commit's message names the internal
commit it was made from, and the target workspace's journal records the pair. The catalog in
`mycatalog` is where a summoner finds the role projects (`workflow_editor/docs/mind.md`), and it
names their public commits. An installation that already has a project (an `adopted` plan entry)
keeps its internal one; nothing compares the two histories.

**Publishing an update** of a project: request `publisher/publish` for it ("update", with what
changed). The publisher builds from the integrated `main`, and the public history continues. A new
public commit of a role project is then a catalog change (its `commit`) in the mind repository, and
`mycatalog` is republished by hand with this tool from a clone of the mind repository outside the
service's (`build`, read, `stage`, `push`). Installations that summoned the project move to it by a
plan revision (fast-forward).

## Not covered

Atomic multi-repository publication (impossible with separate remotes); one repository needed at two
revisions in one graph; deeper
submodule nesting than one level has not been run on a real project.

The evidence behind this is in the development episode notes of the core, which are not published.
