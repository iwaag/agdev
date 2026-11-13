"""What each observed run needs, decided from workflow and executor facts.

observer p3 step 3 (`docs/workflow.md`, *Classification*). Pure: an
observation (`ag.wfe-observation.v1`, `wfe observe`) in, findings out. No
Zulip, no Front, no topic names, no serving ids — a run is its `uid`, and
everything said about it comes from its record, its attempts, its process
and its queue as WFE reports them.

A finding is a *suspicion* with an identity: `(uid, family, episode)`. The
monitor turns it into an incident when its grace has passed; the identity
is what keeps a re-description of the same episode from opening a second
incident or replenishing a budget.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

SCHEMA = "ag.wfe-observation.v1"

#: Seconds. A person may override them for trials (`workflow.toml` `[timing]`).
TIMING = {
    "lost_grace": 180,         # an open attempt whose process is gone: the executor's reconcile ends it within 60 s
    "unowned_grace": 180,      # ready work / a recorded answer without a job: reconcile re-queues answers within 60 s
    "quiet_log": 900,          # a live attempt whose log has not moved for this long is not evidently working
    "tool_grace": 60,          # an open tool call is a wait up to its declared timeout plus this
    "judge_after": 300,        # an uncertain attempt is judged by the local model this long after first suspicion
    "escalate_uncertain": 900,  # …and told to the owners this long after it, unless judged a legitimate wait
    "queue_stall": 300,        # a queued job, slot free, executor healthy, not claimed for this long
    "executor_stale": 180,     # executor heartbeat older than this: the executor is down
    "unobservable_report": 1800,  # an unreadable source is told to the owners once after this long
    "review_wait": 1800,       # a legitimate-wait verdict postpones the next judgment this long (doubling)
    "review_wait_max": 7200,
    "postpone_max": 6 * 3600,  # a wait judged legitimate for longer than this is told to the owners anyway
    # workflow_editor p10 (delegation): the relay runs every 5 s (intake) and 60 s (reconcile).
    "relay_grace": 300,        # a child's fact that wakes the parent, not recorded on the parent for this long
    "unbound_grace": 900,      # a dispatched request that has not become a child for this long
    # improve_wfrun p4 (coordination): a deferral past its reconsideration time, or turns ending without a
    # decision while something awaits one (WFE's own reconcile wakes and retries within a minute).
    "coordination_grace": 600,
    "coordination_stall": 900,  # jobs awaiting a decision this long with no coordination turn open or opening
}

#: Conditions that need nobody (the record says whose move it is).
#: `idle-input` (workflow_editor p18): a conversation's standing conductor at
#: rest between turns; the conversation's next event continues it.
QUIET = ("respected-hold", "awaiting-person", "awaiting-external", "awaiting-delegation", "working", "queued", "terminal", "idle-input")
#: Families a recovery agent is asked about; the others go to the owners.
RECOVERABLE = ("attempt", "continuation", "publication", "integration")
#: Conditions a queued job may be in (improve_wfrun p4): how WFE admits it.
QUEUED_KINDS = {"awaiting": "awaiting-decision", "deferred": "deferred", "admitted": "admitted", "claimed": "claimed"}


def ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def incident_id(uid: str, family: str, episode: str) -> str:
    return "i" + hashlib.sha256(f"{uid}\0{family}\0{episode}".encode()).hexdigest()[:10]


@dataclass
class Finding:
    uid: str
    workspace: str
    ref: str  # <workflow>/<run>
    condition: str
    family: str | None = None
    episode: str | None = None
    kind: str = ""
    fact: str = ""
    since: float | None = None  # when the record says the condition began, if it says
    grace: float = 0.0  # how long a suspicion must persist before it is an incident
    recover: bool = False  # ask a recovery agent (else the owners)
    evidence: dict[str, Any] = field(default_factory=dict)
    affected: list[str] = field(default_factory=list)

    @property
    def key(self) -> str | None:
        return incident_id(self.uid, self.family, self.episode) if self.family and self.episode is not None else None


def _compact(run: dict) -> dict[str, Any]:
    """The facts a decision about this run used — kept as its evidence."""
    p = run.get("process") or {}
    log = p.get("log") or {}
    return {
        "uid": run["identity"]["uid"], "seq": run.get("seq"), "situation": run.get("situation"),
        "execution": (run.get("execution") or {}).get("state"),
        "active": (run.get("execution") or {}).get("active"), "ready": (run.get("execution") or {}).get("ready"),
        "hold": run.get("hold"), "attempts": run.get("attempts"), "waiting": run.get("waiting"),
        "progress": run.get("progress"), "queue": (run.get("queue") or {}).get("job"),
        "process": {k: p.get(k) for k in ("attempt", "state", "alive", "pid", "began", "ended", "exit", "signal", "outcome", "group", "session")} if p else None,
        # agent_session p1: the run's session policy and current session, from
        # the record. Evidence only: a retained session is no process and its
        # age is no stall timer; incidents stay per attempt.
        "session": run.get("session"),
        "log": {k: log.get(k) for k in ("last", "turns", "session", "openTool", "ended", "backgroundStopped")} if log else None,
        "source": run.get("source"), "problems": run.get("problems"), "unavailable": run.get("unavailable"),
        "recoveries": run.get("recoveries"), "publication": run.get("publication"), "integration": run.get("integration"),
        "input": run.get("input"), "executor": run.get("executor"),
        # workflow_editor p10: the run's delegations and their children's situation.
        "delegations": run.get("delegations"),
    }


def cause_text(cause: dict | None) -> str | None:
    """A hold's structured cause in a few words (project_migration p8 ex1;
    WFE `shared/run.ts` HoldCause). None for holds recorded without one."""
    if not cause:
        return None
    code = cause.get("code")
    nodes = ", ".join(cause.get("nodes") or [])
    if code == "left-running":
        return f"{nodes} left running at exit"
    if code == "left-ready":
        return f"{nodes} left ready at exit, nothing waiting"
    if code == "nothing-recorded":
        return f"ended with nothing of its work recorded ({nodes} never started)"
    if code == "missed-event":
        return "; ".join(f"{e.get('delegation')} {e.get('type')} #{e.get('n')}" for e in cause.get("events") or []) + " not taken up"
    if code == "process":
        return str(cause.get("detail") or "the process did not end normally")
    if code == "lost":
        return "process lost; outcome unconfirmed"
    return str(code)


def cause_signature(cause: dict | None) -> str | None:
    """What makes two interruptions the same one coming back: the cause's
    kind and what it names (nodes, or delegations — not event numbers)."""
    if not cause:
        return None
    named = sorted(cause.get("nodes") or []) or sorted({str(e.get("delegation")) for e in cause.get("events") or []})
    return f"{cause.get('code')}:{','.join(named)}"


#: Recoveries after which the same interruption is told to the owners instead of recovered again.
REPEAT_AFTER = 2


def repeated(attempts: dict) -> tuple[int, str] | None:
    """The current hold's cause came back after `REPEAT_AFTER` recoveries in
    a row (each recovered end followed by an end held for the same cause):
    another recovery would repeat it."""
    ends = [e for e in attempts.get("ends") or [] if e.get("held") in ("interrupted", "unknown")]
    if not ends:
        return None
    sig = cause_signature(ends[-1].get("cause"))
    if sig is None:
        return None
    n = 0
    for e in reversed(ends[:-1]):
        if not e.get("recovered") or cause_signature(e.get("cause")) != sig:
            break
        n += 1
    return (n, sig) if n >= REPEAT_AFTER else None


def is_recovery_run(run: dict, recovery_workflows: tuple[str, ...]) -> bool:
    ident = run["identity"]
    return f"{ident['project']}/{ident['workflow']}" in recovery_workflows


def classify_run(run: dict, now: float, timing: dict[str, float], prev_cpu: dict[str, float] | None = None,
                 executor_down: bool = False, recovery_workflows: tuple[str, ...] = (), remote: dict | None = None) -> Finding:
    """`remote` (project_migration p7): the remote worker that performs the
    run, as the observation reports it. Its process is that worker's to
    observe; its log is shipped to the coordinator, so liveness is judged
    from the log and the worker's contact, and a lost contact is the
    worker's silence — never a lost process."""
    ident = run["identity"]
    uid = ident.get("uid") or f"{ident['workspace']}:{ident['workflow']}/{ident['run']}"
    base = dict(uid=uid, workspace=ident["workspace"], ref=f"{ident['workflow']}/{ident['run']}")
    evidence = _compact(run) if ident.get("uid") else {"source": run.get("source"), "unavailable": run.get("unavailable")}
    src = run.get("source") or {}
    problems = run.get("problems") or []
    # Nothing is concluded from a record that cannot be read, or read consistently, or that two registrations claim.
    if src.get("state") != "ok" or not ident.get("uid"):
        return Finding(**base, condition="unobservable", family="observation", episode=f"{src.get('state')}",
                       kind=str(src.get("state")), fact=f"the run's record cannot be read: {src.get('problem')}",
                       grace=timing["unobservable_report"], evidence=evidence)
    if src.get("consistent") is False or any(p.get("code") == "ambiguous" for p in problems):
        why = "; ".join(p.get("message", "") for p in problems) or "it changed while it was read"
        return Finding(**base, condition="unobservable", kind="inconsistent", fact=why, evidence=evidence)
    execution = run.get("execution") or {}
    hold = run.get("hold")
    attempts = run.get("attempts") or {}
    opened = attempts.get("open")
    process = run.get("process") or {}
    waiting = run.get("waiting") or {}
    job = (run.get("queue") or {}).get("job")
    recover_ok = not is_recovery_run(run, recovery_workflows)
    # Outstanding publication or integration is tracked apart from execution.
    pub = run.get("publication") or {}
    bad_pub = (pub.get("failed") or []) + (pub.get("attention") or [])
    integ = run.get("integration") or {}
    bad_int = (integ.get("failed") or []) + (integ.get("attention") or [])
    if run.get("cancelled") or execution.get("state") == "completed":
        if bad_pub and not opened:
            c = bad_pub[-1]
            return Finding(**base, condition="publication", family="publication", episode=str(c["id"]), kind=c.get("state", "failed"),
                           fact=f"checkpoint {c['id']} ({c.get('kind')}) is {c.get('state')}: {c.get('error')}", since=ts(c.get("updated")),
                           recover=recover_ok, evidence=evidence)
        if bad_int:
            i = bad_int[-1]
            return Finding(**base, condition="integration", family="integration", episode=str(i["id"]), kind="integration",
                           fact=f"integration {i['id']} of the accepted result is not complete: {i.get('error')}", since=ts(i.get("updated")),
                           recover=recover_ok, evidence=evidence)
        return Finding(**base, condition="terminal", kind="cancelled" if run.get("cancelled") else "completed", evidence=evidence)
    if hold and hold.get("human"):
        return Finding(**base, condition="respected-hold", kind="stopped", fact=f"held by {hold.get('by')}: {hold.get('reason')}", evidence=evidence)
    if hold and hold.get("kind") in ("interrupted", "unknown") and not opened:
        last = attempts.get("last") or {}
        episode = last.get("id") or f"seq:{run.get('seq')}"
        log = (process.get("log") or {}) if process.get("attempt") == last.get("id") else {}
        detail = hold.get("reason") or hold.get("kind")
        short = cause_text(hold.get("cause"))
        if short and short not in detail:
            detail = f"{short} ({detail})"
        if log.get("backgroundStopped"):
            detail += f"; the session ended ({(log.get('ended') or {}).get('stopReason') or 'ended'}) with {log['backgroundStopped']} background task(s) stopped by the harness"
        # The parent and children a missed fact concerns, by identity.
        affected = [uid] + [str((d.get("child") or {}).get("uid")) for d in run.get("delegations") or []
                            if (d.get("child") or {}).get("uid") and any(e.get("delegation") == d.get("id") for e in (hold.get("cause") or {}).get("events") or [])]
        again = repeated(attempts)
        if again:
            n, sig = again
            # project_migration p8 ex1: the same cause after recoveries is not lifted again.
            return Finding(**base, condition="interrupted", family="attempt", episode=episode, kind="repeated",
                           fact=f"held {hold['kind']} after attempt {episode}: {detail} — the same cause ({sig}) after {n} recoveries in a row; recovering again would repeat it",
                           since=ts(hold.get("since")), recover=False, evidence=evidence, affected=affected)
        return Finding(**base, condition="interrupted", family="attempt", episode=episode, kind=hold["kind"],
                       fact=f"held {hold['kind']} after attempt {episode}: {detail}", since=ts(hold.get("since")),
                       recover=recover_ok, evidence=evidence, affected=affected)
    if bad_pub and not opened:
        c = bad_pub[-1]
        return Finding(**base, condition="publication", family="publication", episode=str(c["id"]), kind=c.get("state", "failed"),
                       fact=f"checkpoint {c['id']} ({c.get('kind')}) is {c.get('state')}: {c.get('error')}", since=ts(c.get("updated")),
                       recover=recover_ok, evidence=evidence)
    if opened:
        a = opened["id"]
        if process.get("attempt") == a and (process.get("alive") is False or process.get("state") == "ended"):
            return Finding(**base, condition="lost-attempt", family="attempt", episode=a, kind="lost-attempt",
                           fact=f"attempt {a} is open in the record but its process is gone", grace=timing["lost_grace"],
                           recover=recover_ok, evidence=evidence, affected=[uid])
        if executor_down:
            return Finding(**base, condition="working", kind="executor-down", fact="executing while the executor is not reporting", evidence=evidence)
        if remote is not None and process.get("attempt") == a and remote.get("state") != "available":
            return Finding(**base, condition="working", kind="worker-down",
                           fact=f"executing on worker {remote.get('id')}, which has not reported since {remote.get('heartbeatAt')}; its attempt stays open", evidence=evidence)
        if (process.get("attempt") != a or process.get("alive") is None) and not (remote is not None and process.get("attempt") == a and process.get("log")):
            return Finding(**base, condition="uncertain", family="attempt", episode=a, kind="unobservable-process",
                           fact=f"attempt {a} is open; its process cannot be observed here", evidence=evidence)
        log = process.get("log") or {}
        tool = log.get("openTool") or None
        last_write = ts(log.get("last")) or ts(process.get("began")) or now
        group = process.get("group") or {}
        cpu = group.get("cpuSeconds")
        before = (prev_cpu or {}).get(a)
        cpu_note = f"; its processes used {cpu - before:.1f} s of CPU since the last look" if cpu is not None and before is not None else ""
        if tool and tool.get("timeoutSeconds") and tool.get("since"):
            started = ts(tool["since"]) or now
            bound = started + float(tool["timeoutSeconds"]) + timing["tool_grace"]
            if now <= bound:
                return Finding(**base, condition="working", kind="tool", fact=f"in {tool.get('name')} ({tool.get('summary')}) for {now - started:.0f} s of its {tool['timeoutSeconds']:.0f} s", evidence=evidence)
            # The harness ends a call at its timeout; one still open past it is not a wait.
            return Finding(**base, condition="uncertain", family="attempt", episode=a, kind="tool-overrun",
                           fact=f"attempt {a} is alive with an open {tool.get('name')} call ({tool.get('summary')}) {now - started:.0f} s old, past its {tool['timeoutSeconds']:.0f} s{cpu_note}",
                           since=bound, evidence=evidence)
        if now - last_write < timing["quiet_log"]:
            return Finding(**base, condition="working", kind="log", fact=f"its log moved {now - last_write:.0f} s ago", evidence=evidence)
        if cpu is not None and before is not None and cpu - before >= 0.5:
            return Finding(**base, condition="working", kind="cpu", fact=f"its processes used {cpu - before:.1f} s of CPU since the last look", evidence=evidence)
        what = f"an open {tool.get('name')} call ({tool.get('summary')}) that declares no timeout" if tool else "no open tool call"
        # Suspicious from the moment the silence crossed the bound, not from its start.
        return Finding(**base, condition="uncertain", family="attempt", episode=a, kind="silent",
                       fact=f"attempt {a} is alive, its log has not moved for {now - last_write:.0f} s, {what}, CPU not advancing",
                       since=last_write + timing["quiet_log"], evidence=evidence)
    if job:
        # improve_wfrun p4: what the job waits for is coordination's decision (awaiting), a deferral (its time or
        # event), or its node's next claim (admitted). A deferral past its time without a later decision is
        # a reconsideration that did not happen: told to the owners after its grace (WFE wakes coordination itself).
        admission = str(job.get("admission") or "")
        until = job.get("deferUntil")
        if admission == "deferred" and until and (ts(until) or now) < now:
            return Finding(**base, condition="uncertain", family="coordination", episode=f"defer:{job.get('decisionId')}", kind="reconsideration-overdue",
                           fact=f"job {job.get('id')} was deferred by coordination (decision {job.get('decisionId')}) until {until}, which passed without a later decision",
                           since=ts(until), grace=timing["coordination_grace"], recover=False, evidence=evidence)
        words = {"awaiting": "awaiting coordination's decision", "deferred": f"deferred by coordination{f' until {until}' if until else ''}", "admitted": "admitted; starts at its node's next claim", "claimed": "claimed"}.get(admission, job.get("state", ""))
        return Finding(**base, condition="queued", kind=QUEUED_KINDS.get(admission, job.get("kind", "job")), fact=f"{job.get('kind')} job {job.get('id')} {words}",
                       since=ts(job.get("created")), evidence=evidence)
    responsible = str(waiting.get("responsible") or "")
    if responsible.startswith("conversation:"):
        return Finding(**base, condition="idle-input", kind=str(execution.get("state")), fact=str(waiting.get("reason")), evidence=evidence)
    if responsible.startswith("delegation:") or responsible.startswith("delegation-unbound:"):
        return _delegation_wait(run, base, waiting, responsible, now, timing, evidence)
    if responsible.startswith("person:"):
        return Finding(**base, condition="awaiting-person", kind="question", fact=str(waiting.get("reason")), evidence=evidence)
    if responsible.startswith("external:"):
        overdue = [w for w in execution.get("waiting") or [] if w.get("deadline") and (ts(w["deadline"]) or now) < now]
        if overdue:
            w = overdue[0]
            return Finding(**base, condition="uncertain", family="wait", episode=f"{w['node']}@{w['deadline']}", kind="overdue-wait",
                           fact=f"{w['node']} waits on {w.get('on')} past its declared deadline {w['deadline']}", since=ts(w["deadline"]), evidence=evidence)
        return Finding(**base, condition="awaiting-external", kind="external", fact=str(waiting.get("reason")), evidence=evidence)
    if responsible == "executor":
        if remote is not None and remote.get("state") != "available":
            return Finding(**base, condition="queued", kind="worker-down", fact=f"waits for worker {remote.get('id')}, which is not reporting", evidence=evidence)
        if executor_down:
            return Finding(**base, condition="queued", kind="executor-down", fact="waits for the executor, which is not reporting", evidence=evidence)
        return Finding(**base, condition="unowned", family="continuation", episode=f"seq:{run.get('seq')}", kind="unowned",
                       fact=f"{waiting.get('reason')}: nothing will continue it", since=ts(waiting.get("since")),
                       grace=timing["unowned_grace"], recover=recover_ok, evidence=evidence)
    # A recorded failure (execution `stopped`) or anything else nobody is
    # named for: the run's own record is the person's to act on.
    failed = execution.get("failed") or []
    return Finding(**base, condition="awaiting-person", kind="failed" if failed else str(execution.get("state")),
                   fact=f"{', '.join(failed)} failed; a person decides" if failed else str(waiting.get("reason") or execution.get("state")),
                   evidence=evidence)


