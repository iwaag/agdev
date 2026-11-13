"""The recovery path: an incident becomes a request to a recovery agent.

observer p3 step 4 (`docs/workflow.md`, *Recovery path*). For an open
incident of a recoverable family (`attempt`, `continuation`, `publication`,
`integration`) on a run that is not itself a recovery run:

1. **Journal, then send.** An assignment row (`n` ≤ `max_assignments`) and
   its outbox post are written together; the post goes out through
   `wfpost` (owed → sending → sent, looked for by its marker before any
   repeat). The post opens a `request-<incident>` topic in the recovery
   workflow's channel; WFE's intake turns it into a recovery run (input
   kind `request`, requester Observer) — the durable intake and wakeup path.
2. **Acknowledged** = a recovery run exists whose input is that post.
   **Performed** = the target run's history has `run.recover` naming the
   incident. **Restored** = a later observation shows the run's agent
   reporting work after the recovery (or the run completed). A sent post,
   a new PID or a promise is none of these.
3. **Bounds.** A second assignment only when the first was never taken up
   within `ack_timeout`, or its run ended without acting; after the last,
   the owners are told. A recovery run that ends without `run.recover` is a
   hand-off to a person (its report says why). While the executor is down
   nothing is assigned — a recovery run would need it.

Nothing here changes a run: the recovery agent decides and WFE validates.

cluster_teamwork p4: **submitted through WFE** (since p5 the only route).
Step 1 is: the assignment row is journaled with its receipt
`submission:<requester>:<incident>:<n>`, then submitted with `wfe submit`
(WFE's own durable, idempotent request intake — no post). **Acknowledged** =
the run WFE bound to that receipt (submitting again returns the same run; a
deliberate later assignment has the next `n`, a receipt of its own, and names
the earlier one). A WFE that cannot be reached leaves the submission pending
(retried each look, never a new run); if it stays pending past `ack_timeout`
the owners are told. Incident notes and owner messages (`wfpost`) are
notices, never the trigger or the acknowledgement. An assignment journaled
by the retired Zulip route (`route` unset) that is still open is closed as
`retired-route` and the next assignment is submitted through WFE.
"""

from __future__ import annotations

import json
import subprocess
import time
from typing import Any, Callable

from . import wfclassify as wc

#: The run agent's reports that show work after a recovery (a recorded failure is a hand-off to the person).
WORK_OPS = ("node.progress", "node.complete", "question.ask", "node.wait", "artifact.attach", "node.fail", "presentation.register")

#: The recovery workflow is configuration only (`[recovery] workflow`, rendered from the recovery role, summoner p2).
DEFAULTS = {"ack_timeout": 1800.0, "max_assignments": 2, "verify_timeout": 3600.0, "requester": "Observer"}


def request_text(inc, f: wc.Finding, n: int) -> str:
    ev = f.evidence or {}
    attempts = ev.get("attempts") or {}
    last = attempts.get("last") or {}
    log = ev.get("log") or {}
    proc = ev.get("process") or {}
    ws, ref = inc["workspace"], inc["ref"]
    lines = [
        f"Recovery request for incident `{inc['id']}`{f' (assignment {n})' if n > 1 else ''}.",
        "",
        f"**Run:** `{ref}` in workspace `{ws}` (uid `{inc['uid']}`).",
        f"**Observed:** {f.condition} — {f.fact}",
        f"**First suspected:** {time.strftime('%Y-%m-%d %H:%M:%S %Z', time.localtime(float(inc['first_suspected'])))}.",
        "",
        "Evidence (from `wfe observe`):",
        f"- hold: {json.dumps(ev.get('hold'), ensure_ascii=False)}",
        f"- the attempt that ended: `{last.get('id')}` — {last.get('outcome')}: {last.get('detail')}",
        f"- its process: alive={proc.get('alive')}, exit={proc.get('exit')}, signal={proc.get('signal')}",
        f"- its session log: last write {log.get('last')}, turns {log.get('turns')}, the harness ended the session: {json.dumps(log.get('ended'))}, background tasks stopped with it: {log.get('backgroundStopped')}",
        f"- the agent's last report: {json.dumps(ev.get('progress'), ensure_ascii=False)}",
        *session_lines(ev, ref, ws),
        f"- running nodes: {ev.get('active')}; ready: {ev.get('ready')}; earlier recoveries: {len(ev.get('recoveries') or [])}",
        *cause_lines(ev),
        *delegation_lines(ev),
        f"- unpublished checkpoints / integration: {json.dumps(ev.get('publication'))} / {json.dumps(ev.get('integration'))}",
        "",
        "**To resolve:** can this run's work continue safely from where its record stands? Look before deciding:",
        f"the run's record and history (`wfe run show {ref} --workspace {ws} --history`), its attempts, process and log "
        f"(`wfe exec status {ref} --workspace {ws}`), its own working copy and what is uncommitted there (`wfe runs index --workspace {ws}`), "
        "and any effect outside Git the attempt may have caused. Git history cannot prove that an external operation did not happen.",
        "",
        "Then do one of:",
        f"- continue it: `wfe run recover {ref} --workspace {ws} --incident {inc['id']} --attempt {(f.episode if inc['family'] == 'attempt' else last.get('id')) or 'none'} --reason \"<what you checked>\"` (see `wfe run help recover`);",
        "- repair what stops it (a failed publication: `wfe exec publish <checkpoint>`; an executor problem: say so) and say what you did;",
        "- or leave it to a person: say in your report what they must decide (a scope change, an external effect that may have happened).",
        "",
        "You never resume a person's hold, accept a result, answer a question for the person, or change the run's plan.",
    ]
    return "\n".join(lines)


