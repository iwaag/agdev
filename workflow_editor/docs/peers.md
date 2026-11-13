# Delegation between installations (`improve_multinodes` p1)

A run on one agdev installation (A) can delegate to a workflow of another
installation (B). B takes the request into its own WFE as an ordinary run,
executes it locally, and returns durable progress and the result. A records
what B tells it on the delegating run with the ordinary delegation operations
([delegation.md](delegation.md)), so the parent's waiting, continuation,
assessment and disposition are the ones a local child has.

Each installation keeps its own execution, working copies, Git operations,
admission decisions and authoritative run records. Nothing reads the other
installation's files, stores or database. Code travels through Git; the
result names a repository and a commit, not a path on another machine.

Rules and shapes: `shared/peers.ts` (pure). Store and meaning:
`server/peerlink.ts`. Transport: HTTP between the installations' own WFE
services ([below](#http-delivery-cluster_teamwork-p2)).

> **History.** Until `cluster_teamwork` p4/p5 envelopes could also travel as posts in a Zulip channel
> shared by the two installations (`peers.json` `link`, `peers[].sender`, `route`/`manageRoute: zulip`,
> the transport `agautolab.peerlink` and `wfe peer due|receive|outbox|sent|failed|transport|protocol|setup`).
> That link is retired; its code is in Git history only. A `peers.json` that still has `link`, a
> `sender` or a `zulip` route is refused with what to remove. Rows the link left in
> `peerlink.sqlite` (`route = zulip`, the `inbox` of posts) are history: shown as such by `wfe peer
> status|messages`, `wfe delegate show` and the teamwork archive, never sent or settled. A message
> first posted there that has to be told again (a repeated acceptance, a replay) goes over HTTP with
> the envelope its post held.

## Identity and configuration

An installation is identified by its **instance id** (`config/instance-id`,
`<area>/instance.json`: `<slug>-<12 hex>`). Host names and display names are
labels.

`<area>/peers.json` (host-specific, not in Git; a template is below):

```json
{
  "version": 1,
  "self": "b-vm2-f6ea6da98a9d",
  "viewBase": "http://agautolab1.home.arpa:8082/wfe/",
  "peers": [
    {
      "instance": "<instance id>", "label": "main", "endpoint": "http://<host>:8093/wfe/api",
      "parentage": "parent", "accept": ["peerdemo/produce"], "request": []
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `self` | this installation's instance id; refused if it differs from `instance.json` |
| `viewBase` | how others reach this installation's run views (defaults to `present.json` `answerBase`) |
| `peers[].endpoint` | the peer's WFE API base (required; [HTTP delivery](#http-delivery-cluster_teamwork-p2)) |
| `peers[].parentage` | the operational relationship: `parent` = that peer is this installation's parent, `child`, or `none`. It grants nothing by itself |
| `peers[].accept` | `<project>/<workflow>` this installation runs for that peer |
| `peers[].request` | `<project>/<workflow>` this installation may ask of that peer |
| `peers[].grant` | administrative access given to that peer: `observe`, `update` ([management.md](management.md)) |
| `peers[].manage` | administrative access this installation may use on that peer: `observe`, `update` |

Parentage, permission to request work and permission to update or recover an
installation are separate. Observation and update of an installation
(`grant`, `manage`) are [management.md](management.md) (P3); recovery of an
unresponsive installation stays an operator's route on its host.

Nothing is shared but the envelopes each side delivers to the other's API.
Each installation keeps its own Gitea and everything else.

## Delegate node

```yaml
  produce:
    type: delegate
    instance: b-vm2-f6ea6da98a9d   # the other installation; absent = this one
    project: peerdemo              # required with instance: that installation's project
    workflow: produce
    accepts: parent
```

`instance` makes the target the other installation's. Validation checks its
shape (`delegate-instance`) and that `project` is named; whether the workflow
exists is that installation's to say. A remote target never enters this
host's cross-project cycle graph, so a local project with the same name is
unaffected.

## Messages

A link message is one envelope, the JSON body of an HTTP delivery:

```text
{agdev: "peer/1", type, id, from, to, request, payload, body}
```

| Type | Sent by | Body | `id` |
| --- | --- | --- | --- |
| `request` | A | delegation uid, parent `{project, workflow, run, creation, node}`, target `{project, workflow}`, `accepts`, requester, on behalf of, `request {text, sha256}`, `original {text, sha256} \| null` | `<request>:request` |
| `accepted` | B | `run {uid, project, workflow, run, created, url}` | `<request>:accepted` |
| `declined` | B | `{code, reason}` (`not-permitted`, `target`, `create`) | `<request>:declined` |
| `event` | B | `{receipt, event}`: a fact of B's run exactly as a local relay records it (`question`, `failed`, `completed` with its manifest, …) | the receipt `delegation:<delegation uid>:<child seq>:<type>` |

- `request` (the request id) is `r-` + 24 hex of sha256(`<A instance>\n<delegation uid>`): stable for the
  delegation's life, so every redelivery is the same request.
- `payload` is `sha256:` of the canonical `{type, body}`; an envelope whose body does not match it is not a link message.
- Unknown protocol versions and types are not applied. Answers, instructions, corrections, cancellation,
  receipts, queries and state are `peer/2` ([below](#interaction-peer2-improve_multinodes-p2)).
- A message (the envelope's JSON) is at most 9500 characters, the bound the link has always had. A request that
  would be longer is refused at `wfe delegate request`, before anything is recorded.

## Authorization

A delivery is acted on only when all hold, in order (`authorizeHttp`):

1. its bearer credential is one this installation issued, not revoked, and its holder is a configured peer;
2. the envelope's `from` is that holder;
3. its `to` is this installation;
4. for a request, the target is in that peer's `accept`.

A claimed identity in a message is never authentication. Failing 1–3, the
delivery is refused or kept and ignored (`wfe peer status`: unauthorized, misaddressed).
Failing 4 the peer is told explicitly (`declined: not-permitted`).

## What happens

| Step | A (requesting) | B (receiving) |
| --- | --- | --- |
| Dispatch | `wfe delegate request`: checks the peer and `request`, writes `request.md`, records `delegation.dispatch` with `target {…, workspace: peer:<B>, instance: <B>}`, queues the request message | — |
| Request | — | receipt `(holder, envelope id)`; authorized; inbound row by request id with its payload digest; target workspace and published workflow checked (else `declined`); an **ordinary run** created with receipt `peer:<A>:<request>` (`input.entrustedBy {kind: delegation, …, peer {instance, request}}`), its start queued; `accepted` queued |
| Acceptance | `delegation.bind` with the remote child (`instance`, `url`), receipt `delegation-bind:<uid>` | — |
| Progress and result | each `event` recorded with `delegation.event` under its receipt; a waking fact queues the parent's continuation as for a local child | its own run record is relayed (`childFacts`), each fact queued once under its receipt; `completed` carries the manifest |
| Refusal | `delegation.event declined` (wakes; state `stopped`) | — |

**The remote result manifest** is the ordinary one (outcome, report and
artifacts by hash, decision, run branch) plus `remote`: `{instance, run, url,
repository, commit, published, integrated}` — where the work is (the run
copy's origin, credentials removed, and HEAD), whether that commit is the run
branch's head on that repository (`published`; null when not checkable), and
whether B integrated it. Publication, integration on B and A's disposition
are separate facts: A judging the result `satisfied` is not B's acceptance
or integration, and neither implies deployment.

A's agent reads the work by Git (`git fetch <repository> <commit>`);
`wfe delegate file` explains that instead of reading a remote copy.

## Idempotency and recovery (what P1 guarantees)

- **Duplicate request** (lost acknowledgment, `wfe peer resend`): B finds the
  inbound row; same payload → the acceptance is told again, no second run.
- **Conflicting reuse** of a request id (another payload): recorded as a
  problem, nothing applied, the run unchanged.
- **Crash between B's run creation and its acceptance**: the delivery stays
  unsettled; the retry finds the run by its receipt and accepts it.
- **Crash between A's dispatch and queueing**: every pass queues the request
  of an open, unbound remote delegation from the record.
- **Duplicate acceptance or result**: the bind and every fact are recorded
  once by receipt; a duplicate queues no second continuation.
- **Unconfirmed outcome**: before an acceptance or refusal arrives, A says
  `acceptance: unknown` (`wfe delegate show`, `GET …/delegations` `link`,
  `wfe peer status`) — never failure or success.
- **A question from B's run** to a peer that has not advertised `answer`
  (a P1 installation): relayed as a `question` fact; A refuses to answer it
  (`peer-unsupported`), so B's run stays waiting; nothing claims completion.
  B's agent is told in its brief not to ask such a peer.

## Interaction (`peer/2`, improve_multinodes p2)

`peer/2` adds operations from A to B's run, B's receipts for them, a state
query and the replay of missing facts. The P1 types keep travelling as
`peer/1`, so an installation that speaks only `peer/1` still reads requests,
acceptances, refusals and facts; it refuses every `peer/2` envelope
(`protocol peer/2 is not supported`) and applies or acknowledges nothing.

### Capabilities and rollout

Every `peer/2`-speaking installation puts `capabilities` in the bodies it
sends that carry them (`request`, `accepted`, `receipt`, `state`, `query`):
`["answer", "instruction", "correction", "cancel", "query"]`. The receiver
stores the latest list per peer (`wfe peer status`: *speaks*). An
operation is sent only to a peer that advertised it; otherwise the command
is refused **before anything is recorded** (`peer-unsupported`, naming the
peer and what it has advertised). `wfe peer hello` posts one `hello`
(capabilities only) to every configured peer; the transport posts it once
whenever this installation's capabilities change, so a peer upgraded after
a request was accepted becomes known without a new request.

Staged rollout: deploy the receiving installation (B) first; it keeps
reading P1 requests and advertises its capabilities in its next message.
Then deploy A. While A is still P1, B's runs are told not to ask (A cannot
answer); while B is still P1, A refuses interactions locally. Neither side
waits on a message the other cannot apply.

### Operations (A → B)

| Type | `id` | Body | Applied on B as |
| --- | --- | --- | --- |
| `answer` | `<request>:answer:<n>` | `{run, question, answer: n, text, from, by}` | `question.answer` with `delegation {uid, answer}` |
| `instruction` | `<request>:instruction:<n>` | `{run, instruction: n, text, from, by}` | `instruction.receive` |
| `correction` | `<request>:correction:<n>` | `{run, revision: n, result {seq, manifest}, instruction, reason, from, by}` | `correction.receive` with `delegation {uid, revision}` |
| `cancel` | `<request>:cancel` | `{run \| null, reason, by}` | `run.cancel` (the ordinary cancellation) |
| `query` | `<request>:query:<k>` | `{run, facts {from, have}, unacknowledged [op ids], capabilities}` | read only |

- `n` is A's own counter in the delegation record (`answers[n]`,
  `instructions[n]`, `revisions[n]`), so the id is stable from the moment A
  records it. **The run record is A's send intent**: every pass queues the
  operation message of every recorded answer, instruction and correction of
  an open remote delegation that has none yet (as for the request). A
  cancellation, which A records nowhere else, is recorded in the link store
  (`ops`) before it is queued.
- `run` is B's run uid as accepted (`<project>/<workflow>/<run>#<creation>`);
  `null` only for a cancellation before acceptance.
- Every operation is rendered and its size checked (≤ 9500 characters)
  **before** A records it: an oversized answer, instruction or correction is
  refused at `wfe delegate answer|instruct|revise` (`peer-message-size`) and
  nothing waits on it.

On B, in order: the sender is the request's peer (else ignored,
*unauthorized*); the request was accepted (else the delivery **waits**, below);
`run` is the bound run (else refused `wrong-run`); the peer still `accept`s
the workflow (else refused `not-permitted`); the operation id was not seen
with another payload (else ignored as a *conflict*, the first kept). Then the
semantic operation is applied with receipt `peer-op:<op id>` and the
delegation's original author (`from`) and the parent's recorder (`by`) as
provenance (`via: peer`), the continuation queued as locally
(`afterAnswer`, `afterInstruction`, `afterCorrection`, all keyed), and the
receipt queued. A crash after the run operation and before the receipt
repeats nothing: the retry finds the history entry by its receipt.

### Receipts (B → A)

`receipt`, id `<op id>:receipt`, body `{op, kind, payload, outcome, code,
reason, seq, capabilities}`; `payload` is the operation's payload digest.

| Outcome | Meaning |
| --- | --- |
| `applied` | the operation is in B's run record at `seq` |
| `requested` | a cancellation is recorded and B's open attempt is being stopped; the `cancelled` fact follows |
| `refused` | not applied, with `code`: `question-closed` (withdrawn or already taken up), `run-completed`, `run-cancelled`, `result-superseded` (B completed again after the returned result, or the manifest is not the one B sent), `correction-state`, `wrong-run`, `not-permitted`, `invalid` (B's record refused it), `cancelled` (a request A cancelled before it arrived) |

A records `applied`/`requested` in the link store (shown, nothing woken). A
`refused` receipt becomes the existing `answer-refused` fact on the
delegation (receipt `peer-op:<op id>:refused`; it wakes the parent once): a
refused correction closes that correction request (`openRevision`), a
refused cancellation says that B's run went on (for a racing completion:
"completed at seq N before the cancellation arrived; its result stands").
A duplicate receipt changes nothing.

Cancellation and completion race on B under the run's lock: whichever is
recorded first wins. Completed first → `refused run-completed`; cancelled
first → the completion never happens. An already cancelled run → `applied`.
A cancellation before acceptance: B records the request id as cancelled
(`inbound` state `cancelled`); a request arriving later is `declined
(cancelled)`, and a run accepted meanwhile is cancelled.

### Correction generations

A correction returns one result: `result.seq` is the completing entry of
B's run that A recorded as its latest result and `result.manifest` the
digest of the manifest B sent with it. B refuses (`result-superseded`) when
its run completed again since, or when the digest differs from the
`completed` fact it sent for that entry (read from its own outbox). An
accepted correction reopens **the same run** (`correction.receive`); its
`correcting` fact and its next completion are new facts with new receipts.

A completion whose child seq is older than the latest result A recorded is
**not** recorded as a result (it would make an old result the latest and
silently end an open correction): it is kept in the link journal as
`superseded` and acknowledged for reconciliation. Arrival order never
replaces B's history order for results; other facts carry their child seq.

### Reconciliation

**Retry.** Messages that expect an answer — `request` (answered by
`accepted`/`declined`), each operation (by its `receipt`) — are sent
again with their stable id until answered: after 1, 2, 4, 8, 16 then every
30 minutes, at most 10 reposts per pass. Each repost is recorded (`attempts`,
`next retry`, last transport error). A timeout never creates a new request
or run and never declares B's execution failed.

**State query.** For every bound remote delegation A asks B with a `query`
every 5 minutes while the delegation is open (every 30 minutes while it is
closed and B's run was last seen not finished; never after B's run was seen
cancelled, or completed with no open attempt or correction). A lost query is
not retried: the next one replaces it. B answers with `state` (id `<query
id>:state`):

```text
{query, run {uid, seq, execution, cancelled, attempt, hold, questions}, facts {from, through, all, replayed, pending, more}, ops {<op id>: applied|requested|refused|unknown}, capabilities, at}
```

- `facts.all` lists B's facts of the run as `<child seq>:<type>` above
  `facts.from`, up to `through` (bounded so the message fits; `more` when
  there are further facts). A's `have` is the same list from A's journal.
- For each fact in B's list that A lacks, B **re-posts the message it sent
  then** (its outbox row, unchanged: the original identity and payload,
  never a manifest regenerated from today's copy), at most 20 per query
  (`replayed`); facts B has not queued yet are `pending` (its relay sends
  them).
- For each unacknowledged operation A lists, B re-posts its receipt, or says
  `unknown` (never received): A posts the operation again at once.
- **Watermark**: when a `state` shows nothing A lacks up to `through`, A
  moves `facts.from` (its verified position) to `through`. Missing child
  sequence numbers are not missing facts — most run history entries are not
  relayed; only B's own list says what exists. A newer `run.seq` alone does
  not mean A has every fact before it.

**Snapshot and freshness.** The latest `state` is A's *observation* of B's
run, kept in the link store with its time; it is never recorded as facts on
the delegating run (facts come only as `event`s). Views show it with its
age: *stale* after 15 minutes without a `state` or fact while the delegation
is open, *unknown* before the first. A closed delegation (judged, or its
parent cancelled) keeps receiving observations in the link store only: its
run is not reopened and no continuation is queued.

**Waiting, not failing.** A delivery whose prerequisite has not arrived — a
fact before its acceptance, a `withdrawn` before its `question`, an
operation for a request B has not accepted yet — is held `waiting` (with
what it waits for) and settled automatically on a later pass once the
prerequisite is there. A delivery waiting longer than an hour is listed under
*problems* (it stays waiting).

**Oversized facts.** A fact B cannot send within 9500 characters (a long
question, a manifest with many artifacts) is not truncated: B keeps it
unsent (`oversize`) and posts a `problem` message `{fact, type, size,
limit, url}`. A records it on the delegation's link view and wakes nobody
falsely; the parent reads the fact on B's run view. The same holds for a
`state` that cannot fit: its fact list is cut at `through` with `more`.

**Bounds.** One query per delegation outstanding; at most 20 operation or
query messages per peer per pass; replays at most 20 per query. A failing
peer is skipped for the rest of the pass and retried with backoff (HTTP
delivery below). `wfe peer resend` stays as a diagnostic, not a step of recovery.

### Recovery windows

| Lost or interrupted | Recovered by | Within |
| --- | --- | --- |
| a request, or its acceptance | A's retry of the request | the next retry (≤ 30 min) |
| an operation, or its receipt | A's retry, or the next `state` saying `unknown` | ≤ 5 min after B answers a query |
| a fact (question, result, refusal, …) | the next `state` and B's replay | ≤ 5 min (open), ≤ 30 min (closed) |
| A's service down while B works | B's outbox keeps every message and retries it; the next query replays what was not delivered | the first passes after restart |
| B's service down | A's outbox keeps every message; delivered on restore | the first pass after restore |
| a crash between receipt application and its acknowledgment (either side) | receipts on every application (`peer-op:`, `delegation-bind:`, fact receipts) | the next pass |

## Operations

| Command | |
| --- | --- |
| `wfe peer status` | configuration, peers (parentage, permissions, endpoint and credential, **what each speaks**), the last HTTP result per peer, requests sent and received, messages **awaiting an answer** (attempts, next retry, last error), facts too large to carry, posts not applied or waiting over an hour |
| `wfe peer messages [--request <id>]` | deliveries received and messages sent or queued (and, as history, the retired link's posts) |
| `wfe peer hello` | tell every peer again what this installation applies |
| `wfe peer resend <request>` | a diagnostic: send this side's messages of a request again. Recovery never needs it |
| `wfe peer process` | settle received deliveries now (the service's loop does it by itself) |
| `wfe peer set / unlink / check / credential …` | configuration ([management.md](management.md), below) |
| `wfe delegate show <run> <d>` | `link:` delivery and acceptance; `remote run:` its id, view, **freshness** (fresh / stale / unknown) and last observation; what the other installation applies; each operation sent and its outcome; what waits; facts kept aside (superseded, after closing, oversize) |
| `wfe delegate answer|instruct|revise|cancel` | the ordinary commands; for a remote delegation they are refused before recording when the peer has not said it applies them, or when the message would not fit |
| `wfe delegate verify <run> <d>` | fetch the result's commit from the repository it names and hash its committed report and artifacts |
Routine work never falls back to SSH or remote shell when the link fails;
failures are recorded and retried.

## HTTP delivery (cluster_teamwork p2)

The envelopes, ids, receipts, waiting, replay and retries above, carried by the
installations' own WFE services. Rules:
`shared/peers.ts` (`authorizeHttp`, tokens). Store and dispatch:
`server/peerlink.ts`. Loop: `server/peerhttp.ts`. Routes: `server/api.ts`.

### Configuration

| `peers.json` field | Meaning |
| --- | --- |
| `peers[].endpoint` | the peer's WFE API base, e.g. `http://agautolab1.home.arpa:8082/wfe/api` (required). It grants nothing |
| `peers[].credential` | the file of the token that peer issued to this side (default `<area>/.local/peerlink/credentials/<instance>.token`, mode 600) |
| `peers[].route`, `peers[].manageRoute` | may still say `http` (older files); any other value is refused |
| `directory` | the cluster directory this installation consults ([cluster.md](cluster.md)) |

`wfe peer set <instance> --endpoint <url> --credential <file>|default` (creates `peers.json` for this
installation when there is none).

### Credentials (receiver-issued, one per holder installation)

```sh
# on the receiver (B), for holder C — writes the token to a file, never prints it:
wfe peer credential issue c-5ba67eac599e --out /tmp/for-c.token
# move the file to C by an authorized operational route, then on C:
wfe peer credential install b-vm2-f6ea6da98a9d --from /tmp/for-c.token   # then remove the file
wfe peer credential list            # issued here / installed here (fingerprints only)
wfe peer credential revoke <holder|id>   # new deliveries refused; accepted work stands
```

The receiver keeps only the token's sha256. A token authenticates its holder
for peer envelopes only: no CLI, no update, no other store. Work permission is
still `accept`/`request`; management is `grant`/`manage` with a management credential ([management.md](management.md)).

### Routes

| Route | Answer |
| --- | --- |
| `POST /api/peers/messages` (bearer) | one envelope (≤ 64 KiB). `202 {receipt}` stored; `200 {receipt, duplicate}` same holder, id and payload (it is settled again, so a lost answer is told again); `409 peer-conflict` same id, other payload — nothing changes; `401 peer-auth`; `403 peer-identity` (`from` ≠ holder, holder not configured) or `misaddressed`; `403 peer-scope` a management type or `m-…` id (a work credential carries no management; cluster_teamwork p3); `400 peer-envelope`; `413`; `503 peer-config` |
| `GET /api/peers/messages/<id>` (bearer) | the holder's receipt and application state |
| `GET /api/peers/self` (bearer) | who the holder is here and what this installation runs for it |

`receipt = {peer, id, type, request, payload, received, deliveries, state, note}`.
A `202` is *durable receipt only*: acceptance (`accepted`/`declined`),
application (`receipt`) and the run's facts still come back as envelopes.
Every arrival is kept (`hdeliveries`: time, address, stored/duplicate/conflict).

### One route

Every message of every request, in both directions, and every management message travels over HTTP. Rows
from the retired Zulip link keep the `route` they were recorded with (`outbound.route`, `inbound.route`,
`outbox.route`) as history. Nothing falls back: an HTTP failure stays queued and visible (`wfe peer
status`: `HTTP:` lines, `refused by the receiver`).

### Who does what

- **The WFE service's loop** (every 2 s, idle without `peers.json`) posts HTTP
  rows — at most 20 per peer per pass, a failing peer skipped for the rest of
  the pass — and settles HTTP deliveries as soon as one is stored. 2xx settles
  the transport only; 401, 5xx and timeouts leave the outcome unknown and retry
  the same identity (10 s doubling to 10 min); 400/403/409/413 are `refused`.
  `WFE_NO_PEER_HTTP=1` turns the loop off.
- **The settle pass** (`process`: apply, relay, retries, queries, management) is
  run by the service's loop (at least every 60 s) and by `wfe peer process`,
  one at a time under a lease in the link store (`lease`; a dead holder on the
  same host is replaced, another host's expires after 10 min).

Runs created from an HTTP request record `input.source {kind: peer, route: http,
peer, message: <envelope id>, at}`; binds record `transport {route: http, peer,
message, at}`.

### Store versions

The link store migrated to version 5 (p2: inbound rebuilt with a nullable `message`) and 6 (p4: credential
scopes, management routes); every row is kept. A release before p2 refuses a version 5 store, so code
rollback is forward repair, or restoring the pre-switch copy only when nothing was accepted since.

## Judging a remote result

What A can check, and what it cannot:

| | Verified by | Not verifiable here |
| --- | --- | --- |
| the work | `git fetch <repository> <commit>` and reading it there | — |
| a report or artifact the manifest records **as committed** (`commit` set) | `wfe delegate verify`: its bytes in the fetched commit hash as the manifest says (`VERIFIED`, `DIFFERS`, `MISSING`) | — |
| a file recorded as **not committed** (`commit: null`) | — | its hash is the child's claim |
| the commit, when the repository is unreachable or no longer has it | — | nothing is verified; the manifest digest alone is never verification |
| whether the child presented its result, its reviews, its node record | — | `presentation-missing` is *unknown* (neither verified nor missing): look at the run view (`manifest.remote.url`) or ask the child; judge with `--yes` and say why when no presentation is needed |

`revise` is offered by the assessment only when the other installation
applies corrections; otherwise its repair is to reject and replace. Verified
bytes say nothing about whether the content serves the request: that is
still the agent's judgement, with what it checked in the note.

## Troubleshooting

| Seen | Meaning | What to do |
| --- | --- | --- |
| `acceptance: unknown`, delivery *no answer yet — posted n×, next retry …* | B has not answered the request (down, its service stopped, not yet settled) | nothing: retries continue (≤ 30 min apart); check B's `wfe peer status` there |
| `remote run: stale (last heard …)` | nothing heard for 15 min while open | queries continue every 5 min; check both sides' `HTTP:` lines |
| `peer-unsupported … has not said it applies …` | B runs a P1 release, or has not said so since its update | update B; `wfe peer hello` on B announces it |
| `peer-message-size … at most 9500` | the answer/instruction/correction is too long | shorten it; put details in a committed file B can fetch and name it |
| `waiting: … waits for the acceptance / the question` | a fact arrived before its prerequisite | nothing; it settles when the prerequisite arrives (listed as a problem after an hour) |
| `link problem: the remote run's … could not be carried` | B's fact is over 9500 characters | read it on B's run view (the URL given) |
| `answer-refused … question-closed / run-completed / result-superseded` | B refused the operation | the parent was woken; read the reason, ask anew, or judge |
| `→ <peer>: FAILED … (outcome unknown)` | B's API did not answer, or answered 5xx/401 | nothing; retried with backoff; check B's service and the credential installed here |

Reproducing on two installations: see
improve_multinodes p2 report 6 (a development note, not published).

## Setting up a link (bootstrap, not delegation)

1. On each installation register the other: `wfe peer set <its instance> --label <name> --endpoint
   <its WFE API base> --accept … --request … [--parentage …]` (creates `peers.json` when there is none).
2. Each receiver issues a credential to the other (`wfe peer credential issue <holder> --out <file>`);
   the holder installs it (`wfe peer credential install <issuer> --from <file>`), and the file is removed.
3. Check with `wfe peer check` and `wfe peer status` on both: each peer's HTTP state and, after the
   hellos arrived, what it speaks. The service's loop picks the file up; no restart is needed.