def _delegation_wait(run: dict, base: dict, waiting: dict, responsible: str, now: float, timing: dict[str, float], evidence: dict) -> Finding:
    """A delegate node waits on its child (workflow_editor p10). The child is a
    run of its own with its own finding: its failures, holds and recoveries
    are its incidents, never a second one here. What is this run's: a child
    fact the relay has not recorded on it (the continuation path is broken),
    and a dispatched request that never became a child (its delivery)."""
    uid = responsible.split(":", 1)[1]
    facts = next((d for d in run.get("delegations") or [] if (d.get("child") or {}).get("uid") == uid or d.get("childUid") == uid or d.get("uid") == uid), None) or {}
    stalled = [f for f in facts.get("unrelayed") or [] if f.get("wakes") and (ts(f.get("at")) or now) + timing["relay_grace"] < now]
    if stalled:
        f = stalled[0]
        return Finding(**base, condition="uncertain", family="delegation", episode=f"{facts.get('uid')}@{f.get('childSeq')}", kind="relay-stalled",
                       fact=f"the child {(facts.get('child') or {}).get('ref')} recorded {f.get('type')} at {f.get('at')}; it is not on this run's delegation {facts.get('id')} yet, so nothing resumes this run",
                       since=(ts(f.get("at")) or now) + timing["relay_grace"], evidence=evidence)
    if responsible.startswith("delegation-unbound:"):
        delivery = facts.get("delivery") or {}
        dispatched = ts(facts.get("dispatchedAt")) or now
        state = str(delivery.get("state") or "")
        error = f" ({delivery['error']})" if delivery.get("error") else ""
        if state.startswith(("failed", "unresolved")) or "may have been posted" in state or dispatched + timing["unbound_grace"] < now:
            return Finding(**base, condition="uncertain", family="delegation", episode=f"{facts.get('uid')}@unbound", kind="unbound-dispatch",
                           fact=f"delegation {facts.get('id')} to {facts.get('target')} was dispatched {facts.get('dispatchedAt')} and has no child: its request delivery is {state or 'unknown'}{error}",
                           since=max(dispatched + timing["unbound_grace"], ts(delivery.get("since")) or 0) if not state.startswith(("failed", "unresolved")) else ts(delivery.get("since")), evidence=evidence)
        return Finding(**base, condition="awaiting-delegation", kind="delivering", fact=f"delegation {facts.get('id')} to {facts.get('target')}: request {state or 'queued'}", evidence=evidence)
    child = facts.get("child") or {}
    if not child and facts.get("problem"):
        # The child cannot be read here: nothing is concluded about it, and a
        # healthy wait is not made a failure; persisting, it is told.
        return Finding(**base, condition="unobservable", family="observation", episode=f"{facts.get('uid')}@child", kind="child-unreadable",
                       fact=f"delegation {facts.get('id')}: {facts.get('problem')}", grace=timing["unobservable_report"], evidence=evidence)
    held = f", held {child.get('hold')} (its own finding)" if child.get("hold") else ""
    return Finding(**base, condition="awaiting-delegation", kind="child", fact=f"delegation {facts.get('id')}: child {child.get('ref')} is {child.get('situation')}{held}", evidence=evidence)


