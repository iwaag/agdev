# Provenance

## Relation to the development authority

The core is developed in a private Gitea repository of its owner's installation, which is its
development authority. This public repository is an **edited derivative with its own history**: its
first commit is a single root commit with no earlier history, and later commits are made by an
explicit publication step. A public commit's message names the internal commit it was made from.
Text that only makes sense inside the owner's installation (hosts, accounts, run records, episode
history) is left out or generalized, so this tree is not a mirror and contains no development
history. Changes made here are kept by the publication tool and may be imported back by hand.

## Origin of the code

The development repository's first commit imported, without their Git history, the WFE service
(`workflow_editor/`, `scripts/wfe-release.sh`), the executor (`agautolab/`) and the workflow monitor
(`agobserver/`) from earlier repositories. All are CC0 1.0 (`LICENSE`). Those repositories are
retired and nothing here follows them.

External source dependency: **pyagag**, github.com/iwaag/pyagag, pinned to
`03a2a325e8f0a9392f69275b1253d95ab67a360d` by both `uv.lock` files (CC0 1.0). It is read at build
time from GitHub.

## Intentionally left behind

| Source | Why |
| --- | --- |
| The earlier site front, `agentroom`, a Slack integration | No screen of the core; `/hangout/` and `/wfe/` are served by `install/web`. |
| agobserver's retired chat-channel conversation monitor and its watch listener | Only the workflow monitor and watchdog run. |
| Retired or optional tools | A notifier for ComfyUI is added only where an installation has ComfyUI. |
| Cluster inventory and host-management tooling | Cluster management is a managed project, not part of an installation. |
| Every run store, conversation, incident and credential | State of one installation; an installation starts from `install/` and exact source revisions. |
| Development episode notes and run records, the showcase page | History written for one installation; no outside reader needs it. |

Projects an installation develops (warden, ponderer, aghangout, …) are separate repositories with
their own development; they are summoned from a summonplan, not part of this tree.

The core refers to one project by URL and exact commit, not by content: the summoner, in
`install/bootstrap/summonplan.yaml` (`https://github.com/iwaag/pj-summoner`). It is fetched when an
installation runs `agdevctl bootstrap-projects` without a plan of its own.
