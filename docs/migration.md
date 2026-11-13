# Adopting an existing installation's state

> **History.** This adoption was done while installations used Zulip; Zulip was retired since, and `provision-zulip`, `zulip.json` and `[dependencies] zulip` no longer exist. The procedure stays as the record of how A was adopted; a new adoption continues on the same Gitea only.

The contract for a successor installation that **continues** an existing installation's
operation on the same Gitea and Zulip: same projects, runs, conversations, receipts and
service identities, new code and folders. It is not [transfer.md](transfer.md), which hands
work to a fresh owner with a new realm and discards live state.

The old installation is the *predecessor*, the new one the *successor*. The predecessor may
predate `agdevctl` (an area run by hand-made services, with no instance id). Host facts
(paths, accounts, ports, which machine) belong in the successor's `instance.toml` and in
ignored local notes, never here.

## Principles

- **One writer.** The predecessor's writers (WFE, executor, Observer, watchdog, lifecycle,
  scheduled jobs that write the area) are stopped before the successor's start, and the
  predecessor cannot restart itself afterwards. Reused dependencies (Gitea, Zulip, shares)
  keep running throughout.
- **Identities are kept, not regenerated.** Project, workspace, repository, run, attempt,
  conversation, receipt, cursor, incident and bot identities stay as they are. A predecessor
  with an instance id keeps it; one without gets one at adoption, and
  `<area>/instance.json` records the lineage (`adoptedFrom`).
- **Live references are remapped by their schema; history is left as written.** A path that
  a service follows (registry workspace paths, attempt log files, presentation logs,
  credential files named by configuration) is rewritten. Paths and URLs inside messages,
  reports, events and run records are history and stay.
- **Copies, never moves.** The predecessor's files stay where they were. Every copy is
  verified before the successor relies on it.
- **Consistent capture.** SQLite stores are copied with the SQLite backup API from a
  quiesced predecessor (no writer), never by copying a live main file without its WAL.

## Placement

| Thing | Successor place |
| --- | --- |
| Operating area (registry, stores in `.local/`, area configuration, `service/`, `bin/`) | `<root>/data/area` |
| Workspaces | the project root (`[projects] root`, default `<root>/projects`); each keeps its folder name |
| Executor and Observer state, credentials | `<root>/data/state/...` as for any installation |
| Shares (`shares.json`) | stay where they are; the share mapping names them |

Run copies and durable records stay inside their workspace (`<workspace>/.agdev/`), so
moving a workspace moves its runs; nothing names a run copy by absolute path.

## What moves, and how

| State | Owner | Method | Verification |
| --- | --- | --- | --- |
| Registry (`registry.json`) | WFE | copy; workspace paths rewritten by relocation | every workspace resolves at its new path; ids, projects and repositories unchanged |
| Workspaces, with dirty files, untracked and ignored run state, branches, stashes, submodules | the project | verified copy into the project root (`wfe workspace relocate`) | file tree, modes and links compared; `git status` and refs equal on both sides |
| Git worktrees, alternates | the project | reported by the relocation preview; a worktree outside the workspace stays a reference of the old copy | listed in the record |
| Execution, notify, intake, delegation, conversation, challenge, presentation, slack stores | WFE | SQLite backup of a quiesced predecessor; then `attempts.log`, `io_attempts.log` and `instances.log` path prefixes remapped | `PRAGMA integrity_check`, row counts per table equal, `user_version` equal |
| Intake cursors and receipts | WFE | in the intake and notify stores, as copied | cursor values equal; nothing is re-read from Zulip |
| Area configuration (`zulip.json`, `gitea.json`, `workers.json`, `conversations.json`, `shares.json`, `attachments.json`, `present.json`, `run-backup.json`, `site.json`, `node-catalog.json`, `challenges.json`, `system.json`) | WFE | copied; file paths that name credentials or tools rewritten to the successor's | no active path names the predecessor's folders (allowed exceptions listed) |
| Area `.local/` folders (contexts, drafts, discussions, access cache, backups, retired, run-backup, migrations, branch-cleanup, gitea-cache, exec logs, presentation instances) | WFE | copied | file counts and bytes equal |
| Hangout deployment (`hangout/`) | conversations | copied | renderer path resolves |
| Observer store, its health and watchdog state | Observer | SQLite backup into `<state>/agobserver/` | incidents, outbox and events counted equal; no incident from history reopens |
| Executor settings (`wfexec.toml`), agent profiles (`agents.local.toml`) | executor | regenerated from the successor's inputs; local profile settings copied | `wfe observe` heartbeat from the successor |
| Gitea, Zulip | external | **reused**: `[dependencies] gitea/zulip = "external"`; endpoint, owner, realm and credential files are inputs | access validated; nothing provisioned, no repository imported, no realm or bot created |
| Bot and token credentials | external services | file copied into `<root>/config/secrets/adopted/` (mode 0600), never printed | the successor reads them; the same bot identities answer |
| Model login | the service account | the account's own login (keychain or home); not copied between accounts | a real agent run |
| Remote workers | each worker | re-pointed at the successor's coordinator URL; tokens kept | a real attempt on the worker |
| Ancillary services of the predecessor not in the core | their own owners | inventoried; kept, re-pointed or retired explicitly | listed with their disposition |

