# agautolab

agautolab is the executor of workflow runs managed by the workflow editor
(WFE, `workflow_editor/` of this repository). A person asks for a run (WFE run view,
conversation, or `wfe request`); WFE records
it and queues it; this process claims it and launches the agent the workflow
names, in the run's own copy of the project. Workflow definitions and run
state belong to WFE and the managed projects, not to this checkout.

The old development system that lived here — the Zulip listener with its
`workplan-`/`workrun-`/`bmining-` topics, missions and tasks, mission working
copies, the `:8791` gateway window and the `autolab` CLI — was retired in
`retire/old_autolab` (devdocs episode). Nothing here receives work outside WFE.

## Modules

- `agautolab.wfexec` — one execution node (worker) of the WFE coordinator:
  `worker` in its settings names it (project_migration p7; WFE
  `docs/workers.md`). On the coordinator's host it is the local worker; on
  another PC, its `wfe` is
  the coordinator's client. It claims the admitted jobs of its node (`wfe
  exec claim`; since improve_wfrun p4 what may start is warden's coordination
  decision, WFE `docs/coordination.md`, and the executor holds as many
  attempts at once as were admitted), launches each workflow's agent behind a
  launch gate with the request and delivery destination, the short common
  contract (`agent/guides/wfrun/guide.md`), the run's scoped context and its
  brief, reports how each process ended, carries out stops per attempt,
  reports its host's measured load with every heartbeat, and reconciles
  vanished processes every minute. `lanes = ["coordination"]` makes it serve
  the coordination lane as a loop of its own. Sessions, launch ownership and
  every state rule are described in its module docstring; the rules
  themselves live in WFE.
- `agautolab.instance` — the root, the bot credential path and `SPEC`, which
  `agag.agent` resolves the `wfrun` role through.

## Configuration

- `agents.toml` (`ag.agent-config.v2`): the models and profiles a workflow may
  select with `execution.profile` (`sonnet`, `luna`, …; Agent ≠ Model) and
  the `wfrun` role with its tool grant.
- `.local/agents.local.toml`: host overlay (harness commands, provider URLs,
  secret file paths).
- `.local/wfexec.toml`: `wfe` = the launcher argv; `worker` = this node's
  id; `lanes` = the extra lanes it serves (the coordination lane on the
  coordinator's host); optional `agent_command` replaces the harness for
  trials. (Older files may still have `[notify]`/`[intake]` tables; they are
  ignored since cluster_teamwork p5 removed the Zulip transports.)

## Running

```bash
uv run python -m agautolab.wfexec          # the loop (launchd: com.agdev.agautolab-wfexec)
uv run python -m agautolab.wfexec --once   # until nothing is left to do (trials)
```

The launchd template is `pj-agdev/devenv/launchd/com.agdev.agautolab-wfexec.plist.in`
(`agent/wfexec.sh`). Restart it only between attempts: a restart ends the
running agent's process, which WFE records as an interruption.

The installation's Gitea (`install/`) is where WFE creates managed
projects' repositories.

## Execution guide

The initial prompt includes the fixed request text and its delivery route before the common guide. Detailed operational notes live in `agent/guides/wfrun/reference/`; the prompt names their absolute directory on the execution host, so they can be read from any run copy. The offered contract includes their hashes: changing a note invalidates session reuse under the old contract. Ordinary continuations retain WFE's compact continuation prompt.

The common guide and notes ship with this repository; deploy the whole checkout to every executor host. Project context and WFE's current-state brief are still supplied unchanged. Historical rationale for the replacement is recorded in the development episode `unslop_guides/p1`; it is not injected into agent prompts.
