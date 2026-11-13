"""What the workflow executor needs to know about this checkout.

`SPEC` is autolab as `agag.agent` resolves it: its short name and its root,
which locate `agents.toml` and the `.local/agents.local.toml` overlay.
"""

from __future__ import annotations

from pathlib import Path

from agag.agent import AgentSpec

AGAUTOLAB_ROOT = Path(__file__).resolve().parents[2]

SPEC = AgentSpec("autolab", AGAUTOLAB_ROOT)

__all__ = ["AGAUTOLAB_ROOT", "SPEC"]
