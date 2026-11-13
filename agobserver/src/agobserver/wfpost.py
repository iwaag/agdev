"""Delivering Observer's notices: owner messages to the alert sender, notes kept in the store.

observer p3, cluster_teamwork p5. Every notice — an incident note, a message
to the owners — is an outbox row first (`wfstore`). A message to the owners
is queued to the installation's alert sender (`alerting.tool()`, independent
of WFE; it retries and keeps what it cannot send) and the row becomes
`alerted`; without an alert route it stays `failed`, visible, and is tried
again. An incident note in Observer's own channel name is the incident's
record only: the row becomes `local` (its text and the store's events are the
note). Any other row — a recovery request of the retired Zulip route — is
`failed` with why; recovery requests are WFE submissions (`wfrecover`).
Delivery failure never stops observation and never erases an assignment.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from .wfstore import Store

BACKOFF = (15, 60, 300, 900)


def with_marker(text: str, marker: str) -> str:
    return f"{text.rstrip()}\n\n`{marker}`"


class Poster:
    def __init__(self, store: Store, alerts: Callable[[], Any] | None = None, log: Callable[[str], None] = print, local_channel: str | None = None):
        self.store = store
        self.alerts = alerts or (lambda: None)
        self.log = log
        self.local_channel = local_channel

    def _retry(self, row, now: float, state: str, error: str) -> None:
        tries = int(row["tries"]) + 1
        self.store.set_outbox(row["id"], state=state, tries=tries, error=error[:500], next_try=now + BACKOFF[min(tries - 1, len(BACKOFF) - 1)])

    def deliver(self, row, now: float | None = None) -> str:
        now = now or time.time()
        if row["kind"] == "dm":
            t = self.alerts()
            if t is None:
                self._retry(row, now, "failed", "no alert route is configured on this installation (agdevctl [alerts])")
                return "failed"
            ident = t.queue(severity="warning", event=f"observer:{row['marker']}", key=row["marker"], text=row["text"],
                            evidence=f"Observer incident {row['incident']} ({self.store.path})")
            self.store.set_outbox(row["id"], state="alerted", sent=now, error=None, tries=int(row["tries"]) + 1)
            self.store.event(row["incident"], "alerted", {"outbox": row["id"], "alert": ident})
            try:
                t.flush()
            except Exception as error:  # noqa: BLE001 - the spool keeps it; the watchdog retries
                self.log(f"post {row['id']}: alert queued, sending deferred: {error!r}")
            return "alerted"
        if row["kind"] == "channel" and (self.local_channel is None or row["channel"] == self.local_channel):
            self.store.set_outbox(row["id"], state="local", sent=now, error=None)
            self.store.event(row["incident"], "noted-locally", {"outbox": row["id"]})
            return "local"
        self._retry(row, now, "failed", f"no route for a {row['kind']} post to {row['channel']} (Zulip was retired)")
        return "failed"

    def flush(self, now: float | None = None) -> dict[str, int]:
        now = now or time.time()
        done: dict[str, int] = {}
        for row in self.store.outbox_due(now):
            state = self.deliver(row, now)
            done[state] = done.get(state, 0) + 1
        return done


def outbox_summary(store: Store) -> dict[str, Any]:
    counts = store.outbox_counts()
    oldest = store.db.execute("SELECT min(created) FROM outbox WHERE state IN ('owed', 'sending', 'failed', 'uncertain')").fetchone()[0]
    return {"counts": counts, "oldest_unsent": oldest}
