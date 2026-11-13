#!/usr/bin/env python3
"""The installation's owner alerts, independent of WFE and of Zulip (cluster_teamwork p5).

A spool of alert records (`agdev.alert.v1`) and a sender to the operator's
configured destination. Standard library only, installed with the lifecycle
tool (`config/install/runtime/`), so a broken release, a stopped WFE or a
retired Zulip cannot keep an alert from being sent or kept. Callers: the
watchdog (Observer's and the executor's health), Observer's owner notices,
agdevctl's lifecycle outcomes.

Configuration `<state>/alerts/alerts.json` (rendered by `agdevctl alerts`
from `[alerts]` in instance.toml):

    {"version": 1, "instance": "<id>", "display": "agdev", "route": "slack",
     "tokenFile": "<state>/alerts/slack.token", "channel": "<Slack channel or member id>"}

Spool beside it: `queue/<id>.json` (owed: `owed`, `failed`), `sent/<id>.json`,
`status.json`. The id is a digest of (event, state, key): the same occurrence
is queued once; a new occurrence (another key) or its recovery is another.
Delivery: Slack `chat.postMessage` through curl (the token on curl's stdin,
never on a command line). Transient failure (network, HTTP 5xx, `ratelimited`)
stays owed with backoff; a refusal (`invalid_auth`, `channel_not_found`, …)
stays `failed`, visible, and is tried again hourly, so a configuration fix sends
it. At least once: a lost answer from Slack may repeat one alert. More than
MAX_PER_HOUR sends in an hour defers the rest; nothing is dropped.

CLI: agdev_alert.py [--config FILE] send --severity S --event E [--state occurrence|recovery]
       [--key K] --text T [--evidence PATH]  |  flush  |  status [--json]  |  diagnostic
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SCHEMA = "agdev.alert.v1"
SEVERITIES = ("critical", "warning", "info")
STATES = ("occurrence", "recovery")
BACKOFF = (15, 60, 300, 900, 1800)
REFUSED_RETRY = 3600
MAX_PER_HOUR = 30
KEEP_SENT = 500
TRANSIENT = {"ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout", "team_added_to_org"}
MARK = {"critical": "🚨", "warning": "⚠️", "info": "ℹ️"}


def iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def default_config() -> Path | None:
    found = os.environ.get("AGDEV_ALERTS")
    return Path(found) if found else None


def load(config: Path | str | None) -> dict | None:
    """The configuration, or None when this installation has no alert route."""
    path = Path(config) if config else default_config()
    if not path or not path.is_file():
        return None
    cfg = json.loads(path.read_text(encoding="utf-8"))
    if cfg.get("version") != 1 or cfg.get("route") not in ("slack",):
        raise ValueError(f"{path}: needs {{version: 1, route: slack, tokenFile, channel}}")
    cfg["_path"] = str(path)
    cfg["_spool"] = str(path.parent)
    return cfg


def configured(config: Path | str | None = None) -> bool:
    try:
        return load(config) is not None
    except (OSError, ValueError):
        return False


def _owned_like_dir(path: Path) -> None:
    # Root (the lifecycle service on Linux) writes into the monitor account's spool: the file becomes the spool's.
    if os.geteuid() == 0:
        st = path.parent.stat()
        try:
            os.chown(path, st.st_uid, st.st_gid)
        except OSError:
            pass


def _write(path: Path, value: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=1, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o660)
    os.replace(tmp, path)
    _owned_like_dir(path)


def _dirs(cfg: dict) -> tuple[Path, Path]:
    spool = Path(cfg["_spool"])
    queue, sent = spool / "queue", spool / "sent"
    for d in (queue, sent):
        d.mkdir(mode=0o2770, exist_ok=True)
        _owned_like_dir(d)
    return queue, sent


def queue(config=None, *, severity: str, event: str, text: str, state: str = "occurrence", key: str | None = None,
          evidence: str | None = None, at: float | None = None) -> str | None:
    """Queues one alert; returns its id (None: no alert route here). The same (event, state, key) is queued once."""
    cfg = load(config)
    if cfg is None:
        return None
    if severity not in SEVERITIES or state not in STATES or not event or not text.strip():
        raise ValueError(f"an alert is {{severity in {SEVERITIES}, event, state in {STATES}, text}}")
    q, sent = _dirs(cfg)
    at = at or time.time()
    ident = hashlib.sha256(f"{event}\n{state}\n{key or ''}".encode()).hexdigest()[:20]
    if (q / f"{ident}.json").exists() or (sent / f"{ident}.json").exists():
        return ident
    _write(q / f"{ident}.json", {"schema": SCHEMA, "id": ident, "instance": cfg.get("instance"), "display": cfg.get("display"),
                                 "severity": severity, "event": event, "state": state, "key": key, "at": iso(at), "text": text.strip()[:3000],
                                 "evidence": evidence, "delivery": {"state": "owed", "tries": 0, "next_try": 0, "error": None}})
    return ident


def render(a: dict) -> str:
    body = re.sub(r"\*\*(.+?)\*\*", r"*\1*", a["text"])  # Zulip/Markdown bold → Slack mrkdwn
    head = f"{MARK.get(a['severity'], '')} *{a.get('display') or a.get('instance')}* · {a['severity']}{' · recovered' if a['state'] == 'recovery' else ''} · `{a['event']}`"
    tail = f"_{a['at']}{' · evidence ' + a['evidence'] if a.get('evidence') else ''}_"
    return f"{head}\n{body}\n{tail}"


def _slack(cfg: dict, payload: dict, scratch: Path) -> tuple[bool, str | None, str | None, bool]:
    """(ok, ts, error, transient)."""
    token = Path(cfg["tokenFile"]).read_text(encoding="utf-8").strip()
    body = scratch / ".payload.json"
    body.write_text(json.dumps(payload), encoding="utf-8")
    try:
        done = subprocess.run(["curl", "-sS", "-m", "20", "--config", "-", "-X", "POST", "-H", "Content-Type: application/json; charset=utf-8",
                               "--data-binary", f"@{body}", "https://slack.com/api/chat.postMessage"],
                              input=f'header = "Authorization: Bearer {token}"\n', capture_output=True, text=True, timeout=40)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, None, f"curl: {error}", True
    finally:
        body.unlink(missing_ok=True)
    if done.returncode != 0:
        return False, None, f"curl exited {done.returncode}: {done.stderr.strip()[:200]}", True
    try:
        answer = json.loads(done.stdout)
    except ValueError:
        return False, None, f"not JSON: {done.stdout[:200]}", True
    if answer.get("ok"):
        return True, answer.get("ts"), None, False
    error = str(answer.get("error") or "unknown")
    return False, None, f"slack: {error}", error in TRANSIENT


def flush(config=None, now: float | None = None) -> dict:
    cfg = load(config)
    if cfg is None:
        return {"configured": False}
    q, sent = _dirs(cfg)
    spool = Path(cfg["_spool"])
    now = now or time.time()
    done = {"sent": 0, "owed": 0, "failed": 0, "deferred": 0}
    with open(spool / ".lock", "a") as lock:
        if os.geteuid() == 0:  # the monitor account must open it too
            os.chmod(spool / ".lock", 0o660)
            _owned_like_dir(spool / ".lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        recent = sum(1 for f in sent.glob("*.json") if now - f.stat().st_mtime < 3600)
        for path in sorted(q.glob("*.json"), key=lambda p: p.stat().st_mtime):
            try:
                a = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            d = a.setdefault("delivery", {"state": "owed", "tries": 0, "next_try": 0})
            if d.get("next_try", 0) > now:
                done[d.get("state", "owed")] = done.get(d.get("state", "owed"), 0) + 1
                continue
            if recent >= MAX_PER_HOUR:
                done["deferred"] += 1
                continue
            ok, ts, error, transient = _slack(cfg, {"channel": cfg["channel"], "text": render(a), "unfurl_links": False, "unfurl_media": False}, spool)
            d["tries"] = int(d.get("tries", 0)) + 1
            d["last_try"] = iso(now)
            if ok:
                d.update(state="sent", ts=ts, sent=iso(now), error=None)
                _write(sent / path.name, a)
                path.unlink(missing_ok=True)
                recent += 1
                done["sent"] += 1
            else:
                d.update(state="owed" if transient else "failed", error=error,
                         next_try=now + (BACKOFF[min(d["tries"] - 1, len(BACKOFF) - 1)] if transient else REFUSED_RETRY))
                _write(path, a)
                done["owed" if transient else "failed"] += 1
        for old in sorted(sent.glob("*.json"), key=lambda p: p.stat().st_mtime)[:-KEEP_SENT]:
            old.unlink(missing_ok=True)
        write_status(cfg, now)
    return done


def status(config=None) -> dict:
    cfg = load(config)
    if cfg is None:
        return {"configured": False}
    q, sent = _dirs(cfg)
    rows = []
    for path in q.glob("*.json"):
        try:
            rows.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    last = max(sent.glob("*.json"), key=lambda p: p.stat().st_mtime, default=None)
    errors = [r["delivery"].get("error") for r in rows if r.get("delivery", {}).get("error")]
    return {"configured": True, "route": cfg["route"], "channel": cfg["channel"], "queued": len(rows),
            "failed": sum(1 for r in rows if r.get("delivery", {}).get("state") == "failed"),
            "oldest": min((r["at"] for r in rows), default=None), "last_error": errors[-1] if errors else None,
            "last_sent": iso(last.stat().st_mtime) if last else None, "sent_kept": len(list(sent.glob("*.json")))}


def write_status(cfg: dict, now: float) -> None:
    try:
        _write(Path(cfg["_spool"]) / "status.json", {"checked": iso(now), **status(cfg["_path"])})
    except OSError:
        pass


def send(config=None, **alert) -> dict:
    """Queue and try at once; what stays owed is retried by the next flush (the watchdog flushes every 30 s)."""
    ident = queue(config, **alert)
    if ident is None:
        return {"configured": False}
    return {"id": ident, **flush(config)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--config", type=Path, default=default_config())
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("send")
    s.add_argument("--severity", required=True, choices=SEVERITIES)
    s.add_argument("--event", required=True)
    s.add_argument("--state", default="occurrence", choices=STATES)
    s.add_argument("--key")
    s.add_argument("--text", required=True)
    s.add_argument("--evidence")
    sub.add_parser("flush")
    st = sub.add_parser("status")
    st.add_argument("--json", action="store_true")
    sub.add_parser("diagnostic", help="send one alert labelled as a diagnostic, to verify the route")
    a = p.parse_args(argv)
    if a.cmd == "send":
        out = send(a.config, severity=a.severity, event=a.event, state=a.state, key=a.key, text=a.text, evidence=a.evidence)
    elif a.cmd == "flush":
        out = flush(a.config)
    elif a.cmd == "diagnostic":
        now = time.time()
        out = send(a.config, severity="info", event="diagnostic:alert-route", key=iso(now),
                   text=f"Diagnostic only, nothing is wrong: this installation's alert route works without WFE and without Zulip (sent {iso(now)} from {os.uname().nodename}).")
    else:
        out = status(a.config)
        if not a.json:
            if not out.get("configured"):
                print("no alert route is configured (alerts.json absent)")
                return 1
            print(f"alerts via {out['route']} → {out['channel']}: {out['queued']} queued ({out['failed']} refused), oldest {out['oldest'] or '—'}, "
                  f"last sent {out['last_sent'] or 'never'}{', last error ' + out['last_error'] if out['last_error'] else ''}")
            return 0 if not out["queued"] else 3
    print(json.dumps(out, indent=1))
    return 0 if out.get("configured", True) else 1


if __name__ == "__main__":
    sys.exit(main())
