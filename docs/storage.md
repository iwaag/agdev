# Shared storage: one agshare for a parent and its children (improve_multinodes p6)

`agshare` holds message files and published run outputs ([shares.md](../workflow_editor/docs/shares.md),
[message-files.md](../workflow_editor/docs/message-files.md)). Installations that work together use the
**same** bytes: a parent that exports a folder over NFS, and children that mount that export. Workspaces,
repositories, databases, credentials and caches stay local; only the share is common.

## The setting: `[shares.agshare]` in `instance.toml`

| `source` | Meaning | Required keys | `shares.json` root |
| --- | --- | --- | --- |
| `local` (or no section) | a folder of this installation, for a standalone one | — (`root` optional) | `<root>/data/share/agshare` |
| `export` | a folder of this host that the host exports over NFS | `root`, `storage`, `server`, `export` (`mount`, `options`: what children use) | `root` |
| `nfs` | another installation's export, mounted here | `storage`, `server`, `export`, `mount` (`options`, `inherited_from`) | `mount` |

- `storage` is the identity of the bytes: `<exporting instance>/agshare`, e.g. `<instance-id>/agshare`. The
  exporting installation writes it into the share's marker (`.wfe-share.json`: `{"share", "storage"}`) and
  every installation records it in `shares.json`. WFE then accepts the root only when the marker names the
  same storage: an empty mount point or an unrelated folder with an `agshare` marker is **unmounted**, never a
  place that silently takes writes.
- `inherited_from` is the instance whose setting this one received; `server`/`export` are always the original
  export, never a re-export of a client mount.

```toml
[shares.agshare]                     # the main installation, which holds the bytes
source = "export"
storage = "<instance-id>/agshare"
root = "/opt/nfs/agshare"
server = "<nfs-server-address>"
export = "/opt/nfs/agshare"
mount = "/mnt/agshare"
options = ["noresvport", "x-systemd.idle-timeout=300s"]

[shares.agshare]                     # a child of the main installation (and the same for a child of that child)
source = "nfs"
storage = "<instance-id>/agshare"
server = "<nfs-server-address>"
export = "/opt/nfs/agshare"
mount = "/mnt/agshare"
options = ["noresvport", "x-systemd.idle-timeout=300s"]
inherited_from = "<instance-id>"
```

## agdevctl

```sh
agdevctl --config <instance.toml> storage show            # setting, shares.json entry, readiness, child default
agdevctl --config <instance.toml> storage child-default   # what a child inherits; exit 3 when there is nothing to pass on
agdevctl --config <instance.toml> storage declare '<json>' # rewrite only [shares.agshare] (a backup .before-storage is kept)
agdevctl --config <instance.toml> storage apply           # marker (export/local) and shares.json; refuses an unready share
```

- `area-init` derives the agshare entry from the setting. For `nfs` it creates nothing under the mount point.
  Without a section it keeps the old behaviour (a local folder, the mapping written once).
- `apply` replaces only the `agshare` entry of `shares.json` (`marker`/`publicBase` and other shares are kept)
  after checking readiness: the marker is readable within 20 s, names the share and the storage, and for `nfs`
  the mount point is an NFS mount. `--allow-unready` writes it anyway (a new child before its mount exists).
- Activation and updates never touch `shares.json` or `[shares]`: an inherited share stays inherited.

## Who does what

- **Mounts and export clients** are the host's desired state (for example kept in a
  host-management inventory and applied by your own tooling: Linux mounts through a systemd automount with `nofail,_netdev` and an idle
  timeout, so an unavailable server never blocks boot). Nothing else edits `/etc/exports` or `fstab`.
- **The mapping** is agdev's: `[shares.agshare]` and `shares.json`.
- **Setting up a child** (`cagentctl agdev new`): the parent's `storage child-default` becomes the child's
  `[shares.agshare]` and the operation's `storage` stages mount it before the child is used. An explicit
  `--set storage=…` or `--set storage.source="local"` (opt-out) is recorded in the operation. A parent with
  nothing to pass on makes the operation stop with `storage-prerequisite`, not a fresh isolated share.
- **An existing installation** is switched with `cagentctl agdev storage <target>` (cagent's guide
  `agent/agdev.md`): export client, client mount, copy of the old local share with conflict detection, a short
  pause of WFE and the executor for the final delta, the mapping switch, verification as the core account.

## Changing a parent or its endpoint

A hello, a peer setup or a release update never remounts anything. Moving a child to another parent, or
moving the export, is an explicit reconciliation: declare the new setting, run the storage operation again
(it copies what is only on the old storage, with the same conflict rules), and keep the old storage until
the new one is verified.

## Recovery

The operation keeps the pre-cutover `shares.json` (`shares.json.before-<op>` beside it) and the original
local folder. Switching back is: stop WFE and the executor, copy what was written on the shared storage
since the cutover back into the local folder (new bundles and outputs are new paths; nothing is overwritten),
restore that `shares.json` and `instance.toml.before-storage`, start them. Pointing back at the old folder
alone would lose the shared writes. A failed stage never deletes or reverses copied files.
