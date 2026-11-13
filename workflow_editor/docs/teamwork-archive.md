# Teamwork archive (cluster_teamwork p3)

Work between installations (a delegation over the agdev link, [peers.md](peers.md)) has no conversation
room, so the [conversation archive](conversations.md#archive) does not carry it. The teamwork archive
publishes it into the **same archive repository** (`conversations.json` `archive`, usually that
installation's own pj-ponderer), in a namespace only this installation writes. Code:
`server/teamworkArchive.ts`, `server/teamworkPackage.ts`; CLI `wfe teamwork`.

## Layout

```text
instances/<instance>/teamwork/index.md                    every request of this instance
instances/<instance>/teamwork/<request>/manifest.json     ag.teamwork.v1
instances/<instance>/teamwork/<request>/transcript.jsonl  append-only records (the original)
instances/<instance>/teamwork/<request>/transcript.md     readable view of the same records, regenerated
instances/<instance>/teamwork/<request>/derived/          interpretations by runs; never this writer
```

The requester archives its side (the run that delegated and its follow-ups — runs whose predecessor is
that run), the receiver its side (the run the request created). Each points at the other by instance,
run uid and the result's repository/commit, and at the other's conventional path
`instances/<peer>/teamwork/<request>/` *in the other's own archive repository*; neither writes or claims
the other's records. Existing `conversations/` and `discussions/` paths and citations are unchanged.

## Records

Every record has a stable `id` (`<instance>:<run uid>:<seq>` for run entries,
`<instance>:link:<table>/<key>/<state>` for transport facts), `type`, `at` (when it was recorded at its
source, here) and `source` (instance, project, workspace, workflow, run, uid, seq).

| Type | From | Fields |
| --- | --- | --- |
| `utterance` | run history: `run.create` (the input file's words, read from the run folder and checked against the recorded sha256 — otherwise `text: null` with the reason), `delegation.dispatch` (the request file, same check), `question.ask`, `question.answer`, `delegation.answer`, `delegation.event` with words (the other side's question or result: `origin {instance, seq, at}` beside `receivedAt`), `delegation.dispose` (judgement), `node.complete` outcomes, `run.recover` reasons, `presentation.retain` notes | `kind` (request, question, answer, result, judgement, outcome, note), `direction`, `author`, `actor`, `to`, `relation {request, question, answer}`, `text` exactly as recorded, `recorded` (the entry as recorded) |
| `state` | every other entry of those runs | `recorded` |
| `delivery` | the link store: Zulip posts read (`inbox`, with the post's content as transport evidence), messages sent (`outbox`, terminal states), HTTP arrivals (`hinbox`, terminal) and every arrival attempt (`hdeliveries`: stored, duplicate, conflict), applied operations (`ops`), relayed facts (`facts`) | `route`, `direction`, `logical` id, `outcome`, `note` … |

A duplicate arrival is a delivery, never another utterance. The link store keeps only the *last* send
time of a message and its attempt count (`lastSentAt`, `attempts`); the first send time is not kept and
is said so. Credentials, auth headers, leases and configuration are never read.

## Publication

`wfe teamwork archive [<request>|--all]`, and the coordinator's reconcile every minute (after the
conversation archive; a failure is a note and blocks nothing). Records are collected before any
repository work (no run or link lock across the network); then, in the writer's own clone
(`<area>/.local/teamwork/archive`, file lock `archive.writer`): fetch, check out the published branch,
read the ids already in each published transcript (**the repository is the truth**), append only the
others, rewrite manifest, readable view and index, commit (trailer `Teamwork-Horizon: <instance>
<request> r<records> j<journal> <uid>@<seq> …`), push; a rejected push is rebuilt on the new remote state
(3 rounds). A crash after the push and before the bookkeeping publishes nothing twice: the next export
finds every id. `--interrupt-after-push` is that crash, as a diagnostic.

A request is due when its live horizon (each run's seq, the number of transport facts) goes beyond the
published one; a failed one waits 2^tries minutes (at most an hour). Bookkeeping:
`<area>/.local/teamwork/state.json` (not the truth).

`wfe teamwork status [<request>]`: `current`, `behind`, `failed`, `never`, `unverified` (published in
another destination) or `disabled`; commit, records, live horizon and the Gitea link.
`wfe teamwork collect <request>`: what an export would publish, as JSON.

## Derived

Summaries, translations and character readings go under `derived/`, written by runs (never this writer),
each naming the archive commit and records it read and the run that produced it. They never replace or
re-attribute the transcript.

## Packages (bytes)

A manifest in Git is not a byte backup, and a second path on the same export is not independent.
`wfe teamwork package <request> --archive <repository>=<instance> [--archive …] --out <new folder>
[--push]` builds, on a host that mounts the share, from the **published** archives (not live records):

```text
package.json   ag.teamwork-package.v1: request, sources (repository, commit, path, records), outputs
               (ref, declared manifest digest, producer, files with sha256, how verified)
outputs/<id>/  the files byte for byte and the output's .wfe-output.json
records/<instance>/  manifest.json, transcript.jsonl, transcript.md of each source archive
SHA256SUMS
```

Each output's folder manifest must carry the digest the records name and match its own body; every file
is hashed on the share and again after copying. `--push` copies the package to the host's
`attachments.json` `backup` destination under `<dirname(backup.path)>/agdev-teamwork/<request>/` —
never over an existing copy — and runs `sha256sum -c` there. `wfe teamwork restore <request> --into <new
folder>` brings it back and verifies every hash. A restore gives readable history and the delivered
bytes; it starts no service, grants nothing and replays no work.
