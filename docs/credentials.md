# Credentials of an installation's operations

`agdev-cred` (in `<root>/data/area/bin/`, from `install/agdev-cred`) keeps one inventory of the credentials an
installation's operations use: what each one is, which account it authenticates as and where, why it exists,
who is responsible for it, which operations use it, where it is stored, and what happened when it was last
checked and used. It answers "which credential does this operation use, as whom, and is it still good?"
without searching folders for secrets.

## What is kept where

| Thing | Place |
| --- | --- |
| Inventory (metadata and storage references, no values) | `<root>/config/credentials.json`, 0600 |
| Usage records | `<root>/config/credentials-usage.jsonl`, 0600, appended |
| The secrets themselves | where they already are: `config/secrets/`, an Ansible vault, a tool's own file; an imported one in `config/secrets/<id>` |

An entry: `type` (`ssh-key`, `sudo-password`, `gitea-token`, `slack-bot`, `model-login`, `token`,
`file`), `service`, `target` (host or URL), `account` (as whom it authenticates there), `purpose`, `owner`,
`consumers`, `storage` (`file` path and the `keys` a KEY=VALUE file must hold; `ansible-vault` file and
variable; `external` description), `created` (only when known), `updated`, `expires`, `status` (`active`,
`pending`, `missing`, `replaced`, `revoked`), `verified` (time, `ok`/`failed`, detail), `copies` (host, path,
who made it, when, for what). Unknown history stays absent; nothing is back-dated.

## Use

```sh
agdev-cred list                                  # the inventory, no values
agdev-cred show gitea-a-owner              # one entry, its file's presence/mode/owner, last use
agdev-cred check gitea-a-owner             # readable, and the service says who it is (Gitea)
agdev-cred exec gitea-a-owner --operation OP -- python3 make-repo.py   # values in the environment only
agdev-cred exec gitea-a-developer --env GITEA_TOKEN -- tool …               # a raw token file as one variable
agdev-cred path ssh-ansible-key                  # a file for a tool that reads its own (ssh -i, Ansible)
agdev-cred use ssh-ansible-key --operation OP --result ok --remote-account <user>@<host>
agdev-cred usage gitea-a-owner
```

`exec` replaces every value of the credentials it loaded with `<redacted:ID>` in the command's output, so
diagnostics can go into run records. A secret is never passed as a command-line argument, never printed by
`list`/`show`/`check`, and never written into the inventory.

Usage records separate the **operation** and **run** that used a credential, the **requester** when given, the
**OS account** that read it on this host, and the **remote account** it authenticated as. They are operational
provenance, written by the tool that used the credential, not a tamper-proof audit.

## Adding, replacing and revoking

- An existing credential file: `agdev-cred register <id> --type … --account … --target … --purpose … --file PATH`
  (the file stays where it is; repeat with new fields to update the entry).
- A credential a person supplies: they write it to a private file (mode 0600) on the host and run
  `agdev-cred import <id> --from FILE …`; it is copied to `config/secrets/<id>`. Do not paste secrets into chat
  or workflow records.
- A credential a tool generates (a bot an operation creates): the operation writes the file and registers it.
- Replacing: put the new value in the file (or `import --replace`, which keeps `.previous`), then
  `agdev-cred check <id>`. Copies listed under `copies` must be replaced too.
- Revoking: revoke it **at the service** (delete the bot or token, remove the key from `authorized_keys`), then
  `agdev-cred status <id> revoked --reason …`. The status alone revokes nothing.

## Not isolation

Every agent and service under one OS account can read every file this inventory points at (on macOS everything
runs as the user; on Linux the core account's agents share WFE's and the executor's credentials,
[install.md § Boundaries](install.md#boundaries)). The inventory makes credentials visible and their use
traceable; it does not stop an agent of the same account from reading them. That is the accepted tradeoff
for this stage: reliability and speed over per-agent isolation; no vault, broker or approval step.

## Errors

A missing file, an unreadable file (named with the OS account that tried), a file without the expected keys,
an unreachable service and a refused authentication each give one line on stderr, exit 3 (storage) or 1
(check failed), and never contain the value.
