"""One judgment of one uncertain workflow attempt, on this host's model.

observer p3 step 3. Code decides what facts can decide: a dead process, an
open tool call inside its declared timeout, a log or CPU that moved. What is
left is an attempt that is alive, silent and not visibly inside a command —
a long computation that writes nothing, or a harness that hung? That needs
someone to read the evidence, and this is it: a compact packet of the facts
WFE observed (never a chat log), the guide, and one answer — `waiting`,
`stalled` or `unclear` — with the evidence it rests on.

A failed run is an answer (`unclear`), never an exception. The exact prompt
and its input are kept beside the transcript, so a verdict can be asked
again on the same input.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agag.agent import AgentSpec, run_role
from agag.topics import generation_dir, guide, next_generation, next_record_path, prompt_with_guide, topic_workspace

ROLE = "wftriage"
GUIDES = Path(__file__).resolve().parents[2] / "agent" / "guides"
RESULT_FILE = "result.json"
VERDICTS = ("waiting", "stalled", "unclear")
TIMEOUT_SECONDS = 150.0
MAX_TURNS = 4


def triage_prompt(incident: str, fact: str, evidence: dict[str, Any], seconds: dict[str, float]) -> str:
    lines = [
        f"Incident {incident}: an attempt of a workflow run is alive but not evidently working.",
        "",
        f"What the code concluded: {fact}",
        "",
        "Elapsed (seconds): " + ", ".join(f"{k} {v:.0f}" for k, v in seconds.items()),
        "",
        "The facts WFE observed (`wfe observe`), as JSON:",
        "",
        "```json",
        json.dumps(evidence, ensure_ascii=False, indent=1)[:12000],
        "```",
    ]
    return prompt_with_guide(lines, guide(GUIDES, ROLE, "guide.md"))


def _parse(workspace: Path, output: str) -> dict[str, Any]:
    path = workspace / RESULT_FILE
    for text in (path.read_text(encoding="utf-8") if path.is_file() else "", output):
        stripped = (text or "").strip()
        candidates = [stripped] + [b.split("\n", 1)[1] if b.lstrip().lower().startswith("json") else b for b in stripped.split("```")[1::2]]
        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and parsed.get("verdict") in VERDICTS:
                return parsed
    return {}


def judge(spec: AgentSpec, incident: str, fact: str, evidence: dict[str, Any], seconds: dict[str, float]) -> dict[str, str]:
    """`{"verdict": waiting|stalled|unclear, "evidence": …, "workspace": …}`. Never raises."""
    topics = topic_workspace(spec.topics_root, spec.instance_name(), f"wf-{incident}")
    workspace = generation_dir(spec.topics_root, spec.instance_name(), f"wf-{incident}", next_generation(topics), ROLE)
    prompt = triage_prompt(incident, fact, evidence, seconds)
    try:
        (workspace / "prompt.md").write_text(prompt, encoding="utf-8")
        (workspace / "input.json").write_text(json.dumps({"incident": incident, "fact": fact, "evidence": evidence, "seconds": seconds}, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass
    try:
        output, _record, exit_code = run_role(
            spec, ROLE, prompt, cwd=workspace, timeout=TIMEOUT_SECONDS,
            record=next_record_path(spec.records_root / ROLE), transcript=workspace / "transcript.jsonl", stream=True,
            extra_args=["--max-turns", str(MAX_TURNS), "--deadline-s", str(TIMEOUT_SECONDS - 20)],
            extra_meta={"incident": incident},
        )
    except Exception as error:  # noqa: BLE001 - a failed judgment is an answer
        return {"verdict": "unclear", "evidence": f"the judgment could not run: {error}", "workspace": str(workspace)}
    if exit_code != 0:
        return {"verdict": "unclear", "evidence": f"the judgment ended with exit code {exit_code}", "workspace": str(workspace)}
    parsed = _parse(workspace, output)
    if not parsed:
        return {"verdict": "unclear", "evidence": "the judgment produced no verdict", "workspace": str(workspace)}
    return {"verdict": str(parsed["verdict"]), "evidence": " ".join(str(parsed.get("evidence") or "").split())[:800], "workspace": str(workspace)}
