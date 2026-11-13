#!/usr/bin/python3
"""Wait until the kernel says the clock is synchronized; say why while waiting.

The kernel's NTP status (adjtimex, STA_UNSYNC) is what timedatectl reports and
needs nothing mounted, so a container restored by the Docker daemon before
timesyncd has synchronized waits here instead of concluding that heartbeats are
stale or credentials expired. A real wait with no NTP available has no bound:
what is bounded is how long it stays unexplained. The state is written to
<status>/clock-<service>.json and to the log, and `agdevctl status` shows it.
"""
import ctypes
import datetime
import json
import os
import sys
import time

STA_UNSYNC = 0x0040


class Timex(ctypes.Structure):
    # struct timex (x86-64): modes, offset, freq, maxerror, esterror, status, ...
    _fields_ = [
        ("modes", ctypes.c_uint), ("offset", ctypes.c_long), ("freq", ctypes.c_long),
        ("maxerror", ctypes.c_long), ("esterror", ctypes.c_long), ("status", ctypes.c_int),
        ("_reserved", ctypes.c_byte * 512),
    ]


class NtpTimex(ctypes.Structure):
    # macOS struct timex (sys/timex.h): modes, offset, freq, maxerror, esterror, status, ...
    _fields_ = [
        ("modes", ctypes.c_uint), ("offset", ctypes.c_long), ("freq", ctypes.c_long),
        ("maxerror", ctypes.c_long), ("esterror", ctypes.c_long), ("status", ctypes.c_int),
        ("_reserved", ctypes.c_byte * 512),
    ]


def synchronized() -> bool:
    if sys.platform == "darwin":
        # The kernel's NTP state as timed keeps it: ntp_adjtime, read only (agedev_selfassembly p4).
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        timex = NtpTimex()
        timex.modes = 0
        state = libc.ntp_adjtime(ctypes.byref(timex))
        return state != -1 and not (timex.status & STA_UNSYNC)
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    timex = Timex()
    timex.modes = 0  # read only: needs no capability
    state = libc.adjtimex(ctypes.byref(timex))
    return state != -1 and not (timex.status & STA_UNSYNC)


def write_state(path: str, state: dict) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "w") as out:
            json.dump(state, out)
        os.replace(path + ".tmp", path)
    except OSError as error:
        print(f"agdev-wait-clock: cannot write {path}: {error}", file=sys.stderr, flush=True)


def main() -> int:
    if "--check" in sys.argv:   # agdevctl status and the lifecycle service: one look, exit 0 when synchronized
        return 0 if synchronized() else 1
    service = os.environ.get("AGDEV_SERVICE", "service")
    folder = os.environ.get("AGDEV_STATUS_DIR", "/agdev/lifecycle/status")
    path = f"{folder}/clock-{service}.json"
    report_every = int(os.environ.get("AGDEV_CLOCK_REPORT_SECONDS", "30"))
    # monotonic: the wall clock is exactly what cannot be trusted here.
    began = time.monotonic()
    last = None
    while not synchronized():
        waited = int(time.monotonic() - began)
        if last is None or waited - last >= report_every:
            last = waited
            print(f"agdev-wait-clock: {service} waits for clock synchronization ({waited}s so far); "
                  f"the wall clock reads {datetime.datetime.now(datetime.timezone.utc).isoformat()} and is not trusted. "
                  "Check the host's time service and network.", file=sys.stderr, flush=True)
            write_state(path, {"service": service, "state": "waiting", "waitedSeconds": waited,
                               "wallClockUntrusted": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        time.sleep(2)
    write_state(path, {"service": service, "state": "synchronized", "waitedSeconds": int(time.monotonic() - began),
                       "at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