## Order

1. **Prepare** the successor with both dependencies attached (`[dependencies]` external, the
   predecessor's Gitea owner and token, its realm, bots and Observer channel) and the
   predecessor's local worker id (`[execution] worker`):

   ```sh
   agdevctl --config <instance.toml> init
   agdevctl ... provision-gitea && agdevctl ... provision-zulip   # validate and copy; nothing created
   agdevctl ... area-skeleton                                     # folders, empty registry; no fresh intake settings
   agdevctl ... activate <commit> --no-start                      # build and select; nothing started
   ```

   `area-init` is not used: it writes a new installation's settings (intake from now, a fresh
   Observer channel), which are not the predecessor's.
2. **Quiesce** the predecessor: stop intake and admission, let attempts end (or hold them
   through a supported route), then stop its writers. Record the time.
3. **Adopt**: `agdevctl ... adopt <predecessor area> --observer-store <observer.sqlite>
   [--executor-local <agents.local.toml>] [--observer-local <...>]` previews (exit 1 with the
   problems: open attempts or claimed jobs, a live predecessor writer — a process holding one of
   its stores open, or an executor heartbeat under 30 s old —, a running successor core, no
   selected release, an area that already has other state, unattached dependencies, a different
   local worker id). Queued jobs are durable intent in the execution store: they are carried as
   they are and the successor's executor takes them up; the preview lists them under `carried`.
   `--apply` performs these steps, each recorded in `<root>/data/lifecycle/adoption.json`:

   | Step | What |
   | --- | --- |
   | `stores` | every `<area>/.local/*/*.sqlite` and `slack/*.sqlite` by SQLite backup; integrity and per-table counts must equal |
   | `files` | the rest of the area, cloned where the volume allows: `.local/` folders (without store files), configuration, hangout, workers' tokens, history folders. Not `service/`, `bin/`, `authoring/` (the successor's own) nor the workspaces |
   | `remap-stores` | `attempts.log`, `io_attempts.log`, `instances.log` prefixes from the predecessor's area to the successor's |
   | `configure` | `zulip.json` (paths, successor `viewBase`), `conversations.json`, `present.json`, `attachments.json`, `shares.json`; `gitea.json` regenerated with the predecessor's principals' tokens copied; `system.json` keeps retired repositories; `instance.json` with `adoptedFrom`; placement, site, executor and Observer settings from the inputs |
   | `observer` | the Observer store by SQLite backup, and the watchdog's state |
   | `relocate` | `wfe workspace relocate --all` into the project root (verified copies; the predecessor's folders stay) |
   | `verify` | every workspace under the project root; predecessor paths left in area configuration are listed |

   An interrupted adoption continues with `adopt --apply --resume` (a relocation in progress
   continues from its own journal). A resume is refused for every reason above, and also when
   its inputs differ from the record (source, original area, instance, `--isolated`, Observer
   store) or when a captured store of the predecessor no longer has the row counts it had at
   capture: a completed step is not permission to continue against changed data. Each resume is
   recorded with the predecessor's facts at that moment. `--stop-after <step>` stops on purpose,
   for trials.
4. **Verify** before any consumer starts: counts, identities, paths, store integrity.
5. **Start** the successor (`agdevctl ... start`); then prove continuity (the successor's plan).

A rehearsal adopts a consistent snapshot of the predecessor with `--isolated`: `zulip.json`
disabled (no intake, notification or IO), remote workers removed, no backups to other
machines, the executor drained, Observer's recovery off. Behaviour that writes to Gitea or
Zulip, resumes work or uses workers is rehearsed separately on fixture installations.

## Not carried

- Running agent processes: attempts are finished or held before capture, never copied as
  resumable processes.
- Absolute paths and URLs inside historical text (messages, reports, events, run records).
- Gitea and Zulip data: they are reused in place.
