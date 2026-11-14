# Installing and operating an agdev installation

An installation is one agdev: its WFE, executor, Observer, watchdog, web origin and
lifecycle service on one host, with a Gitea. The core (WFE, executor and its
agents, Observer, watchdog) runs natively from an installed release, under systemd on
Linux or as the user's LaunchAgents on macOS. The web origin (nginx) runs in Docker.
Gitea is either the installation's own, in Docker, or an existing service it attaches to
([Attached Gitea](#attached-gitea)). People work with it through WFE's conversation and run views; the
owner's alerts go to a destination of their own ([Alerts](#the-owners-alerts)). There is no chat
service: Zulip was retired.
Everything specific to it comes from one input file and is generated under its root;
nothing here names a host. On Linux, run agents inside a VM dedicated to the installation:
the VM is their isolation boundary.

Requirements: a host name that browsers, the host and its service accounts resolve, Docker,
and Python 3.11+ for `agdevctl`. Linux x86-64: `install/prepare-host` (root) installs Docker,
system packages and the pinned Node, uv and Claude Code at versioned, root-owned paths.
macOS: see [macOS](#macos-launchd); the tools are the user's own and `[tools]` names them.

## What goes where

| Thing | Place | Owner |
| --- | --- | --- |
| Inputs | `instance.toml` (see `install/instance.example.toml`) | root |
| Display name, parent, Boast links (generated into `area/site.json`) | `[display]` in `instance.toml` | root |
| Instance id, generated Compose env, service env files, the installed `agdevctl` and clock gate | `<root>/config/`, `<root>/config/install/` | root |
| Secrets | `<root>/config/secrets/` (mode 0700), `compose.env` (0600) | root |
| Operating area: registry, stores, area configuration | `<root>/data/area/` | core account, group-writable |
| Workspaces (projects), with their run copies and records | the project root: `[projects] root`, default `<root>/projects/`; may be another volume | core account |
| Source checkout the operator installs from (optional) | `<root>/source/`: never what runs | the operator |
| Service logs (macOS) | `<root>/logs/<service>.log` | the user |
| Releases and the `wfe` launcher | `<root>/data/area/service/`, `bin/` | build account, not group-writable: a run does not edit what runs by accident |
| Executor and WFE state, Gitea credential | `<root>/data/state/{agautolab,gitea,system}/` (0700) | core account |
| Observer state | `<root>/data/state/agobserver/` (0700) | monitor account |
| Alert spool and its destination credential | `<root>/data/state/alerts/` (2770) | monitor account |
| Shared area for message files and published outputs (`agshare`) | `<root>/data/share/agshare/` (standalone), or the parent's NFS export mounted at `/mnt/agshare` ([storage.md](storage.md)); outside the area | core account |
| Update requests, outcomes, clock status | `<root>/data/lifecycle/` | root; core group writes `requests/` and `status/` |
| Model harness login and caches | the core account's home; survives releases and restarts | core account |
| Source bundles (the core's) | `<root>/bundles/`; a removal keeps them | root |
| Who fills the core's roles, from the applied summonplan | `<root>/data/area/roles.json` (`wfe summon status`); the mind repository on Gitea holds the plan | core account |
| Mirrors of summoned sources, the apply journal | `<root>/data/area/.local/summon/` | core account |
| Gitea data | Docker volumes named `agdev-<slug>_*`, listed by `agdevctl inventory`; none for an attached service | Docker |

Accounts. WFE, the executor and its agents share one account, because the `wfe` CLI that
agents run writes the same stores and Git copies as the service; separating them would
need broad permissions and protect nothing. Observer and the watchdog have their own: they
reach the area through the core group (`wfe observe` opens the WAL stores) and keep their state and
credential private, so an agent cannot edit the monitor's records. The build account owns
releases and has no secrets. None of the three is in `docker`, `sudo` or `adm`; `init` refuses
one that is. Docker administration belongs to `agdevctl` and the lifecycle service, which run as root.
Services run with umask 0002, so the group can share the stores and nginx can read aghangout's release.

A release is code only: `area/service/releases/<core commit>/` holds the built WFE
and, under `system/`, the executor and Observer of the same commit with their own
environments and `install/` resources. `service/current` selects one for every service.
`RELEASE.json` records the commits and tool versions.

## Setup

### From GitHub, on a new Linux host

The shortest path, on the host itself. The installation's own Gitea then holds the core, and the
installation develops it from there. Tried once end to end: a Proxmox VM from the
Ubuntu 24.04 cloud image, 4 vCPU, 8 GiB, 64 GB disk, DHCP on the home LAN; about 5 minutes from
`apt-get` to a healthy core.

Before you start:

- an Ubuntu 24.04 x86-64 host (a VM is the agents' isolation boundary) with about 4 vCPU, 8 GiB
  and 60 GB free, and a user that can `sudo`;
- outbound access to GitHub, the Ubuntu archive, nodejs.org, the npm registry and Docker Hub;
- a Claude account for the model login (a browser on any machine is enough);
- a host name that the host itself and your browsers resolve to its LAN address. On a home LAN
  without your own DNS, mDNS (`<hostname>.local`, avahi, below) does it.

```sh
sudo apt-get install -y git python3 avahi-daemon libnss-mdns
# mDNS on the LAN interface only: otherwise avahi also answers with Docker's bridge address,
# and the host resolves its own name to 172.17.0.1
IF=$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p')
sudo sed -i "s/^#\?allow-interfaces=.*/allow-interfaces=$IF/" /etc/avahi/avahi-daemon.conf
sudo systemctl restart avahi-daemon
getent ahostsv4 "$(hostname).local"            # must print the LAN address

git clone https://github.com/iwaag/agdev ~/agdev && cd ~/agdev
sudo install/prepare-host                      # Docker, packages, Node, uv, Claude Code under /opt/agdev-tools
sudo mkdir -p /srv/agdev/config                # the installation root; any path
sudo install/make-bundles --core . --out /srv/agdev/bundles
sudo cp install/instance.example.toml /srv/agdev/config/instance.toml
sudoedit /srv/agdev/config/instance.toml
```

In `instance.toml`, change:

| Key | To |
| --- | --- |
| `slug` | a short name, e.g. `g`; it scopes units, containers and volumes |
| `root` | `/srv/agdev` (the folder above) |
| `public_host` | the name above, e.g. `<hostname>.local` |
| `[owner]` `name`, `full_name`, `email` | the Gitea account `provision-gitea` creates for you; it owns the repositories (the email is only Gitea's) |
| `[execution]` `timezone` | yours, e.g. `Asia/Tokyo` |
| `[display]` `name` | what the pages call this installation |

Everything else can stay: the ports, the accounts (created by `init`), and `[tools]`, whose paths
are the versions `prepare-host` installs (its last lines print them; change them only if they
differ). Leave `[source]` out: the core is built from `<owner>/agdev` on this installation's Gitea,
which `import-sources` fills from the bundle. Leave `[alerts]` out unless you have a Slack bot
token; without it, owner notices are kept, unsent, in the Observer's outbox (its health record
counts them). `pyagag`, the one external dependency, is fetched from GitHub when the release is
built. Then, still in the clone:

```sh
C=/srv/agdev/config/instance.toml
sudo install/agdevctl --config $C init         # installs its own copy into /srv/agdev/config/install/
A="sudo /srv/agdev/config/install/agdevctl --config $C"
$A up infra && $A provision-gitea && $A import-sources && $A area-init
$A activate main                               # builds the release from this Gitea, starts everything
$A install-lifecycle
$A status                                      # every service running; urls
# the model login, once, as the core account (follow the URL it prints in any browser):
sudo -u agdev-exec -H env PATH=/opt/agdev-tools/claude-2.1.302/bin:/opt/agdev-tools/node-v24.22.2/bin:/usr/bin:/bin claude auth login
$A bootstrap-projects --dry-run && $A bootstrap-projects      # the summoner arrives
```

From here everything is in the browser. The WFE page is `http://<public_host>:8082/wfe/`, the
conversation page `http://<public_host>:8082/hangout/`, and Gitea `http://<public_host>:8080/` (the
owner's password is in `/srv/agdev/config/secrets/gitea_owner_password`). On the WFE page: write
what this machine is for in the system context (*Context overview* → *Context for all projects*), then request
`summoner/propose` with your wish (project **summoner** → *Request a run*), as below. The `wfe` CLI,
if you want it, is `sudo -u agdev-exec /srv/agdev/data/area/bin/wfe`.

To take a newer public core later: `git pull` in the clone, push it to `<owner>/agdev` on this
Gitea (`git push http://<owner>@<public_host>:8080/<owner>/agdev.git main`, the owner's password),
then `$A activate main`.

### The steps

```sh
# On a machine with the core repository: the core's bundle (projects are summoned, not bundled).
install/make-bundles --core . [--core-ref <rev>] --out <bundles>
# Transfer <bundles> to <root>/bundles, unpack the core's tree beside them and write
# <root>/config/instance.toml. On the host, as root:
install/prepare-host
install/agdevctl --config <instance.toml> init       # accounts, folders, identity, secrets, units
A="<root>/config/install/agdevctl --config <instance.toml>"
$A up infra
$A provision-gitea
$A import-sources
$A area-init
$A activate main      # builds and checks the release under the build account, starts the core and the web origin
$A install-lifecycle
```

Every step can be repeated after an interruption; what exists is kept. The installation
now holds the core only, and works: no role is filled yet (below). Then log the model
harness in as the core account and verify:

```sh
sudo -u <core account> -H env PATH=<claude bin>:<node bin>:/usr/bin:/bin claude auth login
sudo -u <core account> -H env PATH=<claude bin>:<node bin>:/usr/bin:/bin claude auth status
```

The stack works without this, but no agent can run. Finally, the projects arrive from a
summonplan ([workflow_editor/docs/summon.md](../workflow_editor/docs/summon.md)). A new
installation starts with the **summoner**, the one project the core refers to
(`install/bootstrap/summonplan.yaml`: its public URL and exact commit):

```sh
$A bootstrap-projects --dry-run   # no plan yet: the core's reference becomes plan <slug>; shows the one entry
$A bootstrap-projects             # the summoner is acquired, registered and obtained; it fills no role
```

Then say what you want. Write a braindump, for example "reproduce iwaag's development style
and start developing", and request the summoner's `propose` workflow with it, in the WFE page
(project **summoner** → *Request a run* → `propose`) or:

```sh
wfe request propose --workspace summoner --author <you> --braindump <file>
```

The run reads your braindumps, the installation's plan and the catalogs your wish points at
(`<user>/agdev-mind`, `catalog.yaml`; it knows `iwaag/agdev-mind`), proposes a revised plan
with the reasons for each project, and asks you. When you agree, it adds your wish to the mind
as a braindump, writes the plan and runs `wfe summon apply`. The observer takes the recovery role
from `area/roles.json` at its next look; nothing needs a restart.

With a plan of your own instead:

```sh
$A bootstrap-projects --plan <summonplan.yaml> --dry-run   # what would arrive and which roles it fills
$A bootstrap-projects --plan <summonplan.yaml>
```

It creates or attaches the mind repository (`wfe mind init`), writes the plan there as
`summonplans/<name>.yaml` and names it in `mind.json`, then runs `wfe summon apply`: each
`summoned` entry is acquired from its source into this Gitea at its commit (with history
and submodules), registered and obtained; the roles are recorded in `area/roles.json`, the
keys they own in `workers.json`, `conversations.json` and `submitters.json` follow, the
conversation page is deployed, and the Observer follows the recovery role in `roles.json`.
Without `--plan` it applies the plan the mind repository names, or, when it names none, the
core's reference above; repeating it continues an interrupted apply. A source that needs a credential to read takes it from `agdev-cred`
(an active `gitea-token` entry whose target is the source's origin).

Until a plan fills them, the roles are absent: no recovery (the Observer tells the owner),
one attempt per lane (no coordination), and conversations and the conversation page say
which role is not filled. No installation stays there: recovery and coordination are part
of normal operation. `wfe summon status` shows who fills what.

## Operation

`agdevctl --config <instance.toml> status` reports native units, containers, clock state per
service, release, drain and last update. `stop [service…]`, `start [service…]`, `up infra|core|all`,
`inventory`. Native service logs: `journalctl -u agdev-<slug>-<service>`. The Compose file has
no core services, so no generic start can revive a containerized core beside the units.
Do not run Docker prune commands on a shared host; `remove` names this installation's resources exactly.

The web origin proxies `/wfe/` to the native WFE through the container's host gateway
(`agdev-core`), and maps `area/hangout` read-only for `/hangout/`.

The executor unit has `KillMode=process`: restarting it leaves running agents alone and the
next executor adopts them (`wfe exec adopt`). `stop` on the executor therefore does not stop agents;
a run's stop does, and `remove` kills whatever is left in the unit.

`remove --confirm-instance <id> [--keep-evidence <folder>] [--purge-accounts]` disables and deletes
the units, then the containers, networks, volumes and `config`, `data`, `logs` of this
installation, and keeps `bundles`, the tools and, unless purged, the accounts with their homes
(model login, caches). Pulled dependency images stay. Run `export-sources` first: Gitea is the
development authority, and its current `main` is lost otherwise. Recreating is the setup
above; it generates a new instance id. Only `main` of each repository survives in the bundles
(see [What has been tried](#what-has-been-tried)).

## Where projects go

`[projects] root` (default `<root>/projects`) is where WFE creates and obtains workspaces
(`area/placement.json`, `workflow_editor/docs/placement.md`). Under the root it is created;
elsewhere, for example another volume, it must already exist and is never created, so an
unmounted volume is refused rather than replaced by an empty folder. A marker file names the
area that owns it; another installation's root is a collision. Change it with
`agdevctl placement` after editing the input: what exists stays where it is until
`wfe workspace relocate` moves it (a verified copy; the source is kept). Runs live inside
their workspace and move with it. Workspaces need not share a volume.

## macOS (launchd)

On macOS (`service_manager = "launchd"`, the default there) the installing user is the
installation: `core`, `monitor` and `build` in `[accounts]` must all name that user, and
`agdevctl` runs as that user without `sudo`. The native services and the lifecycle service
are LaunchAgents `com.agdev.<slug>.<service>` in `~/Library/LaunchAgents`, started at the
user's login (`RunAtLoad`) and restarted when they exit (`KeepAlive`); the executor's agent
has `AbandonProcessGroup`, so its agents survive an executor restart as with `KillMode=process`.
A written agent stays disabled until its service is first started. `stop` unloads a service
until the next `start` or login. Logs are `<root>/logs/<service>.log`. The clock gate reads
the kernel's NTP state (`ntp_adjtime`).

Boundary: there is no account separation. Agents, WFE, the monitors and the builds share the
user's account, its keychain (the model login) and its Docker. That is the accepted model of a
personal workstation; an installation that needs separation belongs on Linux.

`[tools]` names the user's Node, uv and Claude Code folders, and `python` a Python 3.11+ folder
put first in `PATH` (the system `/usr/bin/python3` may be older). Persistence needs the user to
be logged in (automatic login after a power loss is the host's setting).

## Attached Gitea

`[dependencies] gitea = "external"` attaches to a Gitea that exists and is someone else's (an
existing installation's, or shared). Its inputs are explicit:

- `[gitea] url, owner, token_file`: `provision-gitea` checks that the token acts as `owner` and
  keeps a copy in `config/secrets`. It creates no account; `import-sources` imports nothing and
  only reports manifest repositories missing there.

`up`, `start`, `stop` and `remove` act only on this installation's Compose project, which then
holds only the web origin: an attached Gitea is never started, stopped or removed, and naming
it is refused. The core's `[source]` is independent of both.

## The owner's alerts

**Alerts** reach the owner independently of WFE through `runtime/agdev_alert.py`, installed
with the lifecycle tool (outside releases):

```toml
[alerts]
route = "slack"
token_file = "<root>/config/secrets/alert_slack_token"   # a Slack bot token with chat:write
channel = "<the owner's DM channel or member id>"
```

`services-config` renders `<state>/alerts/alerts.json` and a private token copy for the monitor
account. The watchdog (Observer's and the executor's health, every 30 s), Observer's owner notices
and the lifecycle's update outcomes queue alerts there (`agdev.alert.v1`: instance, severity, event,
occurrence/recovery, time, text, evidence path); a transient failure stays queued with backoff, a
refusal stays visible and is retried hourly, nothing is dropped. `agdevctl alerts` shows the route and
what is owed (also in `agdevctl status` and the watchdog's `watchdog.json`); `agdevctl alerts
--diagnostic` sends one alert labelled as a diagnostic. Without `[alerts]` the watchdog, Observer and
the lifecycle only write their records (`watchdog.json`, Observer's store, `lifecycle/updates/`).

Who may submit work to WFE as a machine requester (Observer's recovery requests) is `<area>/submitters.json`;
which workspace a project's delegations and submissions go to when it has several here is
`<area>/workspaces.json` (`area-init` writes both).

`agdevctl render --out <new folder>` writes what the inputs make — service settings, units or
LaunchAgents, and a `summary.json` of the infrastructure and alert route —
without touching anything live: compare it with the running files before applying a change.

New-instance initialization (`area-init`, `bootstrap-projects`) writes fresh
area configuration where none exists. Continuing an existing installation's state on the same
Gitea is a different operation: [migration.md](migration.md).

## Two installations on one host

Each has its own slug, root, ports (`[ports]` web, wfe, the presentation range `present`, and
gitea when owned), Compose project, LaunchAgents or units, logs, locks (`WFE_LOCK_DIR` in
its state) and project root. `init` refuses a slug whose agents belong to another root and a project
root that another area owns, and refuses ports in use. Stopping, starting, updating or removing one
names only its own services.

## Time

Services that reason about time (WFE, executor, Observer, watchdog) start through
`install/runtime/entry.sh`, which gates on the kernel's clock status (`adjtimex` on Linux,
`ntp_adjtime` on macOS). Ordering a unit after
time-sync would prove nothing and could hold the boot target; here the unit counts as started and
holds nothing else up. While waiting each one writes why to its journal and to
`lifecycle/status/clock-<service>.json`, shown by `status`. The wait has no bound while time is
really unavailable; it is never unexplained. The lifecycle service also acts on no request until
the clock is synchronized. Gitea only stores time and is not gated. Observer and the
watchdog start 60 s after the gate so a boot does not read as an outage.

## Source

`[source] url` names the Git repository the core is built from. Without it, an installation builds from
`<owner>/agdev` on its own Gitea and is its own development authority. An installation built from another
host's repository names it instead (the main installation and its children: the canonical repository on the main installation's Gitea; a candidate: its
development host's) (`url = "http://<host>:<port>/<owner>/agdev.git"`, optionally
`token_file`, a path on the host, when that repository needs a credential to read). Its own Gitea then holds
no copy of the core: `import-sources` and `export-sources` skip it, so its
Gitea serves only its local managed work.

The lifecycle keeps a bare mirror of every branch of the source in `<root>/data/sources/core.git`,
fetched before each resolution. Update records carry `source` beside the built `release`.

Changing `[source] url` (for example to move an installation from one parent's repository to the canonical one): edit the
file; the lifecycle service restarts itself between updates to read it (older releases' services need
`systemctl restart agdev-lifecycle-<slug>`). Each fetch names the configured URL and prunes, so branches only
the old source had leave the mirror; the mirror's `origin` remote is not used. Copy the mirror first if
those branches hold unique work.

## Updating

A request names one exact commit; a branch name is refused, and a branch that moves later changes
nothing. From a run on the installation itself (the executor's environment names the lifecycle folder):

```sh
agdev-update request <commit> --reason <why>    # resolved to the full hash here; prints an id; then end your run
agdev-update status [<id>]
```

This adopts a commit on the installation the run is on, so it is the last step of a change that was
first tried on a candidate installation (next section). `agdev-update` also records `onBranch: main`:
the commit must be on `main` of the source, which makes the adopted release integrated work.

The request is a file; the lifecycle service (`agdev-lifecycle-<slug>`), outside the
replaceable runtime, performs it. It refuses a request for another instance id, then:

0. `awaiting-requester` (only for a request made from an attempt of this installation, which records
   `run` and `attempt`): the service waits until the requesting attempt has ended and the run, looked up in
   this installation's execution store by attempt id, has no other open attempt. The wait is bounded
   (6 hours, counted from the recorded `awaitingSince`, so a restart of the service resumes it and does not
   extend it); past the bound, or if the attempt is not in the execution store, the update ends `failed`
   with the reason. The open attempts waited for are kept in `awaitingFor`. Requests that arrive meanwhile
   stay as files in `requests/` and are taken in order after this one ends. A request without an attempt,
   including every request from another installation, skips this state.
1. `building`: fetches the source and checks that the commit is there (and on `onBranch` when the request
   names one). A request from an attempt retries within 5 minutes, because the run's work reaches the
   source only after its attempt ends; otherwise the update ends `failed` naming the commit, and nothing
   is built or switched. It then builds and checks that release under the build account, at low priority,
   with no Docker access and no area environment. A failure changes nothing in use and is recorded.
2. `draining`: holds `area/.local/exec/drain`, so the executor starts no new attempt,
   and waits for all open attempts of any run of this installation.
3. `stopping`: copies the execution store, records its integrity and whether the store
   code changed between the releases; stops watchdog, Observer, executor, WFE; switches
   the release, CLI, installed lifecycle tool, Compose resources and units together.
4. `starting`: releases the drain, starts WFE and web, executor, Observer and watchdog, and
   checks the API, the CLI, the instance id, the executor's heartbeat and that Observer has
   looked through the new release. Gitea and its state are not touched: a dependency
   upgrade is its own explicit change. It ends `succeeded` and tells the owner, naming the requesting
   installation and run when the request came from another installation.

The new lifecycle tool takes over when the service is next between updates: it sees the installed
copy changed, exits, and systemd restarts it. An update left mid-way continues from its
recorded state under whichever version resumes it.

State is durable at each transition. A restart of the service continues from the recorded
state, and the outcome reaches the owner directly, through the alert sender. There is no automatic
rollback: a failed health check leaves the release selected, with evidence in
`lifecycle/updates/<id>.json` and a store copy in `lifecycle/backups/<id>/`. A person or the
development host repairs with `agdevctl` (or `agdev-remote repair`), or by deploying another commit.

## Managing a child installation over the agdev link

An installation can be the operational parent of another and update it without shell access to it
(contract and recovery: `workflow_editor/docs/management.md`).

1. **Prerequisites (operator, once per host):** the installation is installed and healthy; the link realm,
   channel and one bot per installation exist (`workflow_editor/docs/peers.md`, *Setting up a link*); each
   bot's credential file is on its host, readable by the core account, outside Git; the child's `[source]`
   names the repository the parent publishes to, readable without the parent's credentials.
2. **Inputs:** copy `install/link-setup.example.json` to a host file outside Git. On the child list the parent
   with `"parentage": "parent", "grant": ["observe", "update"]`; on the parent the child with
   `"parentage": "child", "manage": ["observe", "update"]`.
3. **Enroll:** `wfe peer setup --inputs <file>` as the core account on both hosts; repeat (or
   `wfe peer check`) until `complete … mutual` on both. Repeating changes nothing.
4. **Observe:** `wfe manage status <child>` on the parent: *FRESH* (sample and receipt times), *STALE* or *unknown*.
5. **Update:** publish the exact commit to `main` of the child's source, then on the parent
   `wfe manage update <child> <full hash> --reason TEXT --by WHO`; follow it with `wfe manage show <op>` until
   `completed, verified` (or `failed …`, `refused …`). An operation without news is *unknown*, never failed;
   it is asked about again by itself.
6. **Recovery** of an unresponsive child is the operator's, on its host (`agdevctl status`, the update record in
   `data/lifecycle/updates/`, `agdevctl start`, `agdevctl activate <previous release>`).

The child's lifecycle builds only commits on `[management] branch` (default `main`); `[management]
peer_updates = false` refuses peer requests.

## Developing against a candidate installation

A development host runs the development workflows and stays on its release while a change is tried. A
candidate is a separate installation, on its own host, with its own identity, services, credentials, stores
and projects, built from the development host's source (`[source]`), whose owner designated it as
disposable for trials. The development host's runs operate it with `agdev-remote` (help: `agdev-remote
--help`); the candidate's own runs are not theirs, and it is not one of the development host's execution
workers.

**Choosing a candidate is explicit.** An installation takes `deploy` only with `[remote] candidate = true` in
its own `instance.toml`; on the development host its `[targets.<name>]` has `role = "candidate"` (the
default). A node with durable work (projects, history, a parent that manages it) is not a candidate because it
is enrolled or reachable: its `[targets.<name>]` entry, if any, is `role = "recovery"` — `identity`, `status`,
`update`, `logs`, `repair` — and its releases come through its parent (`wfe manage update`). Making one a
candidate again is the owner's decision, recorded in both files. A
change without a candidate is checked as `agent/guide.md` says before it is adopted.

Setting a candidate up, once:

```sh
# On the candidate, as root: who may operate it ([remote] candidate = true in its instance.toml for deploys).
# The key comes from the development host (next step); prints the candidate's host keys.
agdevctl --config <candidate's instance.toml> remote-access --key-file <development host's public key>
# On the development host: [targets.<name>] in instance.toml (host, instance = the candidate's id,
# host_key = one line printed above, optional user, web, role), then, as root:
agdevctl --config <its instance.toml> target <name>     # key of its core account, pinned host key, config/targets.json
agdevctl --config <its instance.toml> start executor    # or any restart: the executor's environment gains AGDEV_TARGETS
```

The key runs only `agdevctl remote` on the target (forced command; sudoers allows exactly that command).
Each request is one JSON document and names the instance id the caller expects; the target answers with
its own id and refuses an effect for any other (`identity-mismatch`, nothing changed). The remote entry
reads only the target's config, never the caller's `AGDEV_*` or `WFE_*` environment.

| Operation | Effect on the target |
| --- | --- |
| `identity`, `status`, `update <id>` | none |
| `logs <service>` | none; journal of the native units and the lifecycle service, container logs of the rest |
| `deploy <rev>` | candidates only (`not-a-candidate` otherwise, nothing changed; `agdev-remote` refuses a `recovery` target before publishing). Pushes `candidate/<12 hex>` to the source, then writes a lifecycle request for that exact commit. The id is made and journaled by the caller before sending; a repeated id returns the existing request and never makes a second update |
| `repair start/stop/restart <services>` | the native units, the web container or the lifecycle service; works while the target's WFE or executor cannot start |

The candidate's lifecycle performs a deploy as any request without an attempt: it does not wait for or look
up the caller's run, it drains its own open attempts, and it switches only itself. The caller's run may keep
working and read the outcome later with `agdev-remote update`. No answer (exit 3) means the outcome is
unknown: ask again by id. An unavailable target cannot drain, stop or change the caller.

Adoption: integration adds a checkpoint commit, so `main` differs from the tried candidate.
`agdev-remote same-runtime <candidate> <commit>` says whether the runtime trees (`workflow_editor`,
`agautolab`, `agobserver`, `install`, `scripts`) are the same; if they are not, try that commit on the
candidate too. Then `agdev-update request <commit>` adopts it on the development host, and a later run checks
it on the new release.

## Instance identity

`config/instance-id` is generated once and kept across a move of the same installation.
`area/instance.json` carries it, and services get it as `AGDEV_INSTANCE_ID`. `wfe` refuses
to act when the two differ (exit 3); `GET api/version`, `wfe version` and `wfe observe` report
it; the worker API refuses a client that names another instance; the lifecycle service
refuses another instance's request. It catches a wrong destination. It is not authentication.

## Display name and parent

`[display]` in `instance.toml` is the source of truth for what Home and the browser title show
(`workflow_editor/docs/site.md`): `name`, and optionally `[display.parent]` and
`[display.boast_links.<project>]`. Host-specific values stay in that file, outside the source.

```toml
[display]
name = "agdev-example"
```

`area-init` generates `area/site.json` from it on a fresh installation. For an installed one, edit the
file and run `agdevctl display`: it validates, writes `site.json` and refuses a bad value without changing
anything. WFE reads the file on each request, so no restart is needed. An update, restart or `activate`
does not write it. An installation with no `[display]` shows "Unnamed agdev" and says why.

The Gitea link comes from the generated `gitea.json`. The display name and
the instance id are separate: renaming changes no identity check.

## What has been tried

On one VM with 4 vCPU, 8 GiB RAM and 4 GiB swap, the whole stack ran.

- A release build takes 30 to 45 minutes.
- A release build and a full agent check together peaked at load 24, with at least 3.2 GiB
  available and no swap used; the API stayed under 15 ms.
- A removal and recreation from `export-sources` bundles, with a new slug and root, took about
  40 minutes and kept the accounts and the model login.

A development host and a candidate: the VM above as the development
host, and a laptop (16 threads, 15 GiB RAM, 0.5 GiB swap, Ubuntu 24.04) as the candidate built from
the VM's repository.

- On the laptop a release build takes about 18 minutes, peaking at load 15 with at least 9.8 GiB
  available and no swap. A deploy from the host, request to `succeeded`, took 20 minutes; a commit
  whose release already exists switches in about a minute.
- The candidate came back by itself after a reboot, its old containerized core gone.
- A run on the host developed a change, deployed and observed it on the candidate, and was adopted
  afterwards; a wrong instance id, a lost answer and a candidate that cannot start were tried.

The first activation of a release by an older lifecycle tool is performed by that older tool: what the
new release changes in the generated units or the build's inputs takes effect only once the new tool
writes them (its next update, `agdevctl target`/`display`, or a by-hand `activate`). Seen twice: the
executor lacked `AGDEV_TARGETS` after the host adopted the remote tools, and the first release record
on the candidate lacked its source.

Those bundles carry only `main` of each repository. Run branches, the execution store and Observer's records do not travel; they are lost with the removed installation.

What is not covered: nothing notifies the owner while the clock gate holds the monitors, or
while the alert destination (Slack) is unreachable — alerts then stay queued. Both show in `agdevctl status`, so look there. Whole-VM or
parent loss has no independent check.

A Mac: macOS 26.2, Apple silicon, 32 cores, OrbStack for Docker.

- Two installations ran at once under one user's LaunchAgents, one with its own Gitea and Zulip and one
  attached to them with its projects on another volume. Release builds took about 18–25 minutes (two
  at once). Stopping or updating one left the other's processes as they were.
- Unspecified, launchd throttles an agent: the lifecycle agent's release checks failed their timing
  bounds until it ran as `ProcessType Standard`.
- Adopting a snapshot of a 108 GB, 2.4 M-file area with 22 workspaces took about 16 minutes on one
  APFS volume (clones); a 78 GB workspace copied to another volume at about 400 MB/s.

A Mac's production handed over: the predecessor was a hand-made installation with no
instance id (22 workspaces, 108 GB, 2.4 M files, 1411 attempts), on its own existing Gitea and (then) Zulip.

- Downtime was 16 minutes: quiescence, `:8093` released, ports switched (`activate --no-start` after editing
  them), adoption straight from the quiesced area (stores 0.4 s, files 32 s, relocation by APFS clone 848 s),
  start. Every workspace's Git state, every store's counts and Observer's records were equal afterwards.
- Continuity held through the ordinary entrances: a resting conductor answered from its old conversation, held and
  reviewed runs kept their state, intake cursors went on from where they were, run and job numbers continued,
  Observer opened incidents only for new interruptions, a hand-made chat front continued on the copied store, the run
  backup continued the predecessor's generations, and the remote worker reconnected to the same URL unchanged.
- The Linux check of the same candidate found two defects the Mac could not: a test that called the host's
  `launchctl`, and the services' lock folder under root's `state` that nothing made.
- Hand-made pieces remain hand-made: a chat front's and the run backup's LaunchAgents, and the authoring entry
  (`area/authoring`, written by `scripts/wfe-release.sh authoring`), which `agdevctl` does not write.

## Boundaries

- Agents run under the core account: no Docker group or socket, no sudo (`NoNewPrivileges`), and
  no access to `/home`, secrets or Observer's state. They share an account with WFE and the executor,
  so they can read the Gitea token and this installation's bot credential, and could signal those
  processes (systemd restarts them). Because the core account owns the area, it could also rename
  `service/` or `bin/` inside it: their ownership stops accidents, not a hostile agent. Isolation
  from other installations is the VM.
- Whole-VM or parent loss: the watchdog runs on the same host and cannot report it.
  No independent availability check exists.
- Shared hosts: all names and ports are scoped by the inputs; only the VM above has been tried.