def classify(observation: dict, now: float, timing: dict[str, float] | None = None, prev_cpu: dict[str, float] | None = None,
             recovery_workflows: tuple[str, ...] = ()) -> tuple[list[Finding], Finding | None]:
    """Every run's finding, and the executor's own (None while it reports).
    The coordination path's own finding (improve_wfrun p4) is `coordination_finding`."""
    if observation.get("schema") != SCHEMA:
        raise ValueError(f"not an observation: schema {observation.get('schema')!r}")
    t = {**TIMING, **(timing or {})}
    ex = observation.get("executor") or {}
    age = ex.get("ageSeconds")
    down = ex.get("state") != "available" and (age is None or age > t["executor_stale"])
    # Remote workers (project_migration p7): a run they perform is judged by
    # their contact, not by the local executor's.
    workers = {w.get("id"): w for w in observation.get("workers") or [] if not w.get("local")}
    def remote_of(r: dict) -> dict | None:
        return workers.get(((r.get("executor") or {}).get("node")))
    findings = [classify_run(r, now, t, prev_cpu, down and remote_of(r) is None, recovery_workflows, remote_of(r)) for r in observation.get("runs") or []]
    executor = None
    if down:
        affected = [f.uid for f in findings if f.condition in ("working", "queued", "unowned", "lost-attempt", "uncertain")
                    or (f.evidence.get("waiting") or {}).get("responsible") in ("executor",)]
        # Every open attempt of the local worker (p4: several at once), not only the first.
        local = next((w for w in observation.get("workers") or [] if w.get("local")), None)
        for slot in [ex.get("slot") or {}, *((local or {}).get("slots") or [])]:
            if slot.get("uid") and slot["uid"] not in affected:
                affected.append(slot["uid"])
        executor = Finding(uid="executor", workspace="", ref="", condition="executor-down", family="executor",
                           episode=str(ex.get("heartbeatAt")), kind="executor-down",
                           fact=f"the executor's heartbeat is {age if age is not None else 'absent'} s old ({ex.get('detail')})",
                           since=ts(ex.get("heartbeatAt")), evidence={"executor": ex}, affected=affected)
    return findings, executor


