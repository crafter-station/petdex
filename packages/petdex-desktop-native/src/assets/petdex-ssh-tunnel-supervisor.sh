#!/bin/sh
# Keep an ssh reverse tunnel bounded by the Petdex desktop process even
# when the GUI is terminated by a signal and cannot run effects teardown.
# The shell remains the effect-owned process and runs ssh as its one child.
# This avoids a detached watcher inheriting the effect's output pipes: when
# ssh exits, the shell reaps it and exits with the same status so Petdex can
# enter its normal reconnect backoff.

parent=$1
shift

"$@" </dev/null &
tunnel=$!

# Native owns this supervisor process, not the ssh child. During an orderly
# application shutdown Native terminates the supervisor directly, so reap the
# child from signal handlers as well as from the parent-liveness loop. Without
# this trap ssh survives as an orphan and keeps the remote runtime alive.
cleanup_tunnel() {
    trap - 0 1 2 15
    kill "$tunnel" 2>/dev/null || true
    wait "$tunnel" 2>/dev/null || true
}

handle_signal() {
    cleanup_tunnel
    exit 143
}

trap cleanup_tunnel 0
trap handle_signal 1 2 15

parent_alive() {
    kill -0 "$parent" 2>/dev/null || return 1
    # kill -0 still succeeds for an unreaped zombie (notably when a launcher
    # shell has not waited yet). Treat Z as exited so the SSH child cannot be
    # stranded until that launcher itself terminates.
    state=$(ps -o stat= -p "$parent" 2>/dev/null) || return 1
    case "$state" in *Z*) return 1 ;; esac
    return 0
}

while parent_alive && kill -0 "$tunnel" 2>/dev/null; do
    sleep 1
done

if ! parent_alive; then
    kill "$tunnel" 2>/dev/null || true
fi

status=0
wait "$tunnel" || status=$?
trap - 0 1 2 15
exit "$status"
