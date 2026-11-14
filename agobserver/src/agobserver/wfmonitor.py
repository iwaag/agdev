"""Observer over workflow runs: discover, classify, open incidents, verify.

observer p3 (`docs/workflow.md`). Every look:

1. **Observe.** `wfe observe --json` (WFE's read-only observation), plus the
   runs of open incidents by name, so a run that settled is still verified.
   A failed or unreadable observation concludes nothing about any run.
2. **Classify** (`wfclassify`): mechanical facts in code. Respected holds,
   questions to a person, external waits, live work and legitimate queue
   waits need nobody.
3. **Suspect, then open.** A suspicion keeps its first sight across looks
   and restarts; after its grace it is an incident, one per
   `(run uid, family, episode)`. A re-description updates it; it never opens
   a second one or replenishes a budget.
4. **Judge** only an alive, silent attempt the facts cannot decide — on a
   worker thread, with the evidence digest it read; a verdict on evidence
   that has since moved is discarded.
5. **Recover or escalate.** Recoverable families go to the recovery path
   (`wfrecover`, step 4) when configured; executor outages, stalled queues,
   overdue waits, unreadable sources and judged stalls go to the realm's
   owners by direct message.
6. **Verify.** An incident closes only on a later observation: the run
   completed, cancelled, held by a person, handed to a person, moving again
   — and `restored` only when the run's agent reported work after the
   recovery. Absence from the observation is never a rescue.
7. **Health.** `workflow-health.json` at every look, read by the watchdog in
   another process.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import wfclassify as wc
from .wfpost import Poster, outbox_summary
from .wfstore import OPEN_STATES, Store

HEALTH_FILE = "workflow-health.json"
HEALTH_SCHEMA = "agobserver.workflow-health.v1"
JUDGMENT_TIMEOUT = 150.0


@dataclass
class Settings:
    wfe: list[str]
    channel: str = "observer"  # the name incident notes are kept under (in the store)
    interval: float = 60.0
    enabled: bool = True
    timing: dict[str, float] = field(default_factory=dict)
    recovery: dict[str, Any] = field(default_factory=dict)
    judge: bool = True
    roles: str | None = None  # <area>/roles.json: when present, the recovery role there is [recovery] (summoner p5)

    @staticmethod
    def load(path: Path) -> "Settings":
        data = tomllib.loads(path.read_text()) if path.exists() else {}
        wfe = data.get("wfe")
        if not wfe:
            raise SystemExit(f"{path} needs `wfe = [...]`: the argv of the wfe launcher")
        return Settings(wfe=list(wfe) if isinstance(wfe, list) else [str(wfe)], channel=str(data.get("channel") or "observer"),
                        interval=float(data.get("interval_seconds") or 60), enabled=bool(data.get("enabled", True)),
                        timing={k: float(v) for k, v in (data.get("timing") or {}).items()}, recovery=dict(data.get("recovery") or {}),
                        judge=bool(data.get("judge", True)), roles=str(data["roles"]) if data.get("roles") else None)

    @property
    def recovery_workflows(self) -> tuple[str, ...]:
        """The workflows never sent to recovery: the recovery workflow itself and
        `[recovery] exempt` (improve_wfrun p4: the coordination workflow, whose
        failure is told to the owners and retried by WFE's own path)."""
        wf = self.recovery.get("workflow")
        exempt = [str(x) for x in (self.recovery.get("exempt") or [])]
        return ((str(wf),) if wf else ()) + tuple(exempt)


def recovery_from_roles(doc: dict, base: dict[str, Any]) -> dict[str, Any]:
    """[recovery] from an `ag.roles.v1` document (workflow_editor docs/summon.md): the recovery role's
    workflow and workspace, the coordination role's workflow exempt; off when the role is not filled.
    Other keys of `base` (timeouts, requester) are kept."""
    keep = {k: v for k, v in (base or {}).items() if k not in ("enabled", "workflow", "workspace", "exempt")}
    roles = doc.get("roles") or {}
    r, c = roles.get("recovery"), roles.get("coordination")
    if not r or not r.get("workflow"):
        return {**keep, "enabled": False}
    return {**keep, "enabled": True, "workflow": f'{r["project"]}/{r["workflow"]}', "workspace": r.get("workspace") or r["project"],
            "exempt": [f'{c["project"]}/{c["workflow"]}'] if c and c.get("workflow") else []}


def make_recoverer(cfg: dict[str, Any], log: Callable[[str], None]) -> Any:
    if cfg.get("enabled") and cfg.get("workflow"):
        from .wfrecover import Recoverer

        log(f"recovery: incidents go to {cfg['workflow']} (the recovery role)")
        return Recoverer(cfg, log=log)
    log("recovery: the recovery role is not filled here; recoverable incidents are told to the owners")
    return None


def wfe_observe(cmd: list[str], runs: list[str] | None = None, timeout: float = 90.0, workspace: str | None = None) -> tuple[dict | None, str | None]:
    """The observation, or why there is none. Never raises. With `workspace`,
    every run of that workspace, settled ones included (`--terminal`)."""
    argv = [*cmd, "observe", "--json", *[a for r in runs or [] for a in ("--run", r)], *(["--workspace", workspace, "--terminal"] if workspace else [])]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except Exception as error:  # noqa: BLE001
        return None, f"wfe observe could not run: {error}"
    if proc.returncode != 0:
        return None, f"wfe observe exited {proc.returncode}: {(proc.stderr or proc.stdout).strip()[:400]}"
    try:
        doc = json.loads(proc.stdout)
    except json.JSONDecodeError as error:
        return None, f"wfe observe printed no JSON: {error}"
    if doc.get("schema") != wc.SCHEMA:
        return None, f"wfe observe answered schema {doc.get('schema')!r}, not {wc.SCHEMA}"
    return doc, None


def digest(evidence: dict[str, Any]) -> str:
    """What a judgment read: it stands only while these facts stand."""
    log = evidence.get("log") or {}
    proc = evidence.get("process") or {}
    cpu = ((proc.get("group") or {}).get("cpuSeconds"))
    keep = {"attempt": proc.get("attempt"), "alive": proc.get("alive"), "log_last": log.get("last"), "tool": log.get("openTool"),
            "ended": log.get("ended"), "cpu": round(cpu) if isinstance(cpu, (int, float)) else None,
            "progress": (evidence.get("progress") or {}).get("seq"), "hold": evidence.get("hold"), "seq": evidence.get("seq")}
    return hashlib.sha256(json.dumps(keep, sort_keys=True, default=str).encode()).hexdigest()[:16]


class Judge:
    """A worker thread for local-model judgments: one at a time, results by queue."""

    def __init__(self, judge_fn: Callable[[str, str, dict, dict], dict], log: Callable[[str], None] = print):
        self.judge_fn = judge_fn
        self.log = log
        self.todo: queue.Queue = queue.Queue()
        self.done: queue.Queue = queue.Queue()
        self.running: dict[str, Any] | None = None
        self.thread = threading.Thread(target=self._run, daemon=True, name="wftriage")
        self.thread.start()

    def submit(self, job_id: int, incident: str, fact: str, evidence: dict, seconds: dict) -> None:
        self.todo.put((job_id, incident, fact, evidence, seconds))

    def _run(self) -> None:
        while True:
            job_id, incident, fact, evidence, seconds = self.todo.get()
            self.running = {"id": job_id, "incident": incident, "since": time.time()}
            try:
                result = self.judge_fn(incident, fact, evidence, seconds)
            except Exception as error:  # noqa: BLE001 - a failed judgment is an answer
                result = {"verdict": "unclear", "evidence": f"the judgment failed: {error}"}
            self.running = None
            self.done.put((job_id, result))

    def results(self) -> list[tuple[int, dict]]:
        out = []
        while True:
            try:
                out.append(self.done.get_nowait())
            except queue.Empty:
                return out


class WorkflowMonitor:
    def __init__(self, settings: Settings, store: Store, poster: Poster | None, *,
                 observe: Callable[[list[str] | None], tuple[dict | None, str | None]] | None = None,
                 judge: Judge | None = None, recoverer: Any = None, health_path: Path | None = None,
                 clock: Callable[[], float] = time.time, log: Callable[[str], None] = print):
        self.s = settings
        self.store = store
        self.poster = poster
        self.observe = observe or (lambda runs=None, workspace=None: wfe_observe(settings.wfe, runs, workspace=workspace))
        self.judge = judge
        self.recoverer = recoverer
        self.health_path = health_path
        self.clock = clock
        self.log = log
        self.timing = {**wc.TIMING, **settings.timing}
        self.cycle = {"count": 0, "started_at": None, "completed_at": None, "in_progress": False, "duration_seconds": None}
        self.source = {"state": "unknown", "last_ok_at": None, "failed_since": None, "reason": None, "release": None}
        self.latest_failure: dict[str, Any] | None = None
        self.last_findings: dict[str, wc.Finding] = {}
        self.last_doc: dict = {}
        self.spent = {"judgments": 0, "posts": 0}
        self.roles_seen: tuple | None = None

    # ---- posting --------------------------------------------------------------------

    def note(self, iid: str, text: str, tag: str) -> None:
        """A line in the incident's own topic in Observer's channel."""
        self.store.enqueue(kind="channel", channel=self.s.channel, topic=f"incident-{iid}", text=text, marker=f"obs {iid} {tag}", incident=iid, now=self.clock())

    def tell_owners(self, iid: str, text: str, tag: str) -> None:
        self.store.enqueue(kind="dm", text=text, marker=f"obs {iid} {tag}", incident=iid, now=self.clock())

    # ---- one look -------------------------------------------------------------------

    def look(self) -> dict[str, Any]:
        now = self.clock()
        self.cycle.update(started_at=now, in_progress=True)
        self.write_health(now)
        summary: dict[str, Any] = {}
        try:
            summary = self._look(now)
        except Exception as error:  # noqa: BLE001 - the loop outlives a look; the health record says so
            self.latest_failure = {"at": now, "error": repr(error)[:500]}
            self.log(f"look failed: {error!r}")
            summary = {"error": repr(error)}
        finally:
            done = self.clock()
            self.cycle.update(count=self.cycle["count"] + 1, completed_at=done, in_progress=False, duration_seconds=round(done - now, 3))
            self.write_health(done)
        return summary

    def follow_roles(self) -> None:
        """The recovery role as `roles.json` has it now: a summon apply that changes the holder takes
        effect at the next look, without a restart (summoner p5). Without the file, [recovery] stands."""
        if not self.s.roles:
            return
        path = Path(self.s.roles)
        try:
            st = path.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            return
        if key == self.roles_seen:
            return
        try:
            doc = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            self.log(f"roles not read ({path}): {error}")
            return
        self.roles_seen = key
        cfg = recovery_from_roles(doc, self.s.recovery)
        if cfg == self.s.recovery and (self.recoverer is not None) == bool(cfg.get("enabled") and cfg.get("workflow")):
            return
        self.log(f"roles.json (plan {doc.get('plan')}): the recovery role is {cfg.get('workflow') or 'not filled'}")
        self.s.recovery = cfg
        self.recoverer = make_recoverer(cfg, self.log)

    def _look(self, now: float) -> dict[str, Any]:
        self.follow_roles()
        doc, error = self.observe(None)
        if doc is None:
            if self.source["state"] != "failed":
                self.source["failed_since"] = now
            self.source.update(state="failed", reason=error)
            self.log(f"observation failed: {error}")
            self.flush(now)
            return {"observation": "failed", "reason": error}
        # The runs of open incidents are verified even when settled.
        seen = {(r["identity"]["workspace"], f"{r['identity']['workflow']}/{r['identity']['run']}") for r in doc.get("runs") or []}
        wanted = sorted({f"{i['workspace']}:{i['ref']}" for i in self.store.open_incidents() if i["workspace"] and (i["workspace"], i["ref"]) not in seen})
        if wanted:
            extra, err = self.observe(wanted)
            if extra:
                doc["runs"] = (doc.get("runs") or []) + [r for r in extra.get("runs") or []
                                                         if (r["identity"]["workspace"], f"{r['identity']['workflow']}/{r['identity']['run']}") not in seen]
            elif err:
                self.log(f"observing tracked runs failed: {err}")
        # Recovery runs end quickly and are then settled: while assignments are
        # open, the recovery workspace is observed whole so their runs are seen.
        rws = (self.s.recovery or {}).get("workspace")
        if self.recoverer is not None and rws and self.store.open_assignments():
            extra, err = self.observe(None, workspace=str(rws))
            if extra:
                have = {(r["identity"]["workspace"], f"{r['identity']['workflow']}/{r['identity']['run']}") for r in doc.get("runs") or []}
                doc["runs"] = (doc.get("runs") or []) + [r for r in extra.get("runs") or [] if (r["identity"]["workspace"], f"{r['identity']['workflow']}/{r['identity']['run']}") not in have]
            elif err:
                self.log(f"observing the recovery workspace failed: {err}")
        self.source.update(state="live", last_ok_at=now, failed_since=None, reason=None, release=doc.get("release"))
        self.last_doc = doc
        findings, executor = wc.classify(doc, now, self.timing, self.store.cpu_samples(), self.s.recovery_workflows)
        # improve_wfrun p4: the coordination path's own finding, beside the executor's.
        coordination = wc.coordination_finding(doc, findings, now, self.timing)
        for r in doc.get("runs") or []:
            p = r.get("process") or {}
            if p.get("attempt") and (p.get("group") or {}).get("cpuSeconds") is not None:
                self.store.sample(p["attempt"], float(p["group"]["cpuSeconds"]), now)
        if executor is not None:
            findings = [self._defer(f) for f in findings]
        by_uid = {f.uid: f for f in findings}
        self.last_findings = by_uid
        suspicious = [f for f in findings + ([executor] if executor else []) + ([coordination] if coordination else []) if f.key]
        for f in suspicious:
            self.suspect(f, now)
        self.store.forget_suspects({f.key for f in suspicious if f.key})
        for inc in self.store.open_incidents():
            self.verify(inc, by_uid, executor, doc, now)
        self.collect_judgments(now)
        if self.recoverer is not None:
            self.recoverer.step(self, doc, by_uid, executor, now)
        self.flush(now)
        conditions: dict[str, int] = {}
        for f in findings:
            conditions[f.condition] = conditions.get(f.condition, 0) + 1
        return {"runs": len(findings), "conditions": conditions, "executor": executor.condition if executor else "available"}

    def _defer(self, f: wc.Finding) -> wc.Finding:
        """While the executor is down, what follows from it is one incident, not many."""
        if f.condition in ("lost-attempt", "unowned"):
            return wc.Finding(uid=f.uid, workspace=f.workspace, ref=f.ref, condition="executor-blocked", kind=f.kind, fact=f.fact, evidence=f.evidence)
        return f

    def flush(self, now: float) -> None:
        if self.poster is None:
            return
        try:
            done = self.poster.flush(max(now, self.clock()))  # what this look enqueued goes out in this look
            self.spent["posts"] += done.get("sent", 0)
        except Exception as error:  # noqa: BLE001 - delivery failure never stops observation
            self.log(f"posting failed: {error!r}")

    # ---- suspicions and incidents -----------------------------------------------------

    def suspect(self, f: wc.Finding, now: float) -> None:
        iid = f.key
        inc = self.store.incident(iid)
        if inc is not None:
            if inc["state"] == "closed":
                if inc["outcome"] in ("resumed", "false-alarm") and f.family in ("attempt", "wait", "observation"):
                    # The same episode stopped again after it proved alive: a new suspicion of it.
                    self.store.update(iid, state="open", outcome=None, outcome_at=None, outcome_evidence=None, first_suspected=now, detected=now,
                                      escalated=None, postponed=0, kind=f.kind, condition=f.condition, fact=f.fact, evidence=f.evidence, next_review=None)
                    self.store.event(iid, "reopened", {"condition": f.condition, "fact": f.fact})
                return
            if (inc["kind"], inc["condition"], inc["fact"]) != (f.kind, f.condition, f.fact):
                self.store.update(iid, kind=f.kind, condition=f.condition, fact=f.fact, evidence=f.evidence, affected=f.affected)
                self.store.event(iid, "redescribed", {"condition": f.condition, "kind": f.kind, "fact": f.fact})
            if f.recover and not inc["recover"]:
                # The same episode became recoverable (an uncertain attempt is now
                # a confirmed loss): the recovery path takes it, even after the owners were told.
                self.store.update(iid, recover=1, state="open" if inc["state"] == "escalated" else inc["state"])
                self.store.event(iid, "recoverable", {"condition": f.condition})
            self.progress(self.store.incident(iid), f, now)
            return
        first = self.store.suspect(iid, f.uid, f.family, f.episode, f.condition, now)
        began = min(first, f.since) if f.since else first
        if now - began < f.grace:
            return
        with self.store.tx():
            if self.store.incident(iid):
                return
            self.store.db.execute(
                "INSERT INTO incidents (id, uid, workspace, ref, family, episode, kind, condition, state, first_suspected, detected, updated, fact, evidence, affected, recover) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
                (iid, f.uid, f.workspace, f.ref, f.family, f.episode, f.kind, f.condition, began, now, now, f.fact,
                 json.dumps(f.evidence, ensure_ascii=False, default=str), json.dumps(f.affected), int(f.recover)))
            self.store.event(iid, "opened", {"condition": f.condition, "kind": f.kind, "fact": f.fact, "first_suspected": began})
        self.log(f"incident {iid} opened: {f.ref or f.uid} {f.condition} — {f.fact}")
        where = f"{f.workspace} {f.ref}" if f.ref else "the executor"
        self.note(iid, f"**{f.condition}** — {where} (`{f.uid}`)\n\n{f.fact}\n\nFirst suspected {_clock(began)}; opened {_clock(now)}."
                  + (f"\n\nAffected runs: {', '.join(f.affected)}" if f.affected else ""), "opened")
        self.progress(self.store.incident(iid), f, now)

    def progress(self, inc, f: wc.Finding, now: float) -> None:
        """What an open incident needs now: a judgment, the owners, or the recovery path."""
        iid = inc["id"]
        if inc["state"] not in ("open", "escalated"):
            return
        age = now - float(inc["first_suspected"])
        if f.family == "attempt" and f.condition == "uncertain":
            if inc["escalated"]:
                return
            if age >= self.timing["judge_after"] and self.judge is not None and self.s.judge:
                self.request_judgment(inc, f, now)
            j = self.store.db.execute("SELECT * FROM judgments WHERE incident = ? AND finished IS NOT NULL AND invalidated = 0 ORDER BY id DESC LIMIT 1", (iid,)).fetchone()
            pending = self.store.db.execute("SELECT * FROM judgments WHERE incident = ? AND finished IS NULL AND invalidated = 0 ORDER BY id DESC LIMIT 1", (iid,)).fetchone()
            waiting_ok = j is not None and j["verdict"] == "waiting" and j["digest"] == digest(f.evidence)
            if waiting_ok and age < self.timing["postpone_max"]:
                return
            if pending is not None and now - float(pending["requested"]) < JUDGMENT_TIMEOUT * 2:
                return  # its verdict is due; a stall is not told before the judgment it waits for
            if age >= self.timing["escalate_uncertain"]:
                self.escalate(inc, f, now, judged=j)
            return
        if f.family in ("executor", "queue", "wait", "observation", "coordination"):
            grace = {"queue": self.timing["queue_stall"], "observation": 0.0, "coordination": self.timing.get("coordination_grace", 600.0) if f.condition == "uncertain" else 0.0}.get(f.family, 0.0)
            if age >= grace and not inc["escalated"]:
                self.escalate(inc, f, now)
            return
        if f.recover and self.recoverer is not None:
            return  # the recovery path takes it (wfrecover)
        if not inc["escalated"]:
            self.escalate(inc, f, now, why="the recovery role is not filled here (no [recovery] workflow)" if f.recover else
                          "the same interruption came back after recoveries; another would repeat it" if f.kind == "repeated" else "a recovery run is not itself recovered")

    def escalate(self, inc, f: wc.Finding, now: float, judged=None, why: str | None = None) -> None:
        iid = inc["id"]
        where = f"{f.workspace} {f.ref}" if f.ref else "the executor"
        lines = [f"**Observer: {f.condition} — {where}** (incident `{iid}`)", "", f.fact,
                 f"First suspected {_clock(float(inc['first_suspected']))}."]
        if judged is not None:
            lines.append(f"Local judgment: {judged['verdict']} — {judged['evidence']}")
        if why:
            lines.append(f"Not sent to recovery: {why}.")
        if f.affected:
            lines.append(f"Affected runs: {', '.join(f.affected)}")
        lines.append(ACTIONS.get(f.family or "", "Look at the run: `wfe run show <run> --workspace <ws>` and `wfe exec status <run>`."))
        self.tell_owners(iid, "\n".join(lines), "escalated")
        self.note(iid, f"Told the realm's owners ({f.condition}).", "escalated-note")
        self.store.update(iid, escalated=now, state="escalated")
        self.store.event(iid, "escalated", {"condition": f.condition, "judged": dict(judged) if judged is not None else None, "why": why})
        self.log(f"incident {iid} escalated to the owners: {f.condition}")

    # ---- judgments ----------------------------------------------------------------------

    def request_judgment(self, inc, f: wc.Finding, now: float) -> None:
        iid = inc["id"]
        d = digest(f.evidence)
        last = self.store.latest_judgment(iid)
        if last is not None and last["digest"] == d and not last["invalidated"]:
            if last["finished"] is None:
                return  # pending on the same evidence
            if last["verdict"] == "waiting":
                nxt = inc["next_review"]
                if nxt is None or now < float(nxt):
                    return
            elif last["verdict"] in ("stalled", "unclear"):
                return  # already said; escalation follows its bound
        if last is not None and last["finished"] is None and last["digest"] != d:
            self.store.db.execute("UPDATE judgments SET invalidated = 1 WHERE id = ?", (last["id"],))
            self.store.event(iid, "judgment-invalidated", {"judgment": last["id"], "why": "the evidence moved before a verdict"})
        cur = self.store.db.execute("INSERT INTO judgments (incident, digest, requested) VALUES (?, ?, ?)", (iid, d, now))
        seconds = {"since_first_suspicion": now - float(inc["first_suspected"])}
        self.judge.submit(int(cur.lastrowid), iid, f.fact, f.evidence, seconds)
        self.spent["judgments"] += 1
        self.store.event(iid, "judgment-requested", {"judgment": cur.lastrowid, "digest": d})

    def collect_judgments(self, now: float) -> None:
        if self.judge is None:
            return
        for job_id, result in self.judge.results():
            row = self.store.db.execute("SELECT * FROM judgments WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                continue
            inc = self.store.incident(row["incident"])
            f = self.last_findings.get(inc["uid"]) if inc else None
            stale = f is None or f.key != row["incident"] or digest(f.evidence) != row["digest"]
            self.store.db.execute("UPDATE judgments SET finished = ?, verdict = ?, evidence = ?, workspace = ?, invalidated = ? WHERE id = ?",
                                  (now, result.get("verdict"), result.get("evidence"), result.get("workspace"), int(stale), job_id))
            self.store.event(row["incident"], "judged", {"judgment": job_id, "verdict": result.get("verdict"), "evidence": result.get("evidence"), "invalidated": stale})
            if inc is None or stale:
                continue
            if result.get("verdict") == "waiting":
                n = int(inc["postponed"]) + 1
                wait = min(self.timing["review_wait"] * (2 ** (n - 1)), self.timing["review_wait_max"])
                self.store.update(inc["id"], postponed=n, next_review=now + wait)
            self.note(inc["id"], f"Judged **{result.get('verdict')}** on the evidence of {_clock(now)}: {result.get('evidence')}", f"judged-{job_id}")

    # ---- verification ---------------------------------------------------------------------

    def verify(self, inc, by_uid: dict[str, wc.Finding], executor: wc.Finding | None, doc: dict, now: float) -> None:
        iid = inc["id"]
        if inc["family"] == "executor":
            if executor is None and doc.get("executor", {}).get("state") == "available":
                self.close(inc, "resumed", {"executor": doc.get("executor")}, now)
            return
        if inc["uid"] == "coordination":
            # improve_wfrun p4: the path's own incident closes once a turn decided again or nothing awaits.
            c = doc.get("coordination") or {}
            last = c.get("lastTurn") or {}
            if not c.get("stalled") and (not c.get("awaiting") or (last.get("decisions") or 0) > 0 or c.get("turn")):
                self.close(inc, "resumed", {"coordination": c, "why": "a coordination turn decided again or nothing awaits a decision"}, now)
            return
        f = by_uid.get(inc["uid"])
        if f is None and ":" in inc["uid"]:
            # Opened while the record was unreadable (no uid yet): the same run by its place.
            f = next((x for x in by_uid.values() if x.workspace == inc["workspace"] and x.ref == inc["ref"]), None)
        if f is None:
            return  # not observed: nothing is concluded from absence
        if f.key == iid:
            return  # still the same episode
        run = next((r for r in doc.get("runs") or [] if r["identity"].get("uid") == f.uid), None)
        if f.condition in ("unobservable", "executor-blocked") or run is None:
            return
        if self.recoverer is not None:
            outcome = self.recoverer.verify(self, inc, f, run, now)
            if outcome:
                self.close(inc, *outcome, now=now)
                return
            if outcome is False:
                return  # the recovery path is still verifying
        self.close(inc, *settled_outcome(inc, f, run), now=now)

    def close(self, inc, outcome: str, evidence: dict, now: float) -> None:
        iid = inc["id"]
        self.store.update(iid, state="closed", outcome=outcome, outcome_at=now, outcome_evidence=evidence)
        self.store.event(iid, "closed", {"outcome": outcome, "evidence": evidence})
        self.note(iid, f"Closed: **{outcome}** ({_clock(now)}). {evidence.get('why', '')}".strip(), f"closed-{int(now)}")
        if inc["escalated"]:
            self.tell_owners(iid, f"Observer: incident `{iid}` ({inc['condition']}, {inc['workspace']} {inc['ref']}) closed — {outcome}. {evidence.get('why', '')}".strip(), f"closed-{int(now)}")
        self.log(f"incident {iid} closed: {outcome}")

    # ---- health ---------------------------------------------------------------------------

    def health(self, now: float) -> dict[str, Any]:
        open_ = self.store.open_incidents()
        by_state: dict[str, int] = {}
        for i in open_:
            by_state[i["state"]] = by_state.get(i["state"], 0) + 1
        pending = self.store.pending_judgments()
        oldest_pending = min((float(p["requested"]) for p in pending), default=None)
        running = self.judge.running if self.judge is not None else None
        # a request for an incident that is no longer open can never be taken up: it is not backlog
        marks = ",".join("?" * len(OPEN_STATES))
        owed = self.store.db.execute(
            f"SELECT count(*), min(a.journaled) FROM assignments a JOIN incidents i ON i.id = a.incident "
            f"WHERE a.closed IS NULL AND a.acknowledged IS NULL AND i.state IN ({marks})", OPEN_STATES).fetchone()
        conditions: dict[str, int] = {}
        for f in self.last_findings.values():
            conditions[f.condition] = conditions.get(f.condition, 0) + 1
        return {
            "schema": HEALTH_SCHEMA, "written_at": now, "pid": os.getpid(), "enabled": self.s.enabled, "interval_seconds": self.s.interval,
            "cycle": dict(self.cycle), "source": dict(self.source), "latest_failure": self.latest_failure,
            "runs": {"observed": len(self.last_findings), "conditions": conditions},
            "incidents": {"open": len(open_), "by_state": by_state, "oldest_open_seconds": (now - min(float(i["detected"]) for i in open_)) if open_ else None},
            "judgment": {"pending": len(pending), "oldest_pending_seconds": (now - oldest_pending) if oldest_pending else None,
                         "running": running, "timeout_seconds": JUDGMENT_TIMEOUT},
            "recovery": {"enabled": self.recoverer is not None, "unacknowledged": owed[0], "oldest_unacknowledged_seconds": (now - float(owed[1])) if owed[1] else None},
            "outbox": outbox_summary(self.store), "spent": dict(self.spent), "timing": self.timing,
        }

    def write_status(self, now: float) -> None:
        """`agag.status.v1` for nodeutils (agent liveness in nctl): the last look
        whose observation came back stands for a poll that returned."""
        path = os.environ.get("AGAG_STATUS_PATH")
        if not path or self.source.get("state") != "live" or not self.source.get("last_ok_at"):
            return
        import datetime

        doc = {"schema": "agag.status.v1", "queue_id": None, "last_error": self.source.get("reason"),
               "last_poll_ok": datetime.datetime.fromtimestamp(float(self.source["last_ok_at"]), datetime.timezone.utc).isoformat()}
        try:
            tmp = Path(path).with_suffix(".tmp")
            tmp.write_text(json.dumps(doc, sort_keys=True))
            os.replace(tmp, path)
        except OSError as error:
            self.log(f"status not written: {error!r}")

    def write_health(self, now: float) -> None:
        if not self.cycle["in_progress"]:
            self.write_status(now)
        if self.health_path is None:
            return
        try:
            tmp = self.health_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.health(now), indent=1, sort_keys=True, default=str))
            os.replace(tmp, self.health_path)
        except Exception as error:  # noqa: BLE001 - the watchdog will say the record is stale
            self.log(f"health record not written: {error!r}")

    def serve(self, stop: threading.Event | None = None) -> None:
        stop = stop or threading.Event()
        self.log(f"workflow monitor: a look every {self.s.interval:.0f} s")
        while not stop.is_set():
            if self.s.enabled:
                self.look()
            else:
                self.write_health(self.clock())
            stop.wait(self.s.interval)


