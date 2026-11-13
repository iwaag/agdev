"""The installation's alert sender, as Observer and its watchdog reach it (cluster_teamwork p5).

The sender is not part of this package: it is the installation's own
`agdev_alert.py` (installed with the lifecycle tool, outside the releases),
named by `AGDEV_ALERT_TOOL`, with its configuration in `AGDEV_ALERTS`. It
imports nothing of WFE and needs no Zulip. Absent either, there is no alert
route here and callers keep what they did before.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType

_tool: ModuleType | None = None


def tool() -> ModuleType | None:
    """The sender module when this installation has an alert route, else None."""
    global _tool
    path = os.environ.get("AGDEV_ALERT_TOOL")
    if not path or not Path(path).is_file():
        return None
    if _tool is None:
        spec = importlib.util.spec_from_file_location("agdev_alert", path)
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _tool = mod
    return _tool if _tool.configured() else None
