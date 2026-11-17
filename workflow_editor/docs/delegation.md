# Delegation contract (`workflow_editor` p10)

A **delegation** is one run (the *parent*) entrusting work to a run of
another managed workflow (the *child*), usually in another project: the
parent's agent writes the request, WFE creates the child as an ordinary
request run of the child workflow and delivers the parent's later answers,
instructions and corrections to it directly, the parent's agent answers the
child's questions and receives its result, and the parent continues with it.

> **History.** Until `cluster_teamwork` p4 a local delegation travelled notifier → Zulip → intake: the
> request and every answer were Zulip posts, and the intake created and bound the child from them. That
> route is retired (p5; the implementation is in Git history only). Records from then keep what they
> recorded — a `transport` `{realm, message, stream, topic}`, sources `{kind: zulip …}`, receipts
> `zulip:…`, an absent `delivery`, a `delegation.reroute` entry — and are read and replayed unchanged.

Nothing about the child is special. It is an ordinary run of its workflow:
the same creation, input files, attempts, sessions, questions, isolated
copy, publication, acceptance and integration as a run a person requested
([runs.md](runs.md), [storage.md](storage.md),
[integration.md](integration.md)). Delegation adds a durable relationship
between two runs and the delivery of a few kinds of fact between them.

| Who | Owns |
| --- | --- |
| The parent's agent | what to request, whether to answer a question itself or ask its person first, how to answer, whether the result serves the request (its disposition), whether to replace a failed child |
| The child's agent | how to do the work, what to ask, how to read an answer, when to present and how to record the decision a confirmation is |
| The system (WFE) | identities, dispatch intent, delivery and its journal, binding the child to the intent, relaying the child's events to the parent, queueing the parent's continuation, refusing what a record does not allow |
| The person (the parent's requester) | the parent's own result, and whatever the parent's agent chooses to ask them |

## Definition

```yaml
nodes:
  asset:
    type: delegate
    name: Get the asset
    description: What the child is asked for, and what this run needs back.
    project: forge        # target project id; absent = this run's project
    workflow: provide     # target workflow id (required)
    accepts: person       # who may accept the child's result: person (default) | parent
```

- `project` and `workflow` are a **portable target**: identities, never a
  workspace, a path, a channel or a topic.
- `accepts` records whom the workflow's author entrusted with the child's
  *result decision*: `person` (the parent's person) or `parent` (the
  parent's agent). Since p11 it is a record, not a gate: the parent's agent
  answers every question of the child, the result confirmation included,
  and the child records the decision its answer represents. Where a
  workflow means the parent to judge, `accepts: parent` says so.
- A delegate node binds no repository of its own work (it may name bindings
  for the files it reads back); its outcome is the delegation's result.

Validation ([contract.md](contract.md)):

| Code | Severity | Meaning |
| --- | --- | --- |
| `delegate-target-missing` | error | no `workflow` |
| `delegate-self` | error | the target is this workflow of this project |
| `delegate-target-unknown` | error | the target workflow is not known: in this project, or (with a registry) in the registered workspace of `project` |
| `delegate-project-unknown` | error | `project` is not a valid id, or (with a registry) no workspace of it is registered |
| `delegate-recursive` | error | following delegate targets across the registry's projects reaches this workflow again |
| `delegate-accepts` | error | `accepts` is not `person` or `parent` |
| `delegate-no-intake` | warning | the target workflow opts out of requests (`intake.requests: false`, or `intake: {zulip: ""}` without `requests`); a dispatch to it is refused |
| `workflow-on-non-delegate` | warning | `workflow`, `project` or `accepts` on a node that is not a delegate |

Delegate nodes compile into the effective graph like any node; `project`
and `accepts` are part of the definition digest and the compiled node.

## Identity

| Identity | Form | Notes |
| --- | --- | --- |
| Parent run | `<project>/<workflow>/<run>#<creation>` | the observation contract's creation-qualified uid ([observation.md](observation.md)) |
| Delegation | `d1`, `d2`, … per parent run; uid `<parent uid>/<d>` | stable for the delegation's life; every retry of its delivery keeps it |
| Child run | its own creation-qualified uid | recorded on the parent when bound |
| Delivery | the receipts of the direct delivery, `direct:<uid>:<item>` (below); on records before p4, the Zulip post that carried the request (realm, message id, channel id, topic) | references, never identities |

**One child per delegation, one open delegation per node.** A delegate node
instance dispatches once. A replacement after a failure is explicit new
work: the old delegation is closed (`abandoned` or `rejected`) by the
parent's agent first, and the new one has a new id and names its
`predecessor`. Nothing creates a substitute child by itself.

## Records

**Parent `run.json`** (`delegations.<d>`, present once the first dispatch
is recorded):

| Field | Content |
| --- | --- |
| `id`, `uid`, `node` | the delegation's identity and the delegate node it serves |
| `target` | `{project, workflow, workspace, source?}` — the workspace resolved at dispatch; `source` (improve_wfrun p1): `{kind: published, repository, branch, commit, definitions}`, the target's published revision dispatched to |
| `request` | `{path, sha256, bytes}` of `delegations/<d>/request.md` in the run folder: the parent agent's constructed request, exactly as delivered |
| `original` | `{path, sha256, bytes}` of `delegations/<d>/original-input.md`: the human input the request was derived from (the parent's `request.md` when a person wrote it, or the parent's own original), kept separately |
| `requester`, `onBehalfOf` | the parent's agent, and the person the parent run serves |
| `accepts` | the node's `accepts`, frozen at dispatch |
| `dispatched` | `{at, by, attempt, seq}` |
| `predecessor` | the delegation it replaces, or absent |
| `child` | `{uid, workspace, project, workflow, run, created}` once bound, else null |
| `delivery` | `direct` (every local dispatch; absent on records dispatched on the retired notifier → intake route) |
| `transport` | once bound: `{route: direct, delivery: <receipt>, at}`; from another installation `{route: http, peer, message, at}`; on older records `{realm, message, stream, topic}` of the Zulip request post |
| `events` | facts relayed from the child, numbered `1, 2, …` (below), each with `wakes`, and `takenUp` once the parent's agent read it |
| `answers`, `instructions` | what the parent's agent sent, in order, with `from` (whose words), `because` (the parent record they rest on) and the question they answer |
| `revisions` | (fix6, present once used) results returned to the same child for correction: `{n, event, manifest, childSeq, instruction, reason, from, by, at, attempt, seq, because?, origin?, evidence?, followUp?, attributed?}`. tidy p3: `origin` is whose finding it is (`agent`: the recording agent's own, with `evidence`; `person`: words relayed with `because`; `review`: a human review's requested changes); records before p3 derive it the same way. `attributed[]` holds later, explicit attribution corrections (`delegation.attribute`), beside the original `from` |
| `disposition` | `{kind: satisfied \| rejected \| abandoned, note, event, manifest, at, by}` or null |
| `closed` | `{reason, at, by}` when the parent run was cancelled with the delegation open, or the disposition closed it |

**Child `run.json`** is an ordinary request run:

- `input.kind: request`, `request.md` = the parent's `request.md` byte for
  byte (checked against the dispatched hash), `original-input.md` = the
  original, `requester` = the parent's agent, `onBehalfOf` = the parent's
  person.
- `input.entrustedBy: {kind: delegation, delegation: <delegation uid>,
  parent: {project, workflow, run, creation, node}, accepts}`.
- `input.source` = `{kind: delegation, route: direct, delegation, item: request, at}`. An answer the
  parent's agent sent records `from` (the parent's agent, or the person whose words it relays),
  `by` = the parent's agent, `source` = `{kind: delegation, …, item: answer:<n>}` and `delegation` =
  `{uid, answer: <n>}`.

The parent's record is authoritative for the relationship, the child's for
the work. The host store `<area>/.local/delegate/delegate.sqlite` holds a
rebuildable index of open delegations and the direct-delivery journal.

## Dispatch resolution

At `wfe delegate request`, before anything is written:

1. **Target workspace.** The registry's one workspace of `project`, or the
   one `<area>/workspaces.json` names (`{"projects": {"<project>": {"workspace": "<id>"}}}`,
   host-specific; an unreadable or malformed file refuses, it is never ignored); several
   without a selection, none, or one outside the operating boundary refuse
   the dispatch (`delegate-target`), naming the candidates. Never a guess. The same
   selection serves requests from other installations and submissions.
2. **Target workflow.** It is on the target project's **published default
   branch**, fetched now (improve_wfrun p1; not that project's workspace),
   validates without errors and accepts requests (the default; `intake.requests: false`
   or the older `intake: {zulip: ""}` opts out, [submissions.md](submissions.md)).
   The dispatch records that revision (`target.source`) and the digest it saw;
   the child is created **at that root commit**, so a delivery after the
   target's default branch moved on still starts the definition dispatched to. A delegation dispatched before p1 has no
   `target.source`; its child follows the default branch. `wfe delegate targets`
   shows what is offered and ready; the result assessment says which workflow
   and revision the child ran (`ran —`).
3. **Cycles.** Refused (`delegate-cycle`) when the target, as currently
   published, reaches the parent's workflow through delegate nodes across the
   registry, or when the target is the workflow of the parent or of any
   ancestor of the parent (the chain of `entrustedBy: delegation` records,
   read from the ancestors' own records, so a definition changed since an
   ancestor was created is still caught).
4. **Node.** The delegate node is running (started by the attempt), has no
   open delegation, and the attempt is the open one.

## Facts kept apart

| Fact | Evidence | Recorded by |
| --- | --- | --- |
| Dispatch intent | `delegation.dispatch` in the parent, with the request file by hash | the parent's agent (its attempt) |
| Delivery | the direct-delivery journal (`ldeliveries`: per item `applied` / `refused` / `failed`) | WFE |
| Child creation and binding | the child's `run.create` carrying the receipt `direct:<uid>:request`, and `delegation.bind` in the parent naming the child uid | WFE |
| Child execution | the child's own record | the child's agent and its host |
| Result availability | a `completed` event relayed to the parent, with a result manifest | relay |
| Parent receipt | `delegation.take-up` of that event | the parent's agent |
| Parent disposition | `delegation.dispose` (`satisfied`, `rejected`, `abandoned`), bound to the event and manifest digest it judged | the parent's agent |
| Child acceptance | the child's `run.decide` (usually from its result confirmation) | the child's agent, from the answer it took up |
| Child integration | the child's `run.integrate` | the child's host, by its own rules |
| Parent completion | `node.complete` of the delegate node; later the parent's own decision | the parent's agent; the parent's person |

None implies another. A delivered request is not a created child; a child's
completion is not the parent's receipt; the parent's receipt is not a
disposition; a `satisfied` disposition is not an acceptance in the child and
never queues the child's integration; accepting the child's result is not
accepting the parent's result.

## Decision ownership

| Decision | Who decides | Evidence the record requires |
| --- | --- | --- |
| What to request | the parent's agent | the request file by hash; the original input beside it |
| Answer a child's question (the plan agreement of a `_plan` step included) | the parent's agent | the answer text; `from` = the agent |
| Answer within scope after asking its own person first | the parent's agent | `because: answer <q>` of the parent's own taken-up answer; `from` = that person |
| Answer the child's **result confirmation** | the parent's agent (with `accepts: person`, usually after asking its person; `because: answer <q>` relays their words) | the confirmation question it answers (subject hashes are the child's to check) |
| Whether the child's answer is agreement or acceptance | the child's agent (its reading, as for any request) | the child's existing rules: plan agreement binds plan.md's hash, a decision binds the presented subject |
| Whether the result serves the request | the parent's agent | `delegation.dispose` naming the result event and its manifest digest |
| Replace a failed child | the parent's agent | the old delegation closed first; the new one names its predecessor |
| Cancel the child | whoever cancels it, explicitly | the child's own `run.cancel`; never implied by the parent's stop or cancellation |
| Accept the parent's result | the parent's person | the parent's own decision |

Before p11 the child refused a decision from its requester agent when
`entrustedBy.accepts` was `person` (`delegate-scope`); that gate is gone
and the field remains in the record.

## Transitions

States of a delegation on the parent, derived from its record:

| State | When |
| --- | --- |
| `dispatching` | dispatch recorded, no child bound |
| `working` | bound; no event waits for the parent |
| `attention` | an event that wakes the parent is not taken up |
| `result` | the child completed and the result event is taken up, no disposition yet |
| `correcting` | (fix6) the latest result was returned for correction and no newer result came back (a correction the child refused does not count) |
| `stopped` | the child's execution stopped (a failure or cancellation) and the parent has not closed the delegation |
| `satisfied`, `rejected`, `abandoned` | the disposition (closed) |
| `orphaned` | the parent run was cancelled while it was open (closed; the child keeps running unless cancelled explicitly) |

The delegate node waits (`wait.on: {delegation: <d>}`, holder = the target)
from the dispatch, resumes `running` when its agent takes up an event, and
waits again after an answer or instruction is sent.

| # | Situation | Child | Parent record | Parent node | Who acts next |
| --- | --- | --- | --- | --- | --- |
| 1 | Dispatch | — | `delegation.dispatch`; state `dispatching` | waiting on the delegation | system (delivery) |
| 2 | WFE creates the child | `run.create` (request, `entrustedBy: delegation`), start queued | `delegation.bind` with child uid and delivery receipt; state `working` | waiting | the child's agent |
| 3 | Child asks (the forge `_plan` agreement, or any question) | `question.ask` | `delegation.event question` (wakes): id, text, `to`, plan document or presented subject by hash; continuation queued | waiting → `running` on take-up | the parent's agent |
| 4 | Parent answers | `question.answer` (from, by, source, delegation), delivered directly; resumption queued | `delegation.answer` | `waiting` | the child's agent |
| 5 | Answer arrives after the child closed the question | nothing applied | `delegation.event answer-refused` (wakes) | `running` on take-up | the parent's agent |
| 6 | Child presents its result for confirmation (forge `confirm`, `confirms: result`) | `question.ask` with subject and presentation | as 3, with `confirms` and the subject hashes | as 3 | the parent's agent, or its person when `accepts: person` |
| 7 | Parent accepts (answer to 6) | the child's agent takes it up and records `run.decide accepted` from the confirmation; its integration is queued by the child's own rules | as 4; `delegation.event decided` (no wake) | `waiting` | the child's agent |
| 8 | Parent rejects or asks for changes (answer to 6) | the child's agent records `rejected` or adds a round, then asks again | as 4 | `waiting` | the child's agent |
| 9 | Child completes | execution `completed` | `delegation.event completed` (wakes) with the result manifest; state `attention` → `result` on take-up | `running` on take-up | the parent's agent |
| 10 | Parent reviews | — | `delegation.dispose satisfied` (event + manifest digest); closed | `node.complete` allowed | the parent's agent |
| 11 | Result does not serve the request | — | `delegation.dispose rejected`; a replacement may be dispatched (new id, predecessor) | `running`; replace, fail or cancel the node | the parent's agent |
| 11a | Result left something out (fix6) | `correction.receive`, delivered directly; execution `in-progress`; continuation queued | `delegation.revise` (event + manifest digest); state `correcting`; `delegation.event correcting` (no wake) once the child recorded it | `waiting` | the child's agent: adds the work, completes again → row 9 with a new result |
| 12 | Child fails (a node failed, execution stopped) | as recorded | `delegation.event failed` (wakes); state `stopped` | `running` on take-up | the parent's agent: wait for the child's person or Observer, `abandon` and replace, or fail the node |
| 13 | Child held (stopped by a person, interrupted, unknown) | as recorded; Observer handles interruptions | `delegation.event held` (no wake), `resumed` later | `waiting` | the child's holder |
| 14 | Child cancelled | `run.cancel` | `delegation.event cancelled` (wakes); state `stopped` | `running` on take-up | the parent's agent |
| 15 | Parent held (stop, interruption) | unaffected | events still recorded; no continuation queued | as it was | whoever resumes the parent |
| 16 | Parent cancelled | unaffected; cancelling it is a separate explicit act | the open delegation closed `orphaned`; later events are not recorded (the child stays inspectable) | `cancelled` | nobody; or a person cancels the child |
| 17 | Delivery fails | — (no child) | `dispatching`; the journal shows the failure (`wfe delegate show`) | waiting | the reconcile retries; a refusal by the target is told to the parent |

Events that wake the parent: `question`, `answer-refused`, `completed`,
`failed`, `cancelled`. Recorded without waking it: `held`, `resumed`,
`decided`, `integrated`, `withdrawn` (the child withdrew a question),
`correcting` (the child recorded a correction, fix6). A correction the child
refused comes back as `answer-refused` with `revision: <n>`. A
parent attempt that ends with a waking event recorded before it began and
not taken up is `interrupted`, like an exit with work left ready.

## Direct delivery (`cluster_teamwork` p4)

Every local delegation records `delivery: direct`: **WFE** delivers it from the parent's record.

| Step | Direct delivery |
| --- | --- |
| Capability | the target takes requests: `intake.requests` when declared, else the older meaning of `intake.zulip` (requests unless `zulip: ""`). `requests: false` or `zulip: ""` without `requests` is refused at dispatch |
| Child | `run.create` in the target workspace at the dispatched revision, receipt `direct:<uid>:request`, input `request` (requester the parent's agent, `entrustedBy: delegation`, the human original), source `{kind: delegation, route: direct, delegation, item: request}`; then `delegation.bind` with transport `{route: direct, delivery: <receipt>, at}`; the start is queued in the execution queue |
| Answer, instruction, correction | the parent's recorded item, applied with `question.answer` / `instruction.receive` / `correction.receive` under receipt `direct:<uid>:<item>` (item `answer:<n>`, `instruction:<n>`, `revision:<n>`), with the parent's words and `from`/`by`; the child's resumption is the execution queue's |
| Refusal | a closed question, a completed or cancelled child, a refusal by the record: recorded as `refused` and told to the parent (`answer-refused`, which wakes it), never applied elsewhere |
| Cancellation | explicit, through `wfe delegate cancel` (the child's own cancellation) |
| When | at once in the process that recorded it (dispatch, `wfe delegate answer|instruct|revise`) when it has the executor's stores, and in every executor reconcile (`wfe delegate sync` too) |
| Journal | `delegate.sqlite` `ldeliveries`: per item `applied` / `refused` / `failed` (retried), the child and seq; the run records stay the authority |

A crash anywhere repeats: the child is found by its receipt before anything is created, the bind has its own
receipt, every application has its own. The child's facts reach the parent by the relay.
`wfe delegate show` says `delivery: direct` and `created directly by WFE (receipt …)`.

**Older records (retired route).** A delegation dispatched before p4 has no `delivery`; its request, binding
and items were posts the notifier sent and the intake applied. Nothing delivers such a delegation now: WFE
delivers nothing for it (`wfe delegate show` says so) and it is judged or abandoned as any other. One that
was moved with `delegation.reroute` during p5 (`rerouted: {from: notifier, to: direct, at, by, seq, reason}`)
is delivered directly for the items recorded after `seq`; the entries before it keep the route they had.
The transition commands (`wfe delegate legacy|reroute`) are retired with the route; the reducer still
replays recorded `delegation.reroute` entries.

## Delivery and recovery

- **Dispatch before delivery.** The dispatch is recorded in the parent first;
  the child is created from that record, never from a copy of it.
- **Crash points.** After the child's creation and before the bind: the
  child is found by its receipt and the bind is recorded under the receipt
  `delegation-bind:<uid>`. After an item was applied and before the journal
  says so: the application repeats under its receipt and records nothing
  new. After the parent recorded an event and before the continuation was
  queued: reconcile queues it from the record. Every relay entry carries the
  receipt `delegation:<uid>:<child seq>:<type>`, so it is recorded once.
- **No polling inside attempts.** Waiting ends the attempt and frees the
  slot; the child runs in that slot; its events queue the parent. The wait
  lasts as long as the child does — minutes or days — because it is the
  parent's record, not a process; a retained harness session is optional
  continuity for the next attempt ([sessions.md](sessions.md)), never what
  keeps the wait.
- **The parent's graph around the wait.** The attempt that dispatches ends
  with every other node it started completed, failed or waiting; a node left
  running is an interruption however normal the wait (front/converse/run-027:
  the talk node beside its delegate node, held twice). What is done with the
  result is a node after the delegate node; an adjustment that adds both can
  complete the running node at the same time (`wfe run adjust
  --completing`). `wfe delegate request` names nodes still running.
- **A completed child is told once** (project_migration p8 ex1): when the
  attempt that completed its execution ended (documentation steps reopen and
  recomplete it within one attempt), under the completing entry's receipt.
  A child reopened and completed again later is a new result.

## Operations

| Operation (`shared/run.ts`) | Who | `wfe delegate …` | Effect |
| --- | --- | --- | --- |
| `delegation.dispatch` | the parent's agent (its attempt) | `request <run> <node> --request <file> [--original <file>] [--replaces <d>]` | resolves and checks the target, writes `delegations/<d>/request.md` and `original-input.md`, records the delegation; the node waits on it |
| `delegation.bind` | WFE (direct delivery; the agdev link for a remote child) | — | the child created for the request, and how it was delivered |
| `delegation.event` | relay (executor reconcile) | `sync` | one fact of the child, by receipt `delegation:<uid>:<child seq>:<type>`; a waking fact queues the parent's continuation |
| `delegation.take-up` | the parent's agent | `take-up <run> <d> <n>…` | the facts are read; the node resumes |
| `delegation.answer` | the parent's agent | `answer <run> <d> <q> --answer <text> [--because answer:<q>]` | delivered to the child and recorded there as the answer; the node waits |
| `delegation.instruct` | the parent's agent | `instruct <run> <d> --instruction <text>` | recorded as the child's additional instruction |
| `delegation.dispose` | the parent's agent | `dispose <run> <d> --disposition satisfied\|rejected\|abandoned --note <text> [--event <n>] [--manifest <digest>] [--yes]` | closes the delegation; `satisfied` lets the node complete; `satisfied` is assessed first (fix6) |
| `delegation.revise` | the parent's agent | `revise <run> <d> --instruction <text> --reason <text> [--event <n>] [--manifest <digest>] [--evidence <text>] [--because … \| --follow-up <rv> \| --reopen]` | (fix6) returns the latest result to the same child; delivered to it; the node waits |
| `delegation.attribute` | whoever corrects the record, by name | `attribute <run> <d> <n> --origin agent\|person\|review --from <whose> --reason <evidence> --by <you>` | (tidy p3) appends an attribution to correction request `n`; the original stays; nothing is sent |

Reading: `wfe delegate list|show <run> [<d>]`, `wfe delegate file <run> <d>
<path> [--out <file>]` (a file of the child's copy, compared with the hash a
fact recorded), `GET /api/workspaces/<ws>/runs/<wf>/<run>/delegations` (each
delegation with its state and its child's situation now; for a child, the
delegation it came from). The attempt's brief lists every delegation and the
facts not yet taken up in full.

Host store: `delegate.sqlite` (index rows: parent, target, child, how far the
child's history was relayed; the direct-delivery journal).

Error codes: `delegate-target`, `delegate-cycle`,
`delegate-relation`, `delegation-open`, `delegation-predecessor`,
`delegation-unknown`, `delegation-unbound`, `delegation-event`,
`delegation-result`, `result-superseded`, `delegation-closed`,
`delegation-unsatisfied`; fix6: `result-returned`, `delegation-correcting`,
`child-stopped`, `child-active`, `correction-state`.

HTTP (fix6): `POST runs/<wf>/<run>/delegations/<d>/dispose` and `…/revise`
take the same fields (`by`, `event`, `manifest`, `yes`, `receipt`,
`attempt`; `because` for revise) and refuse with 409 `{detail: {code:
"reminder", reminders, assessment}}`; `GET …/delegations/<d>/assessment`
reads one; `GET …/delegations` carries each latest result's assessment. A
remote worker forwards `wfe delegate …` with its flags like every command.

## Assessing a result (workflow_editor fix6)

Where the parent receives a result, WFE assesses it from the child's
records (`shared/assessment.ts`, file layer in `server/delegate.ts`). It
separates what the records show from what the child's frozen node catalog
expects: an expectation is the person's prose, shown beside the evidence,
never compiled into a rule.

| Check | Evidence | Status |
| --- | --- | --- |
| Presentation missing | the child's completed work as of the result — `work` template nodes, and untemplated nodes it added with files beyond notes ([runs.md](runs.md) *Reminders*) — and viewable candidates by extension (manifest artifacts, node artifacts, files its copy changed, in every repository it owns: a signal, not proof); its presentations and when each was registered or linked | `missing` when work completed after the latest presentation (an earlier page does not cover later work), or viewable files with no presentation at all; else `ok` |
| The person's review not recorded | only with `accepts: person` and a deliverable (work, viewable files or a presentation); the child's answers and decisions as of the result; this delegation's answers that relay the person's words (`because`) to the child's own question about its result (a result confirmation, or one asked with its presentation); human review rounds about the child. tidy p3: a correction request — the person's relayed words, a go-ahead or the agent's own finding — and relayed words answering a question that was not about the result are listed as facts and are not review evidence (p2's conduct/run-051 d1 read `ok` from a correction that relayed a go-ahead) | `ok` when an answer from the person (`onBehalfOf`) about it is traceable; else `unknown` — a confirmation node, a decision or an agent's own answer alone does not show they reviewed it, and unknown is not a proven violation |
| (p17) Human review | the parent's review rounds about this child | a round pending: `review-unrecorded` is `deferred` (handed to the person, not missing); decided: their review (a synthetic actor said so); a page a round serves or will serve again is the review's, not a forgotten cleanup |
| Presentation still serving | the child's presentations now: review questions and their state, a planned cleanup, a recorded request to keep it (`presentation.retain`) | `serving` only for an answered (or never asked) review with no cleanup planned and no request to keep it; an unfinished review or a kept page is a fact, not an omission. Nothing stops a page because this ran |
| (tidy p1) Documents written | the child's documentation steps completed as of the result and whether each recorded its document | `missing` when one completed with no document (a child's freework run told its requester the audit was in a report.md it never wrote, and ponderer judged it satisfied 14 s later); `ok` when every completed one has it; no check without one |

**Bound to the result.** Each assessment names the delegation, the result
event, its manifest digest, the child's completing seq, the history position
its frozen facts come from (the entry after which the attempt that completed
it ended; the child's own history replayed to it), the child's revision in
force then and its catalog snapshot. What changed in the child since
(entries after that position, corrections) and its integrations (historical
facts bound to their own revisions) are listed apart. What could not be read
(the child's record, its copy, its catalog) is said explicitly. The child is
read without its lock; the parent's lock holds the result's identity.

**Where.** `wfe delegate show`; the take-up of a result (printed once); the
brief and continuation of the parent's next attempt while the result is not
taken up; `GET …/delegations`. As reminders (codes `delegated-<check>`,
merged with the parent's own into one response, refused before anything is
recorded, `--yes` / `yes` for that command only):

- `wfe delegate dispose --disposition satisfied` (HTTP `…/dispose`), under
  the parent's lock, before the delegation closes;
- the parent's outward report — `wfe conversation reply|contribute --kind
  result|synthesis`, with or without `--completing` — and the completion
  that completes the parent run (`wfe run complete`, `adjust --completing`,
  HTTP `ops`/`adjust`), whether or not the parent has work nodes of its own.

At report time every delegation's latest result is assessed — open or judged
`satisfied` (an earlier `--yes` exempts nothing later); `rejected`,
`abandoned` and orphaned ones are not. A corrected result is assessed anew,
so a repaired omission disappears. The repairs offered are the parent's:
inspect the child's evidence, relay an actual answer of the person, return
the result to the child, or continue as it is. They never ask the parent to
act as the child or to record a review nobody gave. A stale result
(`result-superseded`), a result returned for correction (`result-returned`)
and attempt ownership stay errors that `--yes` does not pass.

**The claim beside the evidence (tidy p2).** The checks above are facts of
the records; whether the entry is right, the tests ran or a delivery is
portable is not observable, and the assessment says so instead of judging
it. Its lines, in order:

- a findings headline: `FINDINGS (n)` with the checks that are not `ok`,
  which are listed before the ones that passed; or `findings: none in what
  WFE checks …; the content is not checked`;
- for a result that answers a correction (a later event than a returned
  one), which request it answers and that an earlier judgement or check
  does not cover it;
- `claim —`: the child's outcome and its report (path, hash, commit) as the
  manifest has them;
- `records —`: the files its copy changed outside its run folder, those
  removed, the manifest's artifacts, its published outputs, and the paths
  the report names in backticks (with a folder) that are not in its copy or
  run folder — a thing to look at, not a defect;
- the checks;
- `to judge:` read the files (`wfe delegate file`) before judging, the
  questions that fit the child's work, and the way back to the same child.

The questions (`shared/resultEvidence.ts`) are chosen from the child's
template provenance (a `tidy` node), the paths it changed (an entry or a
guide, tests, delivery or adoption manifests, `.gitignore`), what it removed
and its outputs: documentation, delivery, removals and moves, tests. A path
chooses a question, never a finding; nothing chosen leaves the general
questions alone. They add no reminder and no state: dispose, reports and
`--yes` behave as above. The HTTP view's `assessment` carries the same
fields (`claim`, `evidence`, `correction`, `inspect`).

Why: in tidy p1's trial ponderer judged three results 12–23 s after taking
them up, from the outcome line. It accepted a report that was never written
and a README with one host's addresses, whose assessment was all `ok`.

**At dispatch.** `wfe delegate request` prints, as information, who accepts
the child's result, that the parent relays its questions and presentations
to the person, and the target's node catalog expectations as they are now (a
preview: the child freezes its own snapshot at creation, and that snapshot
is what its result is assessed against). The child's brief names the person
the parent acts for and the parent's relay role; the request itself is
delivered unchanged.

## Correction (workflow_editor fix6)

`wfe delegate revise` returns the child's current completed result to the
same child instead of closing the delegation (`dispose rejected` stays
closure and replacement):

1. **Parent.** `delegation.revise` under the parent's lock: the delegation
   is open and bound; the result is the latest completed event, taken up,
   with the manifest digest given (if any); no correction stands for it; the
   child did not fail or get cancelled after it. The file layer also
   refuses a child that is cancelled, executing, or not completed now. The
   delegate node waits (`correcting`).
2. **Delivery.** WFE delivers it directly as answers and instructions are
   (item `revision:<n>`); a lost delivery is repeated from the record.
3. **Child.** The child records `correction.receive` under the receipt
   `direct:<uid>:revision:<n>` (a repeated application is one record). A completed child is reopened: its execution is
   `in-progress` while the correction is unaddressed, so the scheduler
   continues it (one job per correction, reconcile queues a lost one) and
   the relay does not announce the old result again. A refusal (the child
   completed again since — `result-superseded` —, is no longer completed,
   or is cancelled) is told to the parent as `answer-refused` with
   `revision`, which ends `correcting`.
4. **Work.** The child's agent reads it ("This attempt", `wfe run
   correction`), adds the missing work as nodes with its ordinary adjustment
   and performs it — present, feedback, cleanup as its catalog expects;
   completed work is kept — or records `--no-change` with why.
5. **New result.** Its next completion is a new `completed` event with a new
   manifest; the parent takes it up and assesses that version before it
   judges or reports it.

A held parent records the child's facts and launches nothing until resumed;
cancelling the parent never cancels the child. Competing requests are
ordered by the parent's lock: after `revise`, `dispose satisfied|rejected`
of the returned result is refused (`result-returned`), `abandoned` closes
the delegation, a second `revise` is refused (`delegation-correcting`);
after a disposition, `revise` is refused (`delegation-closed`), with two
exceptions for a result judged `satisfied`: a human review's requested
changes (`--follow-up <rv>`, p17), and the person's later words naming that
result (`--because answer:…|instruction:…`, p18: a standing conductor hears
them after it accepted the result), and the parent agent's own finding
(`--reopen --evidence`, tidy p3). Each reopens the same delegation for
the same child, keeps the earlier disposition in `reopened` (with the
review, the words, or `origin: agent` and the evidence), and waits again
on the delegate node.

**The agent's own finding (tidy p3).** In p2's fixture trial
(ponderer conduct/run-051 d1) the conductor judged a partial correction
satisfied, then read the test itself and found it unchanged. The only way
to reopen was the person's words, so it cited an Omni go-ahead (#464); the
correction was recorded "from Omni Agent (for Developer)" and the review
check read `ok`. Now:

- A correction without `--because` or `--follow-up` is the recording
  agent's finding (`origin: agent`, `from` = the agent), with what it
  checked in `--evidence`. Returning what the commissioned work left out
  needs nobody's go-ahead.
- `--reopen --evidence` reopens a `satisfied` judgement of the latest
  result by the agent's own finding. Evidence is required; `--because` with
  it is refused (one origin per correction); a delegation that is not
  judged, or judged `rejected`/`abandoned`, is refused as before; a newer
  result than the one judged must be judged instead. A person's hold on
  the parent stays: the request is recorded and nothing is launched until
  the person resumes it.
- Readers (`wfe delegate show`, the assessment's facts, the child's
  correction) show the actual actor and origin. A correction is never a
  review of the result.
- `wfe delegate attribute` appends an explicit attribution to a recorded
  correction (who corrected the record, when and on what evidence); the
  original `from`/`because` stay as recorded, and the child keeps what it
  received. Applied once, to conduct/run-051 d1 correction 1 (tidy p3). Replay keeps
both the returned and the corrected result (events, `revisions`, the child's
`corrections`).

**Follow-up after a person's review (p17).** A result the parent judged
`satisfied` and handed to a human review ([reviews.md](reviews.md)) may
come back with requested changes. `wfe delegate revise … --follow-up <rv>`
(`followUp`) then reopens the delegation for the same child: the round
must be `changes-requested` and must have reviewed this child; the
`satisfied` disposition moves to `reopened[]` (kept, with the round, who and
when), the completed delegate node waits again, the relay index row opens
again, and the correction is delivered as above. Only a `satisfied`
disposition is reopened; `rejected` and `abandoned` stay replacement. A
cancelled, executing or unreadable child is refused by the file layer as
before, never reopened in appearance only.

Earlier acceptances and integrations of the child stay historical facts
bound to their revisions: an acceptance binds its tree, so the corrected
files need a new acceptance, and integration follows the child's own rules
([integration.md](integration.md)). When integration is permitted is not
changed.

## Views and observation

- **Editor**: the delegate inspector selects the target project (this one or
  another registered one), its workflow and who accepts the child's result;
  validation knows the registry's projects (`delegate-project-unknown`,
  `delegate-target-unknown`, `delegate-no-intake`, `delegate-recursive`).
  A delegation task can also be a node-catalog template of type `delegate`
  with an optional `target` ([node-catalog.md](node-catalog.md)).
- **Run view**: the delegate node's card says where its child stands; the
  selected node and Detail's *Delegations* show each child, its links
  (run view, conversation, progress, detailed IO), the next move, what it
  asked and how it was answered, the result manifest and the disposition;
  the focus card says what the run waits for; a child's *Related runs* links
  back to the run that delegated it.
- **Observation** ([observation.md](observation.md), *Delegations*): the
  wait names the child as responsible; Observer treats a healthy wait as
  quiet, a relayed fact without a continuation as an unowned continuation,
  a fact not relayed for 5 minutes and a dispatch without a child for 15
  minutes as suspicions told to the owners, and the child's own failures as
  the child's incidents only.

## Limitations

- Parent and child runs are on the same execution host (the relay reads the
  child's record locally). A delegate node with `instance:` delegates to
  another installation over the agdev link instead ([peers.md](peers.md),
  improve_multinodes p1): there the child is that installation's ordinary
  run and only its relayed facts reach this host. Answers, instructions,
  corrections (`revise`) and `cancel` go to it over the link once that
  installation has said it applies them (p2); its files are read by Git
  (`git fetch`, `wfe delegate verify`), never with `wfe delegate file`.
- A request is delivered as text with its original beside it; files the
  parent wants the child to use are named in it (or placed where the child
  reads), not attached.
- Exactly-once delivery is not claimed; identity and application are (every
  application has its receipt).