ACTIONS = {
    "executor": "The executor runs as launchd `com.agdev.agautolab-wfexec`; its log is `agautolab/.local/out/wfexec.log`. Restarting it ends lost attempts as `unknown` (they are then recovered as interruptions).",
    "queue": "The executor reports but does not claim this job: `wfe exec status <run>` shows the job and why a claim drops it.",
    "wait": "The run waits on an external result past the deadline it declared: look at the awaited result, then answer, resume or cancel the run.",
    "observation": "The run's record cannot be read: `wfe runs index --workspace <ws>` and `wfe run check <run>`.",
    "attempt": "`wfe exec status <run> --workspace <ws>` shows the attempt, its process and its log; a stop request is `wfe run stop <run> --by <name>`.",
    "coordination": "Execution coordination is the coordination role's (`wfe coordinate view`, `wfe coordinate decisions`); `wfe coordinate wake` opens a turn now, `wfe coordinate start <run> --by <name> --reason …` admits a job by hand, and the coordination runs' records are in the project that fills the role (the area's roles.json).",
}


def settled_outcome(inc, f: wc.Finding, run: dict) -> tuple[str, dict]:
    """How an incident ended when nobody of ours acted on it."""
    ev = {"seq": run.get("seq"), "situation": run.get("situation"), "condition": f.condition}
    if inc["family"] == "observation":
        return "resumed", {**ev, "why": f"the run's record is readable again ({f.condition})"}
    if f.condition == "terminal":
        return ("cancelled" if run.get("cancelled") else "completed"), {**ev, "why": f"the run is {f.kind}"}
    if f.condition == "respected-hold":
        return "held", {**ev, "why": f"a person holds it: {f.fact}"}
    if inc["family"] == "attempt" and run.get("recoveries"):
        return "manual", {**ev, "why": "the run was continued by a recovery outside this incident"}
    if inc["family"] == "attempt" and inc["condition"] in ("interrupted", "lost-attempt"):
        return "manual", {**ev, "why": f"the hold was lifted by someone else; the run is {f.condition}"}
    if f.condition in ("working", "queued", "awaiting-person", "awaiting-external"):
        return ("resumed" if inc["escalated"] else "false-alarm"), {**ev, "why": f"the run is {f.condition}: {f.fact}"}
    return "resumed", {**ev, "why": f"the run is {f.condition}"}


