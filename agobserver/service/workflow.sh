#!/bin/sh
# Observer over workflow runs (observer p3): agobserver.wfmonitor, settings in
# .local/workflow.toml, Zulip credentials in .local/zulip.env.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .local/out
exec uv run python -m agobserver.wfmonitor
