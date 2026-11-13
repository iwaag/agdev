"""Observer's agent spec: its instance, its local state and its roles.

Used by the workflow monitor (`wfmonitor`, observer p3) and its watchdog.
"""

from __future__ import annotations

from pathlib import Path

from agag.agent import AgentSpec

ROOT = Path(__file__).resolve().parents[2]

SPEC = AgentSpec("agobserver", ROOT)
