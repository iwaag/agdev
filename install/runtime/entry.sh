#!/bin/sh
# Every time-dependent native service starts through this, from its systemd unit.
# The gate is inside the service's start, not in unit ordering: the unit counts as
# started, so a clock that never synchronizes holds no boot target and no unrelated
# administration, and the wait stays visible in its status file and journal.
set -eu
if [ "${AGDEV_CLOCK_GATE:-1}" = "1" ]; then
  /usr/bin/python3 "$(dirname "$0")/wait-clock.py"
fi
# A monitor looks after what it watches has had time to report: a boot is not an outage.
sleep "${AGDEV_START_DELAY:-0}"
exec "$@"
