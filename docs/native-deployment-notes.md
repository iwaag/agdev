# Native core and containerized dependencies: preparation notes

History: the design handoff written before the mixed deployment was implemented. The
current account is [install.md](install.md); the sections below may name things that have since moved
(`install/image` is now `install/runtime`).

## Runtime and accounts

The runtime image specifies Node 24.22.2, uv 0.11.21 and Claude Code 2.1.302,
plus Python 3, venv, Git, certificates, curl, jq, lsof, make, OpenSSH client,
procps, ripgrep, rsync, sqlite3, tar, unzip and xz. Use explicit paths and
per-component Python environments. Record installed versions and the source
revision in release metadata. The executor runs as an unprivileged, B-owned
account with a separate home and model credentials; WFE and monitoring accounts
also need only the data they use. Host login credentials are not automatically
available to this account. Service units and the lifecycle supervisor need their
own limited permissions and must not give the executor blanket sudo, production
credentials, shared mounts or hypervisor administration credentials.

Time-dependent units should invoke `install/image/wait-clock.py` as the service
user with an account-writable status directory before starting. A service manager's
boot ordering alone does not prove the kernel clock is synchronized. Preserve
waiting diagnostics, monitoring grace periods, durable update state and independent
notification. An on-host watchdog cannot detect loss of the entire VM or its parent.

## Third-party services

The existing Compose pins Zulip 12.2, Gitea 1.27.1 and PostgreSQL 14, plus
Redis, RabbitMQ and Memcached. Retain and verify those service definitions,
image versions, isolated networks, volumes, provisioning commands and credentials
as the starting point. Publish the endpoints required by the native core on
explicit host addresses and ports, and ensure the native service accounts resolve
and reach B's own services. The existing web proxy is also a container; choose
and test how it reaches native WFE and hangout, rather than assuming Docker's
internal service-name routing still works.

Size the VM for the combined Docker dependencies, native core, builds and a real
agent attempt; a dependency's minimum requirement alone is not a capacity test.
Verify boot and restart behavior, image availability and actual service health.
The lifecycle administrator may use Docker for B's dependencies. The executor
and ordinary agents must not inherit Docker administration.
## Work required in agdevctl

- Retain instance-scoped Compose generation, image/volume/network inventory and
  provisioning for Gitea, Zulip and their dependency containers. Replace core
  container execution and Docker-specific core paths with native systemd units,
  accounts, configuration and paths. Keep inputs, identity and secrets explicit.
- Adapt release build and switch: build under the selected account without Docker,
  use native paths instead of `/agdev` mounts, record tool and source revisions,
  and select an immutable release shared by WFE, executor and monitors.
- Adapt start, stop, status, inventory and removal to actual units, accounts,
  dependency containers, networks, volumes, packages and data ownership.
  Distinguish installation-owned resources from shared OS packages and Docker
  resources; never remove unrelated services.
- Adapt lifecycle supervision, drain, restart order and health checks for native
  core units and Compose-managed dependencies. Keep the durable request/outcome record, instance checks, clock gate,
  update recovery and owner notification. Verify health through the actual CLI,
  HTTP and Observer after a switch.
- Repeat bootstrap, auth, reboot, clock-delay, failure, recovery, isolation,
  resource-pressure, removal and recreation trials on the combined deployment.
  The earlier container and native probes do not validate the complete stack.
