# External publication

External publication makes an edited, selected **public** derivative of a project's internal
repositories, for example on GitHub. It is not the workflow publication of runs to Gitea and not
a mirror: the internal (Gitea) repositories stay the development authority, the public
repositories have their own histories, and every transfer between them is explicit and reviewed.

Tool: `install/agdev-external-publish` (Python 3.11+ standard library), installed with each
activation as `<installation>/config/install/agdev-external-publish`. `--help` lists the commands.

## What stays local, what is published

Five principles. Every publication tool and agent guide of agdev refers to this section and does
not restate it.

1. **The local repository is the authority; a public repository is a derivative.** This holds
   for the catalog as for a project. The installation acts on its Gitea catalog only. A public
   catalog, the owner's own included, is a reference: reading it adopts nothing, and a local rule
   may say the opposite of what a public one says.
2. **Private unless decided.** What no decision covers stays local. Widening what is public is
   decided by the owner, or by Omni on the concrete change; narrowing needs no decision.
3. **One chain of grounds.** A braindump states a policy; a rule adopts a sentence of it; a
   contract selects files; a journal records what was published. Each link names the one before
   it. These are the only three places that carry disclosure (tags with their rules, the
   catalog's `rules.yaml`, one contract per repository); there is no fourth store and no per-file
   attribute.
4. **Nothing is more public than what it names.** A rule, a review, a run record or a comment
   that names or quotes something private is private in that place. The public `rules.yaml` of a
   catalog is therefore derived (*The owner's words*, below), and a name of a private project in
   any candidate stops it unless the contract records why the name is needed.
5. **Agents propose, the owner or Omni decides.** The owner is not asked per item: an agent reads
   the stated policy and proposes; the answer is given on the proposal as a whole. An agent never
   widens what is public on its own reading.

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

[[allow]]                                  # the name of a project kept private, where the text needs it
file = "docs/packs.md"
found = "private:example"
why = "the name of a pack made for it; nothing else of the project"

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
`check-failed`, `checkout-state`, `owner`, `busy`, `infrastructure`, `usage`, `rule`. A workflow maps them to
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
`agent/source-change.md` guide) for the delegation; the core has one too. A project without one
gets it with its first publication, delegated to its `freework`.

**The owner's words (user_catalog p8).** On an installation with a catalog, the tool refuses
`build`, `stage` and `push` for the workspace of a project the owner's braindumps keep private: an
adopted rule `project: <id>, follows: never-publish` in the catalog's `rules.yaml`, or such a
statement the summoner proposed that the owner has not declined (code `rule`; it names the rule or
the proposal and its sentence). The tool finds the installation's area through `$WFE_AREA`, the
folder of `$WFE_REGISTRY`, or `<root>/data/area` beside the installed tool, reads `catalog.json`
there, `rules.yaml` at `HEAD` of the service's clone and the open proposals; an installation
without a catalog, or a catalog without such a rule, is not affected. The publisher reads the same
facts with `wfe catalog disclosure` and declines in `scope`; a `publish` rule authorizes a new
repository, a `default-licence` rule its licence.

**A private name is a forbidden word the installation supplies (improve_publish p1).** On the same
installation, `build`, `stage` and `resolve` of *any* workspace search every candidate file for the
id of each project kept private (the same reading), case-insensitive, as a word: the characters
around it are not `[A-Za-z0-9]`, so `pj-<id>`, `<id>_pack` and `<id>/run-001` are found. A finding is
labelled `private:<id>`; it stops `stage` (`check-failed`) and makes `build` exit 1, as a forbidden
word does, unless the contract has an `[[allow]]` for that file with `found = "private:<id>"` and the
reason the public text needs the name. No contract lists the words. An `[[allow]]` covers the name
only: what tells more (run ids, states, contents of the project) is generalized, and the publisher
still reads every allowed place. The journal records per staging the ids searched and each allowed
place with its reason (`checks.private_names`).

**The public `rules.yaml` of a catalog is derived.** In a repository with `mycatalog.yaml` at its
root, a selected `rules.yaml` from the source's root is replaced, at build time, by its public
form: the rules whose source braindump the same candidate selects, that are not `never-publish` on
a project (such a rule names what is private) and not `share: never` (the default licence always
is); `source.commit` is dropped (an internal commit), `adopted.by` becomes the destination's
account. Nothing says that rules were left out. It takes no `[[file.edit]]` (code `contract`): no
agent edits it, so it cannot be stale. `wfe catalog publication status` prints which rules are
public and why the others are not.

**The catalog as a target.** The publisher's target `mycatalog` is the owner's catalog, published
from the folder `wfe catalog publication status` names; its owning agent is the summoner (workflow
`catalog-publication-edit`), which writes the catalog through `wfe catalog`. Omni or a person no
longer publishes the catalog by hand.

## What is public, and where

| Public repository | What it is | Internal authority |
| --- | --- | --- |
| `github.com/iwaag/agdev` | this core (WFE, executor, observer, installer, docs) | the core's Gitea repository |
| `github.com/iwaag/pj-warden` | warden: the `recovery` and `coordination` roles | `pj-warden` |
| `github.com/iwaag/pj-ponderer` with `study-argue`, `wedo-argue` | ponderer: `facilitation`, `conversation-archive` | `pj-ponderer` and its submodules |
| `github.com/iwaag/pj-aghangout` | aghangout: `conversation-page`, `dialogue-renderer` | `pj-aghangout` |
| `github.com/iwaag/mycatalog` | the published part of the owner's catalog (`projects.yaml`, `mycatalog.yaml`, and the braindumps and challenges its file list names) | the owner's catalog on Gitea (`<owner>/mycatalog`) |
| `github.com/iwaag/pj-forge`, `pj-agsfx`, `wedo-sfx` | other shared projects (not role projects) | their Gitea repositories |

Each is an edited derivative with its own history. A public commit's message names the internal
commit it was made from, and the target workspace's journal records the pair. `projects.yaml` in
`mycatalog` is where a summoner finds the role projects (`workflow_editor/docs/mycatalog.md`), and it
names their public commits. An installation that already has a project (an `adopted` plan entry)
keeps its internal one; nothing compares the two histories.

**Publishing an update** of a project: request `publisher/publish` for it ("update", with what
changed). The publisher builds from the integrated `main`, and the public history continues. A new
public commit of a role project is then a change of `projects.yaml` (its `commit`) in the catalog, and
`mycatalog` is republished by a `publish` run with the target `mycatalog`. Installations that summoned the project move to it by a
plan revision (fast-forward).

**The catalog's file list.** In `mycatalog`, `publication/github.toml` chooses what is public per
braindump and per challenge: one `[[tree]]` for each folder (`braindumps/episodes/<path>`,
`challenges/<id>`), with `exclude` globs for evidence files that should stay internal. Everything not
listed is internal. `wfe catalog publication status` shows what the list selects and the last public
commit; `build` shows the candidate and the forbidden-word result before anything is pushed
(`workflow_editor/docs/mycatalog.md`, "The published part").

## Not covered

Atomic multi-repository publication (impossible with separate remotes); one repository needed at two
revisions in one graph; deeper
submodule nesting than one level has not been run on a real project.

The evidence behind this is in the development episode notes of the core, which are not published.