def cause_lines(ev: dict) -> list[str]:
    """The hold's structured cause and the run's recent ends (project_migration p8 ex1)."""
    hold = ev.get("hold") or {}
    out = []
    short = wc.cause_text(hold.get("cause"))
    if short:
        out.append(f"- why it is held, in short: {short} (cause `{json.dumps(hold.get('cause'), ensure_ascii=False)}`)")
    ends = (ev.get("attempts") or {}).get("ends") or []
    if len(ends) > 1:
        out.append("- recent attempt ends: " + "; ".join(f"`{e.get('attempt')}` {e.get('outcome')}{_cause_suffix(e)}{', recovered' if e.get('recovered') else ''}" for e in ends))
    return out


def delegation_lines(ev: dict) -> list[str]:
    """The parent's delegations by identity: each child, where it stands,
    the facts not taken up and those not relayed (project_migration p8 ex1)."""
    out = []
    for d in ev.get("delegations") or []:
        child = d.get("child") or {}
        pending = ", ".join(f"{p.get('type')} #{p.get('n')}" for p in d.get("pending") or []) or "none"
        unrelayed = ", ".join(f"{u.get('type')} (child seq {u.get('childSeq')})" for u in d.get("unrelayed") or []) or "none"
        who = f"child `{child.get('uid')}` ({child.get('workspace')} {child.get('ref')}): {child.get('situation')}{', held ' + str(child.get('hold')) if child.get('hold') else ''}" if child else f"no child yet ({d.get('problem') or 'request delivery: ' + str((d.get('delivery') or {}).get('state'))})"
        out.append(f"- delegation `{d.get('uid')}` (node {d.get('node')} → {d.get('target')}, {d.get('state')}): {who}; not taken up: {pending}; not yet relayed: {unrelayed}")
    if out:
        out.append("- a child is a run of its own: its interruptions are its incidents; never dispatch a replacement child or repeat its work from here")
    return out


def session_lines(ev: dict, ref: str, ws: str) -> list[str]:
    """The run's session facts for the recovery agent (agent_session p1).
    Under `run` a continued run resumes its retained conversation with your
    finding in its brief; when that conversation should not be carried on,
    it can be retired first."""
    ses = ev.get("session") or {}
    if not ses:
        return []
    cur = ses.get("current") or {}
    attempt_session = (ev.get("process") or {}).get("session") or {}
    out = [f"- session policy `{ses.get('policy')}`; the ended attempt ran in session `{attempt_session.get('id')}`"
           f" ({'resumed' if attempt_session.get('resumed') else 'new'}); the run's current session: `{cur.get('id')}` over {len(cur.get('attempts') or [])} attempt(s)"]
    if ses.get("policy") == "run" and cur.get("mismatch"):
        # agent_session p1 ex1: the harness reported another conversation than
        # the one the attempt was launched in; the host stopped the attempt.
        out.append(f"- that session is UNVERIFIED: the harness reported `{cur.get('attached')}` instead of `{cur.get('id')}`, so the execution host stopped the attempt. "
                   f"Continuing is refused until it is retired; look at the run and what that attempt did first, then "
                   f"`wfe run session {ref} --workspace {ws} --retire --reason \"<what you found>\" --by <you>` — the next attempt starts a new session from the records")
    elif ses.get("policy") == "run":
        out.append(f"- continuing resumes that conversation (unless its configuration changed or it is missing on the host); "
                   f"if it should not be carried on (a resume keeps failing, or it holds a wrong belief), retire it first: "
                   f"`wfe run session {ref} --workspace {ws} --retire --reason \"<why>\" --by <you>` — the next attempt then starts a new session from the records")
    return out


