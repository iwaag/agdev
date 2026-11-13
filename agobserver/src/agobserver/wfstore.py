"""Observer's own records about workflow runs (observer p3, `docs/workflow.md`).

Host-local, `agobserver/.local/workflow/observer.sqlite`. Workflow records
and Git stay authoritative; these say what Observer saw, whom it asked and
what it verified:

- `suspects`: a finding seen but still inside its grace — its first sight
  survives a restart, so a restart never resets the clock;
- `incidents`: one per `(run uid, family, episode)` (`wfclassify.incident_id`),
  with its first suspicion, detection, next review and outcome;
- `judgments`: the local model's verdicts with the evidence digest they read;
- `assignments`: recovery requests, journaled before they are sent — a
  Zulip post (before cluster_teamwork p4) or a WFE submission by receipt;
- `outbox`: every post (incident notes, owner messages, recovery requests)
  with its delivery state — `owed` → `sending` (recorded before the call) →
  `sent` | `failed` (retried with backoff) | `uncertain` (may have been
  posted; looked for before anything is posted again);
- `events`: an append-only log of every transition above;
- `samples`: the last CPU reading per attempt (progress between looks).
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 2  # 2 (cluster_teamwork p4): assignments.route, receipt, submitted, submit_error, run

DDL = """
CREATE TABLE IF NOT EXISTS suspects (key TEXT PRIMARY KEY, uid TEXT NOT NULL, family TEXT NOT NULL, episode TEXT NOT NULL,
  first_seen REAL NOT NULL, last_seen REAL NOT NULL, condition TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, uid TEXT NOT NULL, workspace TEXT NOT NULL, ref TEXT NOT NULL,
  family TEXT NOT NULL, episode TEXT NOT NULL, kind TEXT NOT NULL, condition TEXT NOT NULL, state TEXT NOT NULL,
  first_suspected REAL NOT NULL, detected REAL NOT NULL, next_review REAL, updated REAL NOT NULL, fact TEXT NOT NULL,
  evidence TEXT NOT NULL, affected TEXT NOT NULL DEFAULT '[]', escalated REAL, postponed INTEGER NOT NULL DEFAULT 0,
  recover INTEGER NOT NULL DEFAULT 0, outcome TEXT, outcome_at REAL, outcome_evidence TEXT, topic TEXT,
  UNIQUE (uid, family, episode));
CREATE TABLE IF NOT EXISTS judgments (id INTEGER PRIMARY KEY, incident TEXT NOT NULL, digest TEXT NOT NULL, requested REAL NOT NULL,
  started REAL, finished REAL, verdict TEXT, evidence TEXT, workspace TEXT, invalidated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY, incident TEXT NOT NULL, n INTEGER NOT NULL, recipient TEXT NOT NULL,
  journaled REAL NOT NULL, outbox INTEGER, state TEXT NOT NULL, acknowledged_by TEXT, acknowledged REAL, performed_seq INTEGER,
  actor TEXT, outcome TEXT, closed REAL, note TEXT, UNIQUE (incident, n));
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, incident TEXT, kind TEXT NOT NULL, channel TEXT, topic TEXT,
  recipients TEXT, text TEXT NOT NULL, marker TEXT NOT NULL UNIQUE, state TEXT NOT NULL, message_id INTEGER, tries INTEGER NOT NULL DEFAULT 0,
  next_try REAL NOT NULL, created REAL NOT NULL, sent REAL, error TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at REAL NOT NULL, incident TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS samples (attempt TEXT PRIMARY KEY, cpu REAL NOT NULL, at REAL NOT NULL);
