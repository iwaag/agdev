# Where workspaces are placed

An area's workspaces live in its **project root**, not necessarily inside the area
(agedev_selfassembly p4). `<area>/placement.json` names it:

```json
{ "projectRoot": "/absolute/folder" }
```

Without the file the area itself is the project root, as before placement existed.
An installation's `agdevctl` writes it from `[projects] root` in `instance.toml`
(default `<root>/projects`); `wfe placement set <folder>` does the same by hand.

## One contract for every entry

`server/placement.ts` is the only place that decides the folder of a new workspace:

| Entry | Folder |
| --- | --- |
| Editor: New project (`POST api/agdev/projects`, `POST api/projects`) | `<project root>/pj-<id>` |
| Editor: Obtain (`POST api/agdev/projects/<id>/workspaces`), `wfe project obtain` | `<project root>/pj-<id>`, `-2`… when taken |
| `wfe create --id <id>` without a destination | `<project root>/pj-<id>` (an explicit destination is used as given) |
| `wfe project rename` | beside the workspace's current folder, wherever that is |

The registry records where each workspace actually is. Workspaces may be on different
volumes; nothing requires them to share one. Changing the project root changes only
what is created or obtained afterwards.

## Availability

`set` writes a marker `.agdev-projects.json` into the root. A configured root that does
not exist, or exists without its marker, is **not available**: creation and obtainment
are refused (HTTP 503, exit 1) and nothing is created elsewhere. That is what an
unmounted volume looks like, its mount point being an empty folder. `wfe placement`
reports the root, whether it is available, and the workspaces that are elsewhere.

## Relocation

`wfe workspace relocate <id>…|--all [--to <folder>]` moves existing workspaces into the
project root (or `--to`). Without `--apply` it only previews: destination, same or another
volume, collisions, open attempts or queued jobs, linked worktrees and alternates.

With `--apply`, each workspace goes through four recorded phases:

1. **planned → copied.** A copy into `<dest>.relocating-<id>`, then renamed into place. On
   one volume the copy clones files where the filesystem can (APFS `clonefile`, Linux
   reflink): no space is used until a side changes. To another volume it is a real copy;
   nothing assumes an atomic rename across devices.
2. **copied → verified.** Every entry's type, mode and link target, each file's size and
   time (`--verify content`: also its bytes) are compared. Git must report the same refs,
   status and submodules in both copies (read without taking optional locks, so the
   source's index is not rewritten). Absolute `gitdir`/`worktree` settings of submodules
   that point into the source are rewritten to the copy.
3. **verified → switched.** The registry names the copy. The area's live references follow:
   presentation instances' configurations, and the model harness's session folders
   (copied under the new path's name, so a run's next attempt can continue its session).
4. The source is left as it was: it is the retained copy, removed only by a person.

The journal is `<area>/.local/migrations/relocations/<id>.json`. An interrupted relocation
continues with `wfe workspace relocate --resume`: a partial copy is discarded and made
again, a finished one is verified, a verified one is switched. While one is unfinished a
new one is refused. A copy that does not verify is never switched to; the registry keeps
naming the source.

Linked worktrees of the source (`git worktree`) are reported and stay with the source.
Runs live inside their workspace (`.agdev/runs`, `.agdev/retention`) and nothing
names a run copy by absolute path, so they move with it. Run records, messages and reports
are history and are not rewritten.

Relocate while the workspace has no open attempt and no queued job; the preview refuses
otherwise. Moving the whole area is an installation's adoption (`docs/migration.md` of the
agdev repository).
