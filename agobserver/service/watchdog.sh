#!/bin/sh
# The watchdog of Observer's workflow monitor and of the executor (observer p3):
# agobserver.watchdog, a process of its own. Settings: .local/workflow.toml.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .local/out
exec uv run python -m agobserver.watchdog