"""

OPEN_STATES = ("open", "assigned", "recovering", "verifying", "escalated")


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.db = sqlite3.connect(str(path), timeout=10, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=10000")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError(f"{path} is schema {version}, newer than this Observer understands ({SCHEMA_VERSION})")
        self.db.executescript(DDL)
        # v2: a recovery assignment submitted through WFE (route `wfe`) is
        # identified by its receipt and acknowledged by the run bound to it;
        # an older one (route NULL: a Zulip post) keeps its post provenance.
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(assignments)").fetchall()}
        for col, decl in (("route", "TEXT"), ("receipt", "TEXT"), ("submitted", "REAL"), ("submit_error", "TEXT"), ("run", "TEXT")):
            if col not in cols:
                self.db.execute(f"ALTER TABLE assignments ADD COLUMN {col} {decl}")
        self.db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def close(self) -> None:
        self.db.close()

    def tx(self):
        return _Tx(self.db)

    def event(self, incident: str | None, kind: str, detail: dict[str, Any] | str, at: float | None = None) -> None:
        self.db.execute("INSERT INTO events (at, incident, kind, detail) VALUES (?, ?, ?, ?)",
                        (at or time.time(), incident, kind, detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)))

    # ---- suspects -------------------------------------------------------------------

    def suspect(self, key: str, uid: str, family: str, episode: str, condition: str, now: float) -> float:
        """First sight of this suspicion (kept across looks and restarts)."""
        row = self.db.execute("SELECT first_seen FROM suspects WHERE key = ?", (key,)).fetchone()
        if row:
            self.db.execute("UPDATE suspects SET last_seen = ?, condition = ? WHERE key = ?", (now, condition, key))
            return float(row[0])
        self.db.execute("INSERT INTO suspects (key, uid, family, episode, first_seen, last_seen, condition) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (key, uid, family, episode, now, now, condition))
        return now

    def forget_suspects(self, keep: set[str]) -> None:
        for (key,) in self.db.execute("SELECT key FROM suspects").fetchall():
            if key not in keep and not self.incident(key):
                self.db.execute("DELETE FROM suspects WHERE key = ?", (key,))

    # ---- incidents ------------------------------------------------------------------

    def incident(self, iid: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM incidents WHERE id = ?", (iid,)).fetchone()

    def open_incidents(self) -> list[sqlite3.Row]:
        marks = ",".join("?" * len(OPEN_STATES))
        return self.db.execute(f"SELECT * FROM incidents WHERE state IN ({marks}) ORDER BY detected", OPEN_STATES).fetchall()

    def incidents(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM incidents ORDER BY detected").fetchall()

    def update(self, iid: str, **fields: Any) -> None:
        if not fields:
            return
        fields.setdefault("updated", time.time())
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE incidents SET {cols} WHERE id = ?", (*[json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for v in fields.values()], iid))

    # ---- judgments ------------------------------------------------------------------

    def latest_judgment(self, iid: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM judgments WHERE incident = ? ORDER BY id DESC LIMIT 1", (iid,)).fetchone()

    def pending_judgments(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM judgments WHERE finished IS NULL AND invalidated = 0 ORDER BY id").fetchall()

    # ---- assignments ------------------------------------------------------------------

    def assignments(self, iid: str) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM assignments WHERE incident = ? ORDER BY n", (iid,)).fetchall()

    def open_assignments(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM assignments WHERE closed IS NULL ORDER BY id").fetchall()

    # ---- outbox -------------------------------------------------------------------------

    def enqueue(self, *, kind: str, text: str, marker: str, incident: str | None = None, channel: str | None = None,
                topic: str | None = None, recipients: list[int] | None = None, now: float | None = None) -> int:
        """One post, owed. The marker is unique: the same post is owed once."""
        row = self.db.execute("SELECT id FROM outbox WHERE marker = ?", (marker,)).fetchone()
        if row:
            return int(row[0])
        now = now or time.time()
        cur = self.db.execute(
            "INSERT INTO outbox (incident, kind, channel, topic, recipients, text, marker, state, next_try, created) VALUES (?, ?, ?, ?, ?, ?, ?, 'owed', ?, ?)",
            (incident, kind, channel, topic, json.dumps(recipients) if recipients is not None else None, text, marker, now, now))
        return int(cur.lastrowid)

    def outbox_due(self, now: float) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM outbox WHERE state IN ('owed', 'failed', 'uncertain', 'sending') AND next_try <= ? ORDER BY id", (now,)).fetchall()

    def outbox_row(self, oid: int) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM outbox WHERE id = ?", (oid,)).fetchone()

    def set_outbox(self, oid: int, **fields: Any) -> None:
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE outbox SET {cols} WHERE id = ?", (*fields.values(), oid))

    def outbox_counts(self) -> dict[str, int]:
        return {r[0]: r[1] for r in self.db.execute("SELECT state, count(*) FROM outbox GROUP BY state").fetchall()}

    # ---- samples -------------------------------------------------------------------------

    def cpu_samples(self) -> dict[str, float]:
        return {r[0]: float(r[1]) for r in self.db.execute("SELECT attempt, cpu FROM samples").fetchall()}

    def sample(self, attempt: str, cpu: float, now: float) -> None:
        self.db.execute("INSERT INTO samples (attempt, cpu, at) VALUES (?, ?, ?) ON CONFLICT(attempt) DO UPDATE SET cpu = excluded.cpu, at = excluded.at",
                        (attempt, cpu, now))

    def rows(self, sql: str, *args: Any) -> Iterator[sqlite3.Row]:
        return iter(self.db.execute(sql, args).fetchall())


class _Tx:
    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def __enter__(self):
        self.db.execute("BEGIN IMMEDIATE")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.db.execute("ROLLBACK" if exc_type else "COMMIT")
        return False