def coordination_finding(observation: dict, findings: list[Finding], now: float, timing: dict[str, float] | None = None) -> Finding | None:
    """The coordination path's own finding (improve_wfrun p4, WFE
    docs/coordination.md): turns keep ending without a decision while work
    awaits one (WFE reports the stall and pauses automatic turns), or jobs
    await a decision for `coordination_stall` with no turn open or opening.
    One finding naming the affected runs, told to the owners; a wait coordination
    recorded is not an incident by itself."""
    t = {**TIMING, **(timing or {})}
    c = observation.get("coordination") or {}
    if not c.get("configured"):
        return None
    awaiting = [f.uid for f in findings if f.condition == "queued" and f.kind == "awaiting-decision"]
    stalled = c.get("stalled") or {}
    if stalled:
        return Finding(uid="coordination", workspace="", ref="", condition="coordination-stalled", family="coordination",
                       episode=f"stall:{stalled.get('since')}", kind="turns-without-decision",
                       fact=f"{stalled.get('failures')} coordination turns ended without a decision since {stalled.get('since')} (last: {stalled.get('last')}); automatic turns wait until {stalled.get('until')} while {len(awaiting)} job(s) await a decision",
                       since=ts(stalled.get("since")), grace=0.0, evidence={"coordination": c}, affected=awaiting)
    if awaiting and not c.get("turn"):
        oldest = min((ts((f.evidence.get("queue") or {}).get("created")) or now for f in findings if f.uid in awaiting), default=now)
        if now - oldest >= t["coordination_stall"]:
            return Finding(uid="coordination", workspace="", ref="", condition="coordination-stalled", family="coordination",
                           episode=f"idle:{int(oldest)}", kind="no-turn",
                           fact=f"{len(awaiting)} job(s) have awaited coordination's decision since {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(oldest))} and no coordination turn is open or opening",
                           since=oldest, grace=0.0, evidence={"coordination": c}, affected=awaiting)
    return None
