# Observer over workflows (observer p3)

Observer watches workflow runs, not conversations. It reads WFE's observation
(`wfe observe --json`, `workflow_editor/docs/observation.md`),
decides mechanically what is moving, waiting or stopped, opens one incident
per interruption episode, asks a recovery recipient to investigate through
a WFE submission, and records a recovery only when later observations show useful
work. Front, `#front` conversations, traces and serving probes are not part
of it.

## Who does what

| Party | Responsibility | Never |
| --- | --- | --- |
| WFE | run state, validated transitions (`run.recover`), the observation | infers liveness from silence |
| Executor (autolab `wfexec`) | processes, the queue, heartbeat, reconcile | decides a recovery |
| warden (coordination runs, improve_wfrun p4) | which queued work starts where, and when a deferral is looked at again (WFE `docs/coordination.md`) | — Observer never admits or defers work |
| Observer | discovery, classification, incidents, assignment and delivery, verification, its own health | changes a run, resumes, accepts, kills |
| Recovery agent (runs of the recovery role's workflow, e.g. `warden/recover`) | investigates the evidence and decides: continue (`wfe run recover`), repair the environment, or hand the question to a person | writes while the old attempt lives, replays side effects, accepts results |
| Person | holds, answers, cancellation, acceptance, anything outside the recovery authority | — |
| Watchdog (`agobserver.watchdog`, separate process) | Observer's loop and source freshness, the executor heartbeat, recovery backlog; for 90 s after its own start it does not judge a record older than that start (`starting`) | depends on Observer's process |

## Classification

Each look classifies every observed run from its own facts. Elapsed time
makes a suspicion, never a verdict.

| Observation | Condition | Response |
| --- | --- | --- |
| `hold.human` (stopped), or an unanswered question to a person | `respected-hold`, `awaiting-person` | none; stays observed |
| `node.wait` on an external reference | `awaiting-external` | none; observed, with its age |
| `interrupted` / `unknown` hold, no recovery recorded for that attempt | `interrupted` | incident (family `attempt`) → recovery request. The fact leads with the hold's cause in a few words when the hold has one (project_migration p8 ex1: `talk left running at exit`, `d1 completed #1 not taken up`, `ended with nothing of its work recorded`, `process lost; outcome unconfirmed`), the sentence after it; `affected` names the children a missed fact concerns |
| the same interruption (cause kind and what it names) after two recoveries in a row (`attempts.ends`) | `interrupted` (`repeated`) | incident (family `attempt`) told to the owners, not recovered a third time: another recovery would lift the hold without addressing its cause |
| an attempt open in the record, process gone or the attempt row ended | `lost-attempt` | grace for the executor's reconcile (180 s), then incident (family `attempt`) |
| an attempt alive with an open tool call inside its declared timeout (+60 s), or log/CPU advancing | `working` | none |
| an attempt alive with an open tool call past its declared timeout (+60 s) | `uncertain` (`tool-overrun`) | as below, suspected from the moment the bound passed |
| an attempt alive, log silent ≥ 900 s, no open tool call with a timeout, CPU not advancing | `uncertain` (`silent`) | suspected from the moment the silence crossed 900 s; judged by the local model 300 s later; `waiting` postpones (30 min, doubling to 2 h, only while the evidence digest still matches, at most 6 h in all); `stalled`/`unclear` are told to the owners at 900 s, never before a pending judgment; never a second writer |
| a node failed and nothing else runs (execution `stopped`) | `awaiting-person` (`failed`) | none: the failure is a record, the person decides |
| an external wait past its declared `deadline` | `uncertain` (family `wait`) | told to the owners |
| ready work or an answer recorded and not taken up, no hold, no attempt, no queued job | `unowned` | grace 180 s (the executor's reconcile re-queues answers), then incident (family `continuation`) → recovery request |
| a queued job behind a healthy executing attempt, or awaiting warden's decision, or deferred by warden inside its time (improve_wfrun p4: `queue.job.admission`) | `queued` (kind `awaiting-decision`, `deferred`, `admitted`) | none (a legitimate wait; the decision is warden's) |
| a deferral past its reconsideration time with no later decision (`deferUntil` passed, still `deferred`) | `uncertain` (`reconsideration-overdue`, family `coordination`) | told to the owners after 600 s (WFE's reconcile wakes warden itself within a minute); closes when a later decision admits or defers again |
| coordination turns ending without a decision while work awaits one (`coordination.stalled`), or jobs awaiting a decision for 900 s with no turn open or opening | `coordination-stalled` (family `coordination`, uid `coordination`) | one incident naming the waiting runs → owners at once (WFE already paused automatic turns; `wfe coordinate wake`); closes when a turn decides again or nothing awaits |
| a coordination run's own interruption | `interrupted` (`[recovery] exempt` names `warden/coordinate`) | told to the owners, never sent to recovery: WFE's own path opens the next turn |
| a delegate node waiting on its child (workflow_editor p10; `waiting.responsible = delegation:<child uid>`) | `awaiting-delegation` | none, however long it lasts: the child is a run of its own with its own finding — its failure, hold, lost process or interruption is the child's incident, never a second one on the parent |
| a delegate node waiting on a child whose record cannot be read here (`delegations[].problem`) | `unobservable` (`child-unreadable`, family `observation`) | nothing concluded; told to the owners if it persists 30 min |
| a relayed child fact the parent has not taken up, no queued job | `unowned` | as any unowned continuation (recovery request) |
| a child fact that wakes the parent, not recorded on the parent for 300 s (`delegations[].unrelayed`) | `uncertain` (`relay-stalled`, family `delegation`) | told to the owners: the relay is WFE's, nothing a recovery agent can redo |
| a dispatch with no child (`delegation-unbound:`) whose request delivery failed, may have been posted, or is older than 900 s | `uncertain` (`unbound-dispatch`, family `delegation`) | told to the owners (`wfe notify deliveries`, `wfe intake status`) |
| an admitted job (or any job, without coordination), its worker healthy, not claimed for 300 s | `queue-stalled` | incident (family `queue`) → owners (not implemented in code as of improve_wfrun p4: the coordination stall above and the executor outage cover the observed cases) |
| executor heartbeat older than 180 s | `executor-down` | one infrastructure incident naming every affected run → owners (independent route); no per-run requests |
| failed/attention checkpoint, failed/refused/attention integration | `publication` / `integration` | separate incident; recovery may retry publication, never re-run work or accept |
| `source.state` not ok, `ambiguous`, or the observation command failing | `unobservable` | observation problem recorded once; nothing concluded, nobody asked |
| completed or cancelled with nothing outstanding | `terminal` | an open incident closes with that outcome |

## Incident identity

An incident is `(run uid, family, episode)`:

| Family | Episode |
| --- | --- |
| `attempt` (interrupted, unknown, lost-attempt, uncertain) | the attempt id whose end (or silence) is the problem; a silence that ended (`false-alarm`, `resumed`) and returns reopens it with a new first suspicion |
| `wait` | the waiting node and its deadline |
| `observation` | the source state |
| `continuation` | the record sequence at which the run became unowned |
| `queue` | the job id |
| `coordination` | a deferral's decision id (`defer:<id>`), or the stall's start (`stall:<since>`, `idle:<oldest>`) |
| `publication` | the checkpoint id |
| `integration` | the integration row id |
| `executor` | the last heartbeat time seen before the outage |

The kind and its description are attributes: `lost-attempt` becoming
`unknown` after the executor's reconcile is the same incident, and so is a
different wording of the same evidence. Retry budgets belong to the
incident and are never replenished by a re-description. A later attempt
interrupted again is a new episode — and WFE's own `recover-budget` (2 per
person-originated control) bounds the chain.

## Records (`agobserver/.local/workflow/observer.sqlite`)

| Record | Fields |
| --- | --- |
| incident | id, run uid, workspace, ref, family, episode, kind, state (`open`, `assigned`, `recovering`, `verifying`, `escalated`, `closed`), first suspicion, detected, next review, outcome (`restored`, `handed-off`, `completed`, `cancelled`, `held`, `false-alarm`, `withdrawn`, `escalated`), outcome evidence |
| evidence | incident, observed at, observation digest, the run facts the decision used |
| judgment | incident, evidence digest, verdict, model, prompt/input/transcript paths, invalidated |
| assignment | incident, n (≤ 2), recipient, request text digest, journaled, delivery state (`owed` → `sending` → `sent` \| `failed` \| `uncertain`), message id, acknowledged by (recovery run uid), performed (`run.recover` seq), actor, outcome |
| event | append-only log of every transition above |

Workflow records and Git stay authoritative; these records say what
Observer saw, asked and verified.

## Recovery path

1. **Journal, then submit.** The assignment row carries its receipt `submission:<requester>:<incident>:<n>`
   (requester `Observer`, `[recovery] requester`); `wfe submit` hands the request text to WFE's own intake
   (`POST /api/submissions`, workflow `[recovery] workflow`, workspace `[recovery] workspace`). WFE creates the
   recovery run once per receipt — input `request`, requester Observer, source `{kind: submission, receipt}` —
   and queues its start. Who may submit to which workflow: `<area>/submitters.json` only. The request carries
   the hold's cause in short and the run's recent attempt ends, and for a parent run every delegation by
   identity, with the rule that a child is never replaced or repeated from a recovery (project_migration p8 ex1).
2. **Pending while WFE is unreachable**: retried each look, never a second run; past `ack_timeout` the owners
   are told (an alert).
3. **Acknowledgement** is the run WFE bound to the receipt; **performance** is `run.recover` naming the incident in the target
   run's history; **restoration** is a later observation showing the
   continued attempt's agent reporting work (a progress, completion, a
   question to a person, or the run completed) after the recovery. A new PID,
   an ack or a promise is none of these.