def _clock(t: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t))


# ---- the process ----------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    import argparse

    from .spec import SPEC

    parser = argparse.ArgumentParser(description="Observer over workflow runs (observer p3)")
    parser.add_argument("--settings", type=Path, default=SPEC.local / "workflow.toml")
    parser.add_argument("--once", action="store_true", help="one look, then exit")
    parser.add_argument("--state", type=Path, default=SPEC.local, help="where the store and the health record are (trials: a scratch directory)")
    args = parser.parse_args(argv)
    settings = Settings.load(args.settings)

    def log(message: str) -> None:
        print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}", flush=True)

    store = Store(args.state / "workflow" / "observer.sqlite")
    from .alerting import tool

    poster = Poster(store, alerts=tool, log=log, local_channel=settings.channel)
    log(f"owner notices: {'the alert sender' if tool() is not None else 'NO ROUTE (no alert sender configured)'}; incident notes: kept in the store")
    judge = None
    if settings.judge:
        from .wftriage import judge as triage

        judge = Judge(lambda incident, fact, evidence, seconds: triage(SPEC, incident, fact, evidence, seconds), log=log)
    recoverer = make_recoverer(settings.recovery, log)
    monitor = WorkflowMonitor(settings, store, poster, judge=judge, recoverer=recoverer, health_path=args.state / HEALTH_FILE, log=log)
    if args.once:
        print(json.dumps(monitor.look(), indent=1, default=str))
        return 0
    stop = threading.Event()
    import signal

    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    monitor.serve(stop)
    return 0


if __name__ == "__main__":
    sys.exit(main())
