# The cluster directory (cluster_teamwork p2)

Where to ask, without a central router. Each installation advertises what it
offers; one installation (for example the first one you install) collects those advertisements; the
others consult it, keep a copy, and then talk to the destination directly
([peers.md](peers.md), *HTTP delivery*). Code: `server/cluster.ts`; CLI
`wfe cluster …`; routes `GET /api/cluster/advertisement`, `GET /api/cluster/directory`.

**Discovery grants nothing.** A listing is not an acceptance, an advertised
endpoint does not enroll a peer, parentage gives no work access. Whether this
installation may ask is its own `peers.json` `request`; whether the other runs
it is that installation's `accept`, and its acceptance of a request is its own
decision, told on the delegation.

## Advertising: `<area>/cluster.json`

```json
{
  "version": 1,
  "endpoint": "http://agautolab1.home.arpa:8082/wfe/api",
  "offers": [
    { "project": "team-story-b", "workflow": "story",
      "purpose": "Short branching stories (team-story/1 packages) for other installations' games",
      "input": "a request text: scale, language, tone left open or given",
      "delivery": "team-story/1 package on agshare; contract: agent/guide.md of owner/pj-team-story-b",
      "consult": null }
  ],
  "directory": { "collect": false }
}
```

- Only listed offers are advertised. Each is enriched from the project's
  **published** definition (workflow name, its intent as purpose when none is
  given, whether it accepts requests, the published repository and commit); a
  problem (unregistered project, no such published workflow) is shown, not hidden.
- `endpoint` defaults to `peers.json` `viewBase` + `api`.
- The advertisement adds identity (instance, display name, host), protocol
  capabilities, transports, and a bounded activity count (jobs queued/running —
  no run names, no text). No credentials, paths or conversation content.
- Built by the WFE service in the background (at most every 10 min, or when
  `cluster.json` changes) and served from that cache with an `ETag` (`304` on
  `If-None-Match`). Nothing is fetched per read.

## Collecting: `"directory": {"collect": true}`

Members are this installation's peers with an `endpoint` in `peers.json`.
Every 5 min, at most 4 at a time, each with a conditional read (10 s timeout):

- the advertised build time (`advertised.built`) and the directory's fetch time
  (`fetched`) are kept apart; `checked` is the last attempt;
- a failed refresh keeps the last advertisement, marked **stale** with the
  error; it is never renewed or erased silently; never fetched: **unavailable**;
- an endpoint advertising another instance than the peer it is registered for
  is not merged (kept apart, with the error);
- a member that itself collects contributes its entries with `via` (provenance),
  deduplicated by instance; direct members win.

`GET /api/cluster/directory` = this installation's own advertisement plus each
member's entry. Fresh: fetched within 15 min.

## Consulting (B, C): `peers.json` `directory`

`wfe cluster use http://<collecting-host>:8093/wfe/api/cluster/directory` once.
Then, on demand only (no polling):

| Command | |
| --- | --- |
| `wfe cluster offers [<words>]` | offers in the directory, filtered; refreshed when the copy is older than 10 min |
| `wfe cluster show <instance>/<project>/<workflow>` | one offer |
| `wfe cluster directory [--refresh]` | entries with freshness and activity (on a collector: collected now with `--refresh`) |
| `wfe cluster resolve <project>/<workflow> [--instance <id>]` | where to ask, below |
| `wfe cluster advertisement [--rebuild]` | what this installation advertises |

When the directory cannot be reached, the cached copy is used and labelled
**stale** with why; a known, permitted peer is still reachable directly.

### `resolve`: each fact apart

1. **Listed**: the directory's entry (state, via, fetch time). Several
   instances: `ambiguous` (name one with `--instance`).
2. **Here**: registered in `peers.json`, its endpoint (and whether it is the
   advertised one), the route of new work, whether this side may request it,
   whether the credential it issued is installed.
3. **Confirmed**: the destination's own advertisement, read now: same instance,
   offer present and accepting requests (with its source revision).
4. **Permitted**: with the credential, `GET …/peers/self` on the destination —
   whether it runs the workflow for this installation.

States: `ready` (all four), `unconfirmed`, `unregistered`, `not-connected`,
`not-permitted`, `unavailable`, `not-offered`, `ambiguous`. Exit 0 only for `ready`.
For an unknown or unconnected peer it prints the configuration steps on both
sides (`wfe peer set … --endpoint … --request|--accept …`, `wfe peer
credential issue|install`): a first connection is a configuration decision of
each installation, never a side effect of discovery.

## Facilitators are optional

front (unclear requests, choosing a recipient) and ponderer (substantive
multi-project coordination) may use the directory to choose where to ask. They
are not relays: once a destination is registered and its owner's policy
permits the workflow, a project's agent dispatches directly and no facilitator
approves each request. A's directory and activity summary are information for
observation; A's availability never gates B–C work.
