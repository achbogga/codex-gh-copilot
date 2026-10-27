#!/bin/bash
# The same deterministic launcher is used by cron and interactive checks.
set -u
export PATH=/home/aboggaram/.local/bin:/usr/local/bin:/usr/bin:/bin
export TZ=Etc/UTC
unset DOCKER_HOST DOCKER_CONTEXT BUILDX_BUILDER
cleanup_limit=6h
cleanup_nice=15
cleanup_io=(-c 3)
for cleanup_arg in "$@"; do
    if [[ "$cleanup_arg" == --pressure ]]; then
        # Pressure recovery must make progress while builds are doing I/O.
        cleanup_limit=30m
        cleanup_nice=10
        cleanup_io=(-c 2 -n 7)
    fi
done
/usr/bin/timeout --signal=TERM --kill-after=60s "$cleanup_limit" \
    /usr/bin/nice -n "$cleanup_nice" /usr/bin/ionice "${cleanup_io[@]}" \
    /usr/bin/python3 -u /home/aboggaram/.local/lib/dev-cache-cleanup/cleanup.py "$@"
cleanup_exit=$?
if (( cleanup_exit != 0 )); then
    printf 'dev-cache-cleanup exited %s; inspect ~/.local/state/dev-cache-cleanup/daily.log\n' "$cleanup_exit" >&2
fi
exit "$cleanup_exit"