class Recoverer:
    def __init__(self, cfg: dict[str, Any], log: Callable[[str], None] = print):
        self.cfg = {**DEFAULTS, **(cfg or {})}
        self.log = log

    @property
    def workflow(self) -> str:
        return str(self.cfg["workflow"])

    # ---- WFE submission (cluster_teamwork p4) ----------------------------------------------

    def receipt_of(self, iid: str, n: int) -> tuple[str, str]:
        key = f"{iid}:{n}"
        return key, f"submission:{self.cfg['requester']}:{key}"

    def _submitted_run(self, doc: dict, a) -> dict | None:
        """The run WFE bound to the assignment's receipt (by uid, else by its input's source)."""
        if a["run"]:
            rr = self._recovery_run_by_uid(doc, a["run"])
            if rr is not None:
                return rr
        for r in doc.get("runs") or []:
            src = ((r.get("input") or {}).get("source") or {})
            if src.get("kind") == "submission" and src.get("receipt") == a["receipt"]:
                return r
        return None

    def submit(self, m, a, inc, f: wc.Finding, now: float) -> bool:
        """Submit (or submit again) one assignment; the same receipt is the same run."""
        iid, n = inc["id"], int(a["n"])
        key, receipt = self.receipt_of(iid, n)
        about = f"incident {iid} assignment {n}" + (f" (after {self.receipt_of(iid, n - 1)[1]})" if n > 1 else "")
        argv = [*m.s.wfe, "submit", "--json", "--requester", str(self.cfg["requester"]), "--workflow", self.workflow, "--key", key, "--text-file", "-", "--about", about,
                *(["--workspace", str(self.cfg["workspace"])] if self.cfg.get("workspace") else [])]
        try:
            proc = subprocess.run(argv, input=request_text(inc, f, n), capture_output=True, text=True, timeout=180)
            out = json.loads(proc.stdout or "{}") if proc.stdout.strip().startswith("{") else {}
            error = None if proc.returncode == 0 and out.get("ok") else (out.get("error") or proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")[:400]
        except Exception as e:  # noqa: BLE001 - a WFE that cannot be reached leaves it pending
            out, error = {}, f"wfe submit could not run: {e}"[:400]
        if error is None:
            m.store.db.execute("UPDATE assignments SET submitted = ?, run = ?, submit_error = NULL, acknowledged = coalesce(acknowledged, ?), acknowledged_by = coalesce(acknowledged_by, ?), state = CASE WHEN state = 'requested' THEN 'acknowledged' ELSE state END WHERE id = ?",
                               (now, out.get("uid"), now, out.get("uid"), a["id"]))
            m.store.event(iid, "submitted", {"n": n, "receipt": receipt, "run": out.get("uid"), "workflow": out.get("workflow"), "ref": out.get("run"), "duplicate": bool(out.get("duplicate"))})
            if a["acknowledged"] is None:
                m.store.event(iid, "acknowledged", {"n": n, "run": out.get("uid"), "receipt": receipt})
                m.store.update(iid, state="recovering")
                m.note(iid, f"WFE bound recovery assignment {n} to `{out.get('workflow')}/{out.get('run')}` (receipt `{receipt}`).", f"ack-{n}")
            self.log(f"incident {iid}: assignment {n} submitted ({receipt} -> {out.get('uid')}{', known' if out.get('duplicate') else ''})")
            return True
        if error != a["submit_error"]:
            m.store.db.execute("UPDATE assignments SET submit_error = ? WHERE id = ?", (error, a["id"]))
            m.store.event(iid, "submit-failed", {"n": n, "receipt": receipt, "error": error})
            self.log(f"incident {iid}: assignment {n} not submitted yet ({error}); retried next look")
        return False

    def assign(self, m, inc, f: wc.Finding, n: int, now: float) -> None:
        iid = inc["id"]
        key, receipt = self.receipt_of(iid, n)
        with m.store.tx():
            if m.store.db.execute("SELECT 1 FROM assignments WHERE incident = ? AND n = ?", (iid, n)).fetchone():
                return
            m.store.db.execute("INSERT INTO assignments (incident, n, recipient, journaled, outbox, state, route, receipt) VALUES (?, ?, ?, ?, NULL, 'requested', 'wfe', ?)",
                               (iid, n, self.workflow, now, receipt))
            m.store.event(iid, "assigned", {"n": n, "recipient": self.workflow, "route": "wfe", "receipt": receipt})
        m.store.update(iid, state="assigned")
        m.note(iid, f"Asked a recovery agent ({self.workflow}, assignment {n}) through WFE: receipt `{receipt}`.", f"assigned-{n}")
        self.log(f"incident {iid}: recovery assignment {n} journaled ({receipt})")
        row = m.store.db.execute("SELECT * FROM assignments WHERE incident = ? AND n = ?", (iid, n)).fetchone()
        self.submit(m, row, inc, f, now)

    def step(self, m, doc: dict, by_uid: dict[str, wc.Finding], executor: wc.Finding | None, now: float) -> None:
        for inc in m.store.open_incidents():
            if not inc["recover"] or inc["state"] == "escalated":
                continue
            f = by_uid.get(inc["uid"])
            if f is None or f.key != inc["id"]:
                continue  # verification decides
            if executor is not None:
                continue  # a recovery run would need the executor; its incident is told to the owners
            if f.condition == "lost-attempt":
                continue  # the record still has the attempt open: the executor ends it first (then interrupted/unknown)
            rows = m.store.assignments(inc["id"])
            if not rows:
                self.assign(m, inc, f, 1, now)
                continue
            a = rows[-1]
            if a["closed"] is not None:
                continue
            if a["route"] != "wfe":
                # Journaled by the retired Zulip route: nothing reads that post any more.
                self.next_or_escalate(m, inc, f, a, now, "its request was a Zulip post, a route retired in cluster_teamwork p5", "retired-route")
                continue
            self.step_submitted(m, doc, inc, f, a, now)

    def step_submitted(self, m, doc: dict, inc, f: wc.Finding, a, now: float) -> None:
        """An assignment submitted through WFE: pending until WFE binds it; then as any taken-up assignment."""
        if a["submitted"] is None:
            if self.submit(m, a, inc, f, now):
                return
            if now - float(a["journaled"]) > float(self.cfg["ack_timeout"]) and not inc["escalated"]:
                # WFE did not take the submission for that long: no new run is made; the owners are told.
                m.escalate(inc, f, now, why=f"the recovery request could not be submitted to WFE for {self.cfg['ack_timeout']:.0f} s ({a['submit_error']})")
            return
        rr = self._submitted_run(doc, a)
        if rr is not None and _finished(rr):
            self.next_or_escalate(m, inc, f, a, now, f"the recovery run {rr['identity']['workflow']}/{rr['identity']['run']} ended ({rr.get('situation')}) without continuing the run", "no-action", handoff=rr)
        elif now - float(a["acknowledged"] or a["submitted"]) > float(self.cfg["verify_timeout"]):
            self.next_or_escalate(m, inc, f, a, now, f"the recovery run took it up {self.cfg['verify_timeout']:.0f} s ago and has not acted", "stuck")

    def _recovery_run_by_uid(self, doc: dict, uid: str | None) -> dict | None:
        return next((r for r in doc.get("runs") or [] if r["identity"].get("uid") == uid), None) if uid else None

    def next_or_escalate(self, m, inc, f: wc.Finding, a, now: float, why: str, outcome: str, handoff: dict | None = None) -> None:
        m.store.db.execute("UPDATE assignments SET closed = ?, outcome = ?, note = ? WHERE id = ?", (now, outcome, why, a["id"]))
        m.store.event(inc["id"], "assignment-closed", {"n": a["n"], "outcome": outcome, "why": why})
        if handoff is not None:
            # The agent looked and decided not to continue: the person decides (its report says why).
            m.close(inc, "handed-off", {"why": f"{why}; see its report", "recovery_run": handoff["identity"]["uid"]}, now)
            m.tell_owners(inc["id"], f"Observer: incident `{inc['id']}` ({inc['workspace']} {inc['ref']}): {why}. The run stays held; its report says what a person must decide.", "handed-off")
            return
        if int(a["n"]) < int(self.cfg["max_assignments"]):
            self.assign(m, inc, f, int(a["n"]) + 1, now)
            return
        m.escalate(inc, f, now, why=f"{a['n']} recovery assignment(s): {why}")

    def verify(self, m, inc, f: wc.Finding, run: dict, now: float):
        """The outcome once the incident's condition is gone; False while still
        verifying a recovery; None when no recovery of ours is involved."""
        rows = m.store.assignments(inc["id"])
        ours = [r for r in run.get("recoveries") or [] if r.get("incident") == inc["id"]]
        if not ours:
            return None
        rc = ours[-1]
        # The recovery run may have come and gone between two looks: its
        # acknowledgement is recorded from the same observation.
        for a in rows:
            if a["acknowledged"] is None and a["route"] == "wfe":
                rr = self._submitted_run(m.last_doc, a)
                agent = rc.get("agent") or {}
                if rr is None and agent:
                    rr = next((r for r in (m.last_doc.get("runs") or []) if r["identity"]["workspace"] == agent.get("workspace") and r["identity"]["workflow"] == agent.get("workflow") and r["identity"]["run"] == agent.get("run")), None)
                if rr is not None:
                    m.store.db.execute("UPDATE assignments SET acknowledged = ?, acknowledged_by = ? WHERE id = ?", (now, rr["identity"]["uid"], a["id"]))
                    m.store.event(inc["id"], "acknowledged", {"n": a["n"], "run": rr["identity"]["uid"], "late": True})
        for a in rows:
            if a["performed_seq"] is None and a["closed"] is None:
                agent = rc.get("agent") or {}
                m.store.db.execute("UPDATE assignments SET performed_seq = ?, actor = ?, state = 'performed' WHERE id = ?",
                                   (rc["seq"], json.dumps({"by": rc.get("by"), **agent}), a["id"]))
                m.store.event(inc["id"], "performed", {"n": a["n"], "seq": rc["seq"], "by": rc.get("by"), "agent": agent})
        if inc["state"] != "verifying":
            m.store.update(inc["id"], state="verifying")
        progress = run.get("progress") or {}
        evidence = {"recovery_seq": rc["seq"], "recovered_by": rc.get("by"), "progress": progress, "seq": run.get("seq"), "situation": run.get("situation")}
        if run.get("cancelled"):
            return "cancelled", {**evidence, "why": "the run was cancelled after the recovery"}
        if f.condition == "respected-hold":
            return "held", {**evidence, "why": "a person holds the run"}
        # Useful work, not a start: a start alone is the agent beginning, which an attempt that dies at once also does.
        if progress.get("seq") and progress["seq"] > rc["seq"] and progress.get("attempt") and progress["attempt"] != inc["episode"] and progress.get("op") in WORK_OPS:
            self._close_assignments(m, inc, now, "restored")
            return "restored", {**evidence, "why": f"the run's agent reported {progress.get('op')} (seq {progress['seq']}) in attempt {progress['attempt']} after the recovery (seq {rc['seq']})"}
        if f.condition == "terminal" and f.kind == "completed":
            self._close_assignments(m, inc, now, "restored")
            return "restored", {**evidence, "why": "the run completed after the recovery"}
        if f.condition == "interrupted" and f.episode != inc["episode"]:
            self._close_assignments(m, inc, now, "interrupted-again")
            return "interrupted-again", {**evidence, "why": f"the continuation (attempt {f.episode}) was interrupted too; that is a new incident"}
        if now - float(rc_time(rc) or now) > float(self.cfg["verify_timeout"]) and not inc["escalated"]:
            m.escalate(inc, f, now, why=f"recovered at seq {rc['seq']}, but no work was reported in {self.cfg['verify_timeout']:.0f} s")
        return False

    def _close_assignments(self, m, inc, now: float, outcome: str) -> None:
        m.store.db.execute("UPDATE assignments SET closed = ?, outcome = ? WHERE incident = ? AND closed IS NULL", (now, outcome, inc["id"]))


def rc_time(rc: dict) -> float | None:
    return wc.ts(rc.get("at"))


def _finished(run: dict) -> bool:
    ex = run.get("execution") or {}
    return bool(run.get("cancelled")) or ex.get("state") in ("completed", "stopped") or (run.get("hold") or {}).get("kind") == "stopped"


def _cause_suffix(end: dict) -> str:
    short = wc.cause_text(end.get("cause"))
    return f" ({short})" if short else ""