4. **Bounds.** At most 2 assignments per incident, the second after 30 min
   without acknowledgement or with the recovery run ended without action.
   A recovery run is never itself the target of a recovery request: an
   incident on an `warden` run is told to the owners. A failed submission or
   alert is recorded and retried; it never stops observation or erases an
   assignment.
5. **Outcomes.** `restored` (verified progress), `handed-off` (the recovery
   agent recorded a question to a person, or left the run held with its
   reasons), `completed` / `cancelled` / `held` (the run reached that state
   by someone else's record), `false-alarm` (the next observation shows it
   was never stopped), `escalated` (owners told; the incident stays open
   until one of the others).

Assignments journaled by the Zulip route before cluster_teamwork p4 (`route` unset) stay in the store as history; one still open is closed `retired-route` and the next assignment is submitted.

## Sessions

Run = the work; session = a retained harness conversation; attempt = one
execution interval. The observation carries the attempt's session id when
the log names one (`process.log.session`, from the harness's `init` event).
Monitoring obligations attach to the run and incidents to attempts:

- two intervals sharing a session id are two attempts, two episodes, each
  with its own first suspicion (`test_a_fresh_session_and_two_intervals_…`);
- a process restart within an attempt is the same episode and keeps its age
  (`test_a_process_restart_within_an_attempt_…`);
- an idle retained session can wait legitimately (a question, an external
  result with a deadline); its existence does not prove a process, and its
  waits are judged from the run's record, not from the session;
- a background job does not become durable because a session is kept: the
  `wfrun` guide's foreground-wait rule stands until the job-lifetime
  contract changes.

**The attempt time budget is not a session lifetime** (agent_session p1).
`wfexec` stops an attempt after `timeout_seconds` (4 h), one process per
attempt. Under a workflow's `run` session policy later attempts resume the
run's retained conversation, and the budget stays per execution interval: a
retained session holds no slot and no process while it waits, and its age is
no stall timer. A wait keeps its own deadline (`node.wait --deadline`).
The observation reads the session from the record: `session` (policy, the
current session with its attempts, the last replaced/retired ones and why)
and `process.session` (the session the attempt ran in, and whether it was
resumed); the log's `session` is supporting evidence. Both go into an
incident's evidence. The recovery request names the policy and the sessions,
and under `run` says how to retire the conversation (`wfe run session <run>
--retire`) when it should not be carried on; a continued run otherwise
resumes it with the recovery finding in its brief. Replacing or retiring a
session resets no recovery budget (only a person's control does).
Delegation will add parent/child run and result-wait references; until then
no conversation ancestry is inferred.

## Retired (observer p3 step 5)

The conversation monitor (`monitor`, its `triage`, `health` probes,
`review`/`review_status`, `hold`, `disposition`, `withdraw`, `trial`) is
removed with its tests: it discovered `#front` conversations, traced them,
probed listener servings and asked Front to recover. The watch entrance
(`listener`, `intake`, `worker`, `observe`, `notify`, `anchor`,
`destination`, `store`) stays as a library and is not started.
`python -m agobserver.retire_legacy [--dry-run]` archives the old local
state (incidents, watches, health files) with an inventory, once, at the
cutover; nothing is replayed and nothing is claimed complete. The process is
`com.agdev.agobserver` (`service/workflow.sh`,
`devenv/launchd/com.agdev.agobserver.plist.in`); it writes `agag.status.v1`
to `AGAG_STATUS_PATH` after each look whose observation came back, which is
how nodeutils and nctl see Observer alive.

## Running it

`python -m agobserver.wfmonitor [--once] [--settings .local/workflow.toml]`
(`agobserver-workflow`). Settings (ignored, per host):

```toml
wfe = ["<area>/bin/wfe"]          # the launcher of the operating area
channel = "agobserver-a"          # the name incident notes are kept under (outbox state `local`); owner notices go
                                  # to the alert sender (`alerted`)
interval_seconds = 60
judge = true                      # local-model judgments (role wftriage)
[timing]                          # optional overrides for trials (seconds; wfclassify.TIMING)
[recovery]                        # the recovery path (wfrecover); agdevctl renders it from <area>/roles.json
enabled = true                    # with no workflow (the recovery role not filled), there is no recovery path:
                                  # recoverable incidents are told to the owners (summoner p2)
workflow = "warden/recover"       # <project>/<workflow> of the recovery role's holder (no default)
workspace = "warden"              # its workspace: observed whole (--terminal) while assignments are open
exempt = ["warden/coordinate"]    # the coordination role's workflow: never sent to recovery
# ack_timeout = 1800, max_assignments = 2, verify_timeout = 3600
```

**Owner notices and alerts (cluster_teamwork p5).** When the installation has an alert route
(`AGDEV_ALERT_TOOL` and `AGDEV_ALERTS`, rendered by agdevctl from `[alerts]`), every message to the
owners (escalations, closures, WFE-down past `ack_timeout`) is queued to that sender as event
`observer:<marker>` and the outbox row becomes `alerted` — independent of WFE (without an alert route it
stays `failed`, visible); the
watchdog sends its own changes there too (event `watchdog:<component>`, occurrence and recovery) and
retries what the sender owes every check. An alert is a notice: it never acknowledges or replaces a
recovery assignment, which stays a WFE submission bound to its run.

Store: `.local/workflow/observer.sqlite`; health: `.local/workflow-health.json`
(`agobserver.workflow-health.v1`: cycle, observation source, run conditions,
open incidents by state, judgments, unacknowledged recovery assignments,
outbox). While the executor is down, lost attempts and unowned work are
listed as affected runs of the one executor incident, not incidents of
their own.
