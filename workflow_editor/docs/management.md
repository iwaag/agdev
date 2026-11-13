# Managing a child installation over the agdev link (`improve_multinodes` p3)

An installation (A) can be the **operational parent** of another (B): A observes
B's installation (active release, services, lifecycle) and asks B to adopt an
exact published core commit. B decides locally whether A may do so, retrieves
the commit from its own configured source and performs the update through its
own lifecycle service, exactly as a local `agdev-update` would. A learns the
outcome over the link, also after B's own communication process was stopped by
the update.

Management reuses the `peer/2` link ([peers.md](peers.md)): the same HTTP
delivery, outbox, retries, receipts and queries, under a management credential
([below](#management-over-http-cluster_teamwork-p4)). It is
addressed to an **installation**, not to a delegation's run, and it has its own
permissions. Ordinary delegation is unchanged.

Rules and shapes: `shared/peers.ts` (`grant`, `manage`, relationship checks,
envelopes). Store and meaning: `server/peermanage.ts`. Lifecycle side:
`install/agdevctl` (request ingestion, branch policy, `status/installation.json`).

## Four separate things

| | Where | Grants |
| --- | --- | --- |
| `parentage` | `peers.json` on each side | nothing by itself: which peer is this installation's operational parent (`parent`) or child (`child`) |
| `accept` / `request` | `peers.json` | ordinary work: which workflows run for / may be asked of that peer (P1) |
| `grant` | `peers.json` of the **managed** installation | administrative access given to that peer: `observe`, `update` |
| `manage` | `peers.json` of the **managing** installation | what this installation may ask of that peer: `observe`, `update` |

- A capability (`hello`) says what a release *can apply*; it never grants.
- `grant: ["update"]` is valid only on the peer whose `parentage` is `parent`
  and requires `observe` too. `observe` alone may be granted to any peer.
- `manage: ["update"]` is valid only on a peer whose `parentage` is `child`.
- At most one peer is `parent` (one operational parent). Work requests may still
  come from any peer that `accept` lists.
- Granting, replacing or revoking is a local edit by the installation's core
  account (`wfe peer set`, below). No message changes a grant, a parentage or a
  capability on the receiving side.

Why the core account is the right authority: it can already write a lifecycle
request (`agdev-update`); a granted peer gets exactly that power and no more.
Source, branch, build, switch and service control stay with the lifecycle
service (root on Linux), which neither the link nor a message can reconfigure.

## Relationship and enrollment

Each installation tells each peer how it sees the relationship in its `hello`
(sent once per change of capabilities or of this relationship):

```text
hello {capabilities, relation {you: parent|child|none, grants: [...], manages: [...], ancestry: [instance ids]}}
```

`you` is the parentage the sender gives the receiver (B says `you: parent` to A).
`ancestry` is the sender's known chain of parents, nearest first, as its own
parent last told it (at most 8). The receiver keeps the latest relation per peer
with its time. From it, each side derives the **enrollment** of a peer:

| Enrollment | Condition (shown by `wfe manage status`) |
| --- | --- |
| `none` | no parentage and no grant/manage locally |
| `pending` | configured locally, but the peer has not told its relation (not heard, or a release without management) |
| `partial` | the peer agrees on parentage, but grants less than this side manages (named) |
| `mutual` | parentages are each other's inverse; the child grants what the parent manages; the child speaks `observe` (and `update`) |
| `contradictory` | the parentages are not inverse (both say *parent*, one says *none*, …) |
| `cycle` | this installation appears in the peer's ancestry while the peer is its child, or the peer appears in this installation's own ancestry while it is its parent |

A parent sends management messages only to a `mutual` child (for `update`, a
child that granted `update`); otherwise `wfe manage …` is refused before
anything is recorded. A child admits management only from its configured
parent's sender with a local grant and refuses it while the relation it last
heard is `contradictory` or `cycle` (`refused relationship`). Not having heard a
relation is not a refusal on the child: its own grant is the authority.

Topology knowledge is local and may be stale: a host knows its own peers.json,
what each peer last told it, and its parent's ancestry. Nothing derives global
consistency from it; a disconnection leaves the last relation shown with its age.

## Messages

Management messages travel as `peer/2` envelopes whose `request` is the pair's
**management id** `m-` + 24 hex of sha256(`<parent>\n<child>\nmanage`), topic
`agdev manage`. A release without management ignores them as unknown types.

| Type | Sent by | `id` | Body |
| --- | --- | --- | --- |
| `update` | parent | `<m>:update:<n>` | `{target, commit, reason, requester {instance, actor, run, attempt}}` |
| `update-receipt` | child | `<op>:receipt` | `{op, payload, outcome: accepted \| refused, code, reason, update, capabilities}` |
| `update-status` | child | `<op>:status:<h>` | `{op, update, state, terminal, history [{state, at}], release, previous, health, notStarted, reason, at}` |
| `observe` | parent | `<m>:observe:<k>` | `{ops [op ids], capabilities}` |
| `installation` | child | `<observe id>:installation` | `{query, at, refused, sample, ops {<op>: status}, relation, capabilities}` |

- `n` is the parent's own counter of update operations for that child, assigned
  when `wfe manage update` records the operation (before queueing). The payload
  (`target, commit, reason, requester`) never changes for that id.
- `commit` is a full 40-hex hash. There is no repository, branch, URL or
  credential in any message.
- `requester` is provenance only: the parent's instance, the person or agent
  (`--by`), and the parent's run/attempt if any. The child never looks them up
  and never waits for them.
- `h` is the length of the child's lifecycle history for that update when told:
  each phase change is one new message; a repeat is recorded once.
- `sample` is the child's lifecycle-owned status record (below). `refused` is
  `not-permitted` when the asking peer has no `observe` grant (then `sample` is
  null, and `ops` names only operations that peer itself requested).
- Every message is at most 9500 characters; history is cut to the last 12
  phases and reasons to 500 characters.

## The child's side: admission and the lifecycle bridge

On an `update`, in order (each refusal is a `refused` receipt with `code`,
except the first three, which are ignored as on any link delivery):

1. credential holder, `from`, `to` (`authorizeHttp`; the management credential, below);
2. the id is `<m>:update:<n>` for this pair; else ignored;
3. the id was seen with another payload: ignored as a *conflict*, the first kept;
   with the same payload: the earlier receipt is sent again (*duplicate*,
   nothing admitted);
4. the peer's local `grant` includes `update` and its `parentage` is `parent`
   (`not-permitted`);
5. the relation last heard is not `contradictory`/`cycle` (`relationship`);
6. `target` is this installation (`wrong-target`), `commit` is 40 hex (`invalid`);
7. the lifecycle folder is present and its request folder writable
   (`lifecycle-unavailable`);
8. no other update is unfinished here — a request file waiting, or an update
   record not `succeeded/failed/refused` (`busy`, naming it).

**Admission** (durable, crash-safe):

```text
ops row (in, update, state admitting, lifecycle id L chosen once)   ← one transaction
→ lifecycle/requests/L.json (atomic rename; via peer, op id, provenance, no attempt)
→ ops row accepted + receipt queued                                   ← one transaction
```

A pass finding an `admitting` row writes the same `L.json` again unless
`requests/L.json` or `updates/L.json` exists, then accepts. If the grant was
revoked before the request file existed, the row is refused instead
(`not-permitted`). Once the file exists the update is admitted: revoking the
grant, unlinking or replacing the parent afterwards never stops, cancels or
restarts it; its statuses are still told to the peer that asked.

**Lifecycle ingestion** (`agdevctl supervise`): a request whose id already has
an update record is discarded (logged), never overwriting the record or its
history; a crash between writing the record and removing the request file
therefore repeats nothing. A peer request (`via: peer`) gets the lifecycle's own
branch policy (`[management] branch`, default `main`): only a commit reachable
from that branch of the configured `[source]` is built, whatever the request
says. `[management] peer_updates = false` makes the lifecycle refuse every peer
request (`refused`). A peer request while another update is unfinished is
refused, not queued. Build, drain, switch, start and the health check are the
ordinary `perform_update`. B drains its own open attempts; nothing of A is
awaited.

**Statuses.** Every pass, the child's link reads each admitted update record
(`updates/L.json`, readable by the core account) and posts an `update-status`
when its history grew. While the link is stopped by the switch, the lifecycle
continues alone; the record lives in `data/lifecycle/` outside every release.
When the link is back, its first pass tells the phases it has not told,
including the terminal one.

**Installation observation.** The lifecycle service writes
`status/installation.json` every 30 s from a thread of its own (so also during a
build): `{instance, at, release {active}, serving {release, instance} | null,
services {wfe, executor, observer, watchdog: running|stopped|unknown}, draining,
update {id, state, since} | null, tool}`. The link only reads it. Its `at` is the
sample time; a record older than 2 minutes when read says *lifecycle not
reporting* and its service states are shown as last reported, not current.

## The parent's side

| Command | |
| --- | --- |
| `wfe manage status [<peer>]` | enrollment, permissions on each side, the latest observation with sample time, receipt time and freshness, update operations and their phase |
| `wfe manage observe <peer>` | ask for an observation now |
| `wfe manage update <peer> <commit> --reason TEXT [--by WHO]` | record and send one update operation; refused before recording unless the child is `mutual` with `update` and speaks it |
| `wfe manage show <op>` | one operation: receipt, lifecycle id, every phase with its time, selected release, serving release, verified healthy completion |
| `GET /wfe/api/manage` | the same as JSON |

**Freshness of an observation:** *fresh* when received within 15 minutes and the
sample was at most 2 minutes old when the child answered; *stale* otherwise
(shown with the age of both); *unknown* before the first. A stale healthy
sample is never shown as current health.

**One operation, as the parent sees it:**

```text
recorded → posted (retried 1, 2, 4 … ≤ 30 min until a receipt)
→ accepted (lifecycle id L) | refused (code)
→ requested → building → draining → stopping → starting → succeeded | failed | refused
```

| Shown | Meaning |
| --- | --- |
| `acknowledged` | B's receipt: the request is durable in B's lifecycle — not an update |
| `selected` | the release B's record says it switched to (`stopping` onwards) |
| `serving` | the release B's health check found the API serving |
| `completed, verified` | `succeeded`, health healthy, serving = selected = the asked commit, same instance |
| `failed, partially active` | the release is selected and some services did not start (`notStarted`) |
| `unknown` | no receipt / status yet, or the last one is old: the outcome is not known, not failed |

**Queries.** While an update operation is not terminal, the parent asks
`observe` every minute (listing its unfinished operation ids); otherwise every
15 minutes for a `mutual` child with `observe`. The answer carries each listed
operation's current status; a status the parent lacks is recorded from it, so a
lost `update-status` costs one query. An operation the child says it never
received (`unknown`) is posted again at once. A lost `observe` is not retried:
the next one replaces it.

Retries and queries never create a second operation, never declare B failed
and never fall back to SSH.

## Display identity and the Cluster view (`improve_multinodes` p4)

Each `hello` also says how the sender names itself for people:

```text
hello {…, identity {name, host, dashboard}}
```

| Field | Source on the sender | Bound |
| --- | --- | --- |
| `name` | `site.json` `name` (the Home display name) | ≤ 64 characters, no control characters |
| `host` | the OS host name of the service (`os.hostname()`); not a physical-machine identity behind a VM or container | ≤ 253 |
| `dashboard` | `peers.json` `viewBase`, else `present.json` `answerBase`; only http(s) without credentials and not loopback | ≤ 300 |

Each field is `null` when unset or out of bounds (left out, never cut). The
identity is descriptive: it grants nothing, and the receiver binds it to the
configured peer whose credential delivered it, never to the ids the message claims.
The latest hello replaces the kept identity (`peers.identity`, with the time it
was received); a hello without one (an older release) leaves it unknown. A
change of the identity is a change of the hello, so it is announced again; a
release that records identities says the capability `identity`, so a peer that
updates to it is told again by the other side.

`GET /wfe/api/manage` (also without `peers.json`) answers:

```text
{configured, config: ok|disabled|invalid, reason, at,
 local {instance, name, host, dashboard, release {commit, built}, lifecycle {sample, age, problem}},
 self, ancestry, peers [{instance, label, parentage, grant, manage, enrollment, heard, heardAt,
   capabilities, capabilitiesSeen, identity {name, host, dashboard, received} | null, observation | null, operations}]}
```

A read asks no peer and changes no link state: it is this installation's own
configuration and what it last heard. `config: invalid` is an error (the
problems in `reason`), not an empty cluster. `GET /wfe/api/manage/<op>` is the
operation lookup as before.

The Cluster view (`#/cluster`, from Home) draws this installation, its parent
(if any) and its directly configured children. Cards are keyed by instance id;
names prefer the peer's own identity over the local `peers.json` label. Only
direct relationships are edges: ids above the parent are *reported ancestry*
without details, and a child's own children are not known here. Relationship
agreement (enrollment), observation freshness and service state are shown
apart; a peer this installation does not observe has no health, only the time
it was last heard. Peers with no parentage are listed outside the tree.

## Duplicates, conflicts, concurrency, revocation

| Case | Result |
| --- | --- |
| the same op posted again (lost receipt, `wfe peer resend`) | B re-posts the same receipt with the same lifecycle id; no second request file |
| the same op id with another payload | ignored on B as a conflict, the first kept, listed under problems |
| `wfe manage update` while an operation to that child is unfinished | same commit: the existing operation is returned; another commit: refused locally (`busy`) |
| two parents / a local `agdev-update` while a peer update runs | B refuses the peer update (`busy`); the lifecycle never runs two updates at once |
| grant revoked before admission | `refused not-permitted` |
| grant revoked, unlinked or parent replaced after admission | the update continues; statuses still told to the requester |
| crash between B's journal and its request file / between file and receipt / between record and request removal | the next pass completes the same admission; the lifecycle discards a request whose record exists |
| B's link stopped during the switch | the lifecycle continues; the first pass after restart tells the outcome |
| A down | B's update is unaffected; B's outbox retries what it tells, and A asks again |
| unknown outcome | stays queryable (`observe` lists the op; B answers from its record) |

No message cancels, restarts or rolls back an update. A partially applied
update is repaired on the host (below). The child never forwards a management
request: an `update` names this installation only and is never delegated
further (B's own children are B's business).

## Setting up and changing the relationship

`wfe peer set <instance> [--label L] [--endpoint <WFE API>] [--parentage parent|child|none]
[--accept …] [--request …] [--grant observe,update] [--manage observe,update]
[--replace-parent <old instance>]`: an atomic edit of `peers.json` (created for this installation
when there is none; written to a
temporary file and renamed), keeping every other entry and field; it refuses
what `parsePeerConfig` refuses, and a second parent unless `--replace-parent`
names the current one (whose `update`/`observe` grants and parentage are then
removed; its `accept`/`request` stay).

`wfe peer unlink <instance>`: parentage `none`, grants and manage removed,
ordinary permissions kept; `--remove` also deletes the entry (refused while that
peer has open requests in either direction). Admitted updates continue.

`wfe peer check [<instance>]`: configuration valid, the peer's HTTP state
(credential installed, last result), the peer heard (with what it speaks) and the enrollment. A one-sided
configuration is `pending`, never `mutual`.

## Recovery outside the product

An unresponsive child (no observation for long, lifecycle not reporting, the
update `unknown` for hours) is recovered on its host by an operator: SSH to the
host, `agdevctl status`, the update record in `data/lifecycle/updates/`,
`agdevctl start`, or `agdevctl activate <previous release>`. This is a
deliberate operator/Omni route, never taken automatically by the link.

## Management over HTTP (`cluster_teamwork` p4)

Management may travel the same HTTP ingress as work (`POST /api/peers/messages`), under a credential of
its own scope. Nothing about authority changes: the grants, the parentage and the lifecycle decide; a
reachable endpoint grants nothing.

### Credentials and scope

Each receiver issues a **management credential** per holder (`wfe peer credential issue <holder> --scope
manage --out <file>`, token `agdev-manage1.<issuer>.<holder>.<hex>`), installed on the holder as
`<area>/.local/peerlink/credentials/<issuer>.manage.token` (or `peers[].manageCredential`). The receiver keeps
only its hash and its scope; a credential issued before p4 is a work credential (store v6 defaults every
existing row to `work`). A management credential is issued only to a peer with a relationship (`grant` or
`manage` not empty).

| Message | Sender | Accepted at ingress only when |
| --- | --- | --- |
| `update` | parent | management credential; the holder is this installation's `parentage: parent` with `grant update` |
| `observe` | parent | management credential; this installation grants the holder `observe` or `update` |
| `update-receipt`, `update-status` | child | management credential; this installation `manage`s the holder and the named operation is its own `out` operation to it |
| `installation` | child | management credential; this installation `manage`s the holder and asked that observation |
| anything else | either | a work credential (a management credential is `403 peer-scope`) |

Refusals are `403 peer-scope` (wrong credential kind) or `403 manage-not-permitted` (relationship or
binding), before anything is stored. When a stored management delivery is applied, its credential must still
be an unrevoked management credential and the relationship must still allow it (else it is `ignored`,
`revoked: …`/`not-permitted: …`); `update` admission then checks the grant again, as before. So the
management credential a parent issues to its child lets the child answer, never initiate an update of the
parent, and a work credential never reaches management.

### One route

Every management message travels over HTTP: an `update` is recorded with `mops.route = http`, its retries, the
child's `update-receipt` and every `update-status` follow it; `observe` and its `installation` answer too. An
update for a peer whose management credential is not installed here is refused before recording
(`peer-credential`). A delivery failure stays queued and visible. Operations the retired Zulip link carried
keep `route zulip` as history (`wfe manage status` says `over the retired Zulip link`). `wfe manage status`
shows whether the management credential is installed per peer.

### Rollout and rollback

Store v6 adds `credentials.scope`, `hinbox.credential`, `mops.route`, `observations.route`; nothing existing
is rewritten. A release before p4 refuses a v6 store. (The p4 rollout moved each child from Zulip to HTTP
management with `manageRoute`; that switch is retired with the Zulip link, cluster_teamwork p5.)
