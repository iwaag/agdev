"""Who watches the watcher: Observer's health and the executor's, from outside both.

observer p3 step 7, relocated from the agentroom relay (`robust_workflow`
p2 step 4), which belonged to the agent room being retired. A separate
process (`com.agdev.agobserver-watchdog`, `python -m agobserver.watchdog`):
a monitor cannot be the alarm for its own stop, and neither can the
executor whose heartbeat it reports.

Every 30 s it reads Observer's `workflow-health.json` (`agobserver.workflow-
health.v1`) and the executor's heartbeat through `wfe exec status` (not
through Observer), and evaluates two components:

| Component | State | Meaning |
|---|---|---|
| observer | `ok` / `idle` | looks complete on schedule (`idle`: no run observed) |
| | `starting` | the watchdog started less than 90 s ago and Observer's record is older than that start (or absent): Observer, started with it, has not had time for a first look — told to nobody |
| | `disabled` | switched off in its settings — said, not alarmed |
| | `missing` | no health record: never ran here, or it is gone |
| | `stopped` | no look completed for 3 × interval + 60 s (and whether its process lives) |
| | `stalled` | a look in progress for that long |
| | `unable_to_observe` | `wfe observe` has failed for 300 s: nothing is concluded meanwhile |
| | `judgment_stalled` | one local-model judgment running for twice its timeout |
| | `degraded` | recovery backlog: a recovery request untaken for 2 h, posts unsent for 15 min, judgments waiting 3 × their timeout |
| executor | `available` / `down` / `unknown` | its heartbeat younger than 180 s / older / unreadable |

A change into a failing state, and back, is told to the owners once through
the installation's alert sender (cluster_teamwork p5: `AGDEV_ALERT_TOOL`,
independent of WFE; the watchdog also retries what that sender still owes,
every check). The latest verdict, with the alert sender's state, is written
to `.local/watchdog.json`.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

SCHEMA = "agobserver.workflow-health.v1"
EVERY_SECONDS = 30.0
SOURCE_FAILED_SECONDS = 300.0
EXECUTOR_STALE_SECONDS = 180.0
FIRST_LOOK_SECONDS = 90.0  # after the watchdog's own start, evidence older than it is not judged
BACKLOG_ACK_SECONDS = 7200.0
BACKLOG_POST_SECONDS = 900.0
FAILING = ("missing", "stopped", "stalled", "unable_to_observe", "judgment_stalled", "degraded", "down", "unknown")


def _read(path: Path | None) -> dict | None:
    try:
        found = json.loads(Path(path).read_text(encoding="utf-8")) if path else None
    except (OSError, ValueError):
        return None
    return found if isinstance(found, dict) else None


def _age(now: float, then) -> float | None:
    try:
        return max(0.0, now - float(then)) if then else None
    except (TypeError, ValueError):
        return None


def _span(seconds: float | None) -> str:
    if seconds is None:
        return "an unknown time"
    return f"{seconds:.0f} s" if seconds < 90 else f"{seconds / 60:.0f} min"


def _alive(pid) -> bool | None:
    try:
        os.kill(int(pid), 0)
        return True
    except (TypeError, ValueError):
        return None
    except PermissionError:
        return True
    except OSError:
        return False


def _newest(health: dict) -> float | None:
    cycle = health.get("cycle") or {}
    stamps = []
    for value in (cycle.get("completed_at") or health.get("written_at"), cycle.get("started_at")):
        try:
            stamps.append(float(value))
        except (TypeError, ValueError):
            pass
    return max(stamps) if stamps else None


def evaluate_observer(health: dict | None, now: float, started: float | None = None) -> dict:
    """`started`: when this watchdog began. Until FIRST_LOOK_SECONDS after it, a record
    that predates it (or none) is the previous start's, not Observer's current state."""
    if started is not None and now - started < FIRST_LOOK_SECONDS:
        newest = _newest(health) if health and health.get("schema") == SCHEMA else None
        if newest is None or newest < started:
            return {"state": "starting", "reason": f"the watchdog started {_span(now - started)} ago and Observer has not yet written a record since; its first look is awaited for up to {_span(FIRST_LOOK_SECONDS)}"}
    if not health or health.get("schema") != SCHEMA:
        return {"state": "missing", "reason": "no workflow-health record: Observer has not run here, or its record is gone"}
    if health.get("enabled") is False:
        return {"state": "disabled", "reason": "Observer's workflow monitor is switched off"}
    interval = float(health.get("interval_seconds") or 60)
    limit = 3 * interval + 60
    cycle = health.get("cycle") or {}
    if cycle.get("in_progress"):
        running = _age(now, cycle.get("started_at"))
        if running is not None and running > limit:
            return {"state": "stalled", "since": cycle.get("started_at"), "reason": f"a look has been running for {_span(running)} (looks are every {_span(interval)})"}
    else:
        quiet = _age(now, cycle.get("completed_at") or health.get("written_at"))
        if quiet is None or quiet > limit:
            alive = _alive(health.get("pid"))
            return {"state": "stopped", "since": cycle.get("completed_at"), "process_alive": alive,
                    "reason": f"no look completed for {_span(quiet)}; its process {'is alive, so the loop alone stopped' if alive else 'is gone' if alive is False else 'cannot be checked'}"}
    source = health.get("source") or {}
    if source.get("state") == "failed":
        failed = _age(now, source.get("failed_since")) or 0.0
        if failed > SOURCE_FAILED_SECONDS:
            return {"state": "unable_to_observe", "since": source.get("failed_since"), "reason": f"wfe observe has failed for {_span(failed)} ({source.get('reason')}); nothing is concluded about any run meanwhile"}
    judgment = health.get("judgment") or {}
    timeout = float(judgment.get("timeout_seconds") or 150)
    running = judgment.get("running") or {}
    held = _age(now, running.get("since"))
    if held is not None and held > 2 * timeout:
        return {"state": "judgment_stalled", "since": running.get("since"), "reason": f"the judgment of incident {running.get('incident')} has run for {_span(held)} (timeout {_span(timeout)})"}
    recovery = health.get("recovery") or {}
    untaken = float(recovery.get("oldest_unacknowledged_seconds") or 0)
    if untaken > BACKLOG_ACK_SECONDS:
        return {"state": "degraded", "reason": f"{recovery.get('unacknowledged')} recovery request(s) not taken up, the oldest for {_span(untaken)}"}
    outbox = health.get("outbox") or {}
    oldest = _age(now, outbox.get("oldest_unsent"))
    if oldest is not None and oldest > BACKLOG_POST_SECONDS:
        return {"state": "degraded", "reason": f"Observer's posts have not gone out for {_span(oldest)} ({outbox.get('counts')})"}
    waiting = float(judgment.get("oldest_pending_seconds") or 0)
    if waiting > 3 * timeout:
        return {"state": "degraded", "reason": f"{judgment.get('pending')} judgment(s) waiting, the oldest for {_span(waiting)}"}
    runs = (health.get("runs") or {}).get("observed") or 0
    incidents = (health.get("incidents") or {}).get("open") or 0
    return {"state": "ok" if runs else "idle", "reason": f"look {cycle.get('count')} completed {_span(_age(now, cycle.get('completed_at')))} ago; {runs} run(s) observed, {incidents} open incident(s)"}


def evaluate_executor(status: dict | None) -> dict:
    ex = (status or {}).get("executor") if isinstance(status, dict) else None
    if not ex:
        return {"state": "unknown", "reason": "the executor's state could not be read through wfe"}
    if ex.get("state") == "available":
        return {"state": "available", "reason": ex.get("detail") or "reporting"}
    return {"state": "down" if ex.get("state") == "unavailable" else "unknown", "reason": ex.get("detail") or ex.get("state")}


def executor_status(wfe: list[str], workspace: str | None, timeout: float = 30.0) -> dict | None:
    try:
        proc = subprocess.run([*wfe, "exec", "status", *(["--workspace", workspace] if workspace else []), "--json"], capture_output=True, text=True, timeout=timeout)
        return json.loads(proc.stdout) if proc.returncode == 0 else None
    except Exception:  # noqa: BLE001 - unreadable is a verdict, not a crash
        return None


class Watchdog:
    def __init__(self, health_path: Path, read_executor: Callable[[], dict | None], alert: Callable[..., None] | None = None,
                 out_path: Path | None = None, clock: Callable[[], float] = time.time, log: Callable[[str], None] = print,
                 sender: Callable[[], dict] | None = None):
        self.health_path = health_path
        self.read_executor = read_executor
        self.alert = alert
        self.out_path = out_path
        self.clock = clock
        self.log = log
        self.latest: dict[str, dict] = {}
        self.started = clock()
        self.sender = sender  # flushes the alert spool and says its state (None: no alert route)
        self.since: dict[str, float] = {}

    def check(self) -> dict[str, dict]:
        now = self.clock()
        found = {"observer": evaluate_observer(_read(self.health_path), now, self.started), "executor": evaluate_executor(self.read_executor())}
        for name, verdict in found.items():
            before = (self.latest.get(name) or {}).get("state")
            state = verdict["state"]
            if before == state:
                continue
            self.log(f"watchdog: {name} is {state}: {verdict['reason']}")
            failing, was_failing = state in FAILING, before in FAILING
            if self.alert is not None and (failing or was_failing):
                label = "Observer's workflow monitor" if name == "observer" else "The workflow executor"
                text = (f"**{label} is {state.replace('_', ' ')}**{' (found when the watchdog started)' if before is None else ''}. {verdict['reason']}."
                        if failing else f"{label} is {state} again ({verdict['reason']}).")
                if failing and not was_failing:
                    self.since[name] = now
                try:
                    self.alert(text, component=name, state=state, failing=failing, since=self.since.get(name, now))
                except Exception as error:  # noqa: BLE001 - the verdict file still says it
                    self.log(f"watchdog: could not send the alert: {error!r}")
        self.latest = found
        alerts = None
        if self.sender is not None:
            try:
                alerts = self.sender()
            except Exception as error:  # noqa: BLE001 - shown, never fatal
                alerts = {"error": repr(error)[:300]}
        if self.out_path is not None:
            try:
                tmp = self.out_path.with_suffix(".tmp")
                tmp.write_text(json.dumps({"checked_at": now, **found, **({"alerts": alerts} if alerts is not None else {})}, indent=1))
                os.replace(tmp, self.out_path)
            except OSError as error:
                self.log(f"watchdog: verdict not written: {error!r}")
        return found

    def run(self, stop: threading.Event | None = None) -> None:
        stop = stop or threading.Event()
        while not stop.is_set():
            try:
                self.check()
            except Exception as error:  # noqa: BLE001 - the watchdog outlives its checks
                self.log(f"watchdog: check failed: {error!r}")
            stop.wait(EVERY_SECONDS)


def main(argv: list[str] | None = None) -> int:
    import argparse
    import signal

    from .spec import SPEC
    from .wfmonitor import HEALTH_FILE, Settings

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--settings", type=Path, default=SPEC.local / "workflow.toml")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--no-alert", action="store_true")
    args = parser.parse_args(argv)
    settings = Settings.load(args.settings)
    workspace = str((settings.recovery or {}).get("workspace") or "") or None
    log = lambda m: print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {m}", flush=True)  # noqa: E731
    from .alerting import tool

    alert = None
    sender = None
    verdict = SPEC.local / "watchdog.json"
    if not args.no_alert and tool() is not None:
        def alert(text: str, component: str = "", state: str = "", failing: bool = True, since: float = 0.0) -> None:
            t = tool()
            t.send(severity=("critical" if state in ("stopped", "down", "missing", "unknown") else "warning") if failing else "info",
                   event=f"watchdog:{component}", state="occurrence" if failing else "recovery", key=f"{since:.0f}",
                   text=text, evidence=str(verdict))

        def sender() -> dict:
            t = tool()
            return {**t.flush(), **t.status()} if t is not None else {"configured": False}
    if alert is None and not args.no_alert:
        log("watchdog: no alert route (no alert sender configured): changes are only written to watchdog.json")
    dog = Watchdog(SPEC.local / HEALTH_FILE, lambda: executor_status(settings.wfe, workspace), alert=alert, out_path=verdict, log=log, sender=sender)
    if args.once:
        print(json.dumps(dog.check(), indent=1))
        return 0
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    log("watchdog: Observer's workflow-health and the executor's heartbeat, every 30 s")
    dog.run(stop)
    return 0


if __name__ == "__main__":
    sys.exit(main())
