# agdev

The core of agdev: a system where agents develop projects through workflow runs, on machines
you own. This repository holds the core; the projects an installation develops, and the reasons it
has them, live elsewhere.

- **WFE** (`workflow_editor/`): the service, CLI (`wfe`) and browser UI: projects, workflows, runs,
  conversations, the execution queue and coordination.
  [README](workflow_editor/README.md); contracts in [its docs](workflow_editor/docs/).
- **Executor** (`agautolab/`): claims queued work and launches the agent a workflow names in the run's
  own working copy. People and other installations reach work through WFE (conversations, run views,
  direct delegation, HTTP peers).
- **Observer and watchdog** (`agobserver/`): watch every run, open durable incidents, ask a recovery
  workflow to recover, verify recovery, and tell the owners what recovery cannot reach.
  [Contract](agobserver/docs/workflow.md).
- **Installation** (`install/`, `scripts/wfe-release.sh`): an input-driven installation with a native
  core under systemd (Linux) or the user's LaunchAgents (macOS), a Gitea of its own in Docker or an
  existing one, a lifecycle service for updates, remote operation of a candidate installation
  (`agdev-remote`) and owner alerts independent of WFE.
- **External publication** (`install/agdev-external-publish`): an edited public derivative of a
  project's repositories, with its own history. [Guide](docs/external-publication.md).

## Getting started

1. On the host that will run it (Ubuntu 24.04 is the tried case), clone this repository, run
   `install/prepare-host`, make the core's bundle and write your `instance.toml`:
   [From GitHub, on a new Linux host](docs/install.md#from-github-on-a-new-linux-host). The
   installation's own Gitea then holds the core; `pyagag` comes from GitHub when the release is
   built ([PROVENANCE.md](PROVENANCE.md)).
2. Run the setup steps of [docs/install.md](docs/install.md#the-steps) (`init` … `install-lifecycle`)
   and log the model harness in. [Transfer to a new owner](docs/transfer.md) and
   [adopting an existing installation's state](docs/migration.md) are separate guides.
3. Receive the summoner: `agdevctl bootstrap-projects`. With no plan yet, it applies the core's
   one reference, `install/bootstrap/summonplan.yaml`: the summoner
   ([iwaag/pj-summoner](https://github.com/iwaag/pj-summoner)) at an exact commit.
4. Say what you want: write a braindump (for example "reproduce iwaag's development style and
   start developing") and request `summoner/propose` with it. It reads catalogs of shared projects
   such as [iwaag/agdev-mind](https://github.com/iwaag/agdev-mind) (warden, ponderer and
   aghangout, public at `iwaag/pj-warden`, `iwaag/pj-ponderer`, `iwaag/pj-aghangout`), proposes a
   summonplan with its reasons, asks you, and applies it once you agree
   ([docs/install.md](docs/install.md), [workflow_editor/docs/summon.md](workflow_editor/docs/summon.md),
   [workflow_editor/docs/mind.md](workflow_editor/docs/mind.md)). A plan of your own works too:
   `agdevctl bootstrap-projects --plan <summonplan>`.

## What has been tried

On one Linux VM (Ubuntu 24.04, x86-64, 4 vCPU, 8 GiB RAM) the whole stack ran; a laptop (Ubuntu)
ran a candidate; a Mac (macOS 26, Apple silicon) ran two installations side by side and rehearsed
adopting a large installation's state. These are single runs by the author, not independent
reproductions. Measurements and what is not covered: [docs/install.md](docs/install.md#what-has-been-tried).

## Notes for a reader

- Some documents cite development episode labels (for example `summoner p2`); that
  development history is not published.
- `agent/` holds the guides the core's own agents use; they describe a development setup of one
  main installation with children, which is one way to run it.
- Provenance and what was left out: [PROVENANCE.md](PROVENANCE.md). Licence: CC0 1.0 ([LICENSE](LICENSE)).
