# Transferring an installation to a new owner

The contract for handing a running installation's work to a newly created one. Only
the parts marked *rehearsed* have been tried, on a disposable installation. No live
installation has been transferred with this.

## Order

1. Finish active attempts. The old owner holds its drain until none is open and no job
   is queued. Attempts are not moved. Queued, held and completed work keeps its meaning
   only through what the table below carries. *Rehearsed with nothing open.*
2. The old owner stops intake, execution, monitoring and notification: watchdog,
   Observer, executor, WFE, lifecycle (`agdevctl stop`, then the lifecycle unit). From here
   nothing on the old side writes or alerts. *Rehearsed.*
3. Export: `agdevctl export-sources`, then copy the evidence you want kept. *Rehearsed.*
4. Create the new installation from those bundles and its own `instance.toml`, with a new
   instance id, credentials, realm and bots (`docs/install.md`). *Rehearsed, with a new slug
   and root on the same host and the same ports.*
5. Verify before use: every manifest source at its recorded commit, no old path or id in
   generated configuration, no incident from history, a real request and a conversation.
   *Rehearsed.*
6. Retire the old owner so it cannot resume its routes or services, keeping evidence.
   *Rehearsed by removal. Keeping a stopped old installation in place is not rehearsed.*

There is one writer at every step: the old owner is stopped before the new one exists on
its routes. Never run both against one Gitea or realm.

## What moves, and how

| State | Handling | Status |
| --- | --- | --- |
| `main` of each project and shared repository, including `devdocs/runs` records and the conversation archive | Bundles from `export-sources`, checked by commit | Rehearsed: run records read back, numbering continued, archived conversations found |
| Other branches (run branches, unintegrated work) | Not in the bundles. Integrate first, or push them separately | Not carried; a gap for any open run |
| Repositories beyond the manifest | Add them to the manifest, or import separately | Not rehearsed |
| Credentials, bots, tokens, realm, instance id | Regenerated, never copied | Rehearsed |
| Service URLs and paths in generated configuration | Regenerated from inputs | Rehearsed |
| URLs and absolute paths inside project content and old records | Left as written: they are history | A reader must not follow them; not remapped |
| Model login | Per account home; log in on the new host | Kept in the rehearsal, because the accounts stayed. Log in again on a new host |
| Local context blocks, drafts, adoptions, node catalog | `<area>/.local/contexts`, `node-catalog.json` and similar: copy, then check against the new paths | Not rehearsed |
| Shared area and attachments | Copy the share, keeping paths under its root; `shares.json` is regenerated | Not rehearsed |
| Execution store, notify, intake and delegation stores | Do not move: they refer to attempts, topics and messages of the old realm | Fresh by design; old runs have no live execution state |
| Conversation store | The archive carries the records. Its restore into a live store is not exercised | Live speech history is not carried |
| Zulip history | Stays with the old realm; export separately if wanted | Not carried |
| Observer's incidents and outbox | Do not move: historical incidents must not become new work | Rehearsed: zero incidents after creation |

## Before a real handover

Rehearse with the real size: moving tens of GiB of working copies, shares and many
repositories has not been tried, and neither has a different host, a remote worker or a
macOS source. Decide who holds the Git branch and publication rights if several writers
will share a source repository. Sharing a source shares no queues, incidents, credentials
or working copies.
