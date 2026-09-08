#!/bin/sh
set -eu

# Opt-in end-to-end transport test. It exercises the built desktop binary
# against an isolated SSH host without consuming a hosted CI runner.
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=${PETDEX_TEST_BINARY:-${1:-$root/zig-out/bin/petdex-desktop-native}}
pet=${PETDEX_TEST_PET:-$HOME/.petdex/pets/boba}
fixture=$(mktemp -d)
container=petdex-ssh-test-$$
app_pid=
xvfb_pid=
launch_count=0

cleanup() {
    if [ -n "$app_pid" ]; then
        kill "$app_pid" 2>/dev/null || true
        wait "$app_pid" 2>/dev/null || true
    fi
    if [ -n "$xvfb_pid" ]; then
        kill "$xvfb_pid" 2>/dev/null || true
        wait "$xvfb_pid" 2>/dev/null || true
    fi
    docker rm -f "$container" >/dev/null 2>&1 || true
    rm -rf "$fixture"
}
on_signal() {
    trap - 0 1 2 15
    cleanup
    exit 143
}
trap cleanup 0
trap on_signal 1 2 15

command -v docker >/dev/null
command -v ssh >/dev/null
command -v ssh-keygen >/dev/null
command -v xdpyinfo >/dev/null
test -x "$binary"
test -r "$pet/pet.json"

if [ -z "${DISPLAY:-}" ] || ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    command -v Xvfb >/dev/null
    display_file=$fixture/xvfb-display
    Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp 3>"$display_file" >"$fixture/xvfb.log" 2>&1 &
    xvfb_pid=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        test -s "$display_file" && break
        kill -0 "$xvfb_pid" 2>/dev/null || break
        sleep 1
    done
    if [ ! -s "$display_file" ]; then
        cat "$fixture/xvfb.log" >&2
        echo "Xvfb did not publish a display" >&2
        exit 1
    fi
    DISPLAY=:$(sed -n '1p' "$display_file")
    export DISPLAY
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
        sleep 1
    done
    xdpyinfo -display "$DISPLAY" >/dev/null 2>&1
fi

pet_name=$(basename "$pet")
mkdir -p "$fixture/.petdex/pets" "$fixture/.ssh"
cp -R "$pet" "$fixture/.petdex/pets/$pet_name"
chmod 700 "$fixture/.ssh"
ssh-keygen -t ed25519 -N '' -f "$fixture/.ssh/ci_petdex" -q

docker run -d --name "$container" -p 127.0.0.1::22 ubuntu:24.04 sleep infinity >/dev/null
docker exec "$container" bash -lc \
    'apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server curl python3 procps >/dev/null && useradd -m -s /bin/bash petdex && mkdir -p /run/sshd /home/petdex/.ssh'
docker cp "$fixture/.ssh/ci_petdex.pub" "$container:/tmp/ci_petdex.pub" >/dev/null
docker exec "$container" bash -lc \
    'cat /tmp/ci_petdex.pub > /home/petdex/.ssh/authorized_keys && chown -R petdex:petdex /home/petdex/.ssh && chmod 700 /home/petdex/.ssh && chmod 600 /home/petdex/.ssh/authorized_keys && ssh-keygen -A >/dev/null'
docker exec -d "$container" /usr/sbin/sshd -D -e

mapping=$(docker port "$container" 22/tcp | head -n 1)
port=${mapping##*:}
identity=$fixture/.ssh/ci_petdex
known_hosts=$fixture/.ssh/known_hosts
remote="ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new -oUserKnownHostsFile=$known_hosts -oConnectTimeout=8 -p $port -i $identity -- petdex@127.0.0.1"

for _ in 1 2 3 4 5 6 7 8 9 10; do
    # shellcheck disable=SC2086
    $remote true >/dev/null 2>&1 && break
    sleep 1
done
# shellcheck disable=SC2086
$remote true

# Seed real foreign configuration and a named Hermes profile. The reconnect
# pass must merge these files rather than replacing them, and must patch only
# the active profile instead of the configured Hermes root.
# shellcheck disable=SC2086
$remote 'sh -s' <<'REMOTE_SETUP'
set -eu
mkdir -p ~/.petdex/runtime ~/.codex ~/.hermes-ci/profiles/snoop
cat > ~/.codex/hooks.json <<'JSON'
{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"my-own-codex-hook"}]}]}}
JSON
cat > ~/.codex/config.toml <<'TOML'
[features]
foreign_feature = true
TOML
cat > ~/.hermes-ci/config.yaml <<'YAML'
root_marker: preserve-root
YAML
printf 'snoop\n' > ~/.hermes-ci/active_profile
cat > ~/.hermes-ci/profiles/snoop/config.yaml <<'YAML'
model: foreign-model
hooks:
  pre_tool_call:
    - my-own-hermes-hook
YAML
cat > ~/.hermes-ci/profiles/snoop/shell-hooks-allowlist.json <<'JSON'
{"approvals":[{"event":"pre_tool_call","command":"my-own-hermes-hook"}]}
JSON
# A stale PID file belonging to an unrelated process must never be killed by
# quiesce. The verified watcher will replace the marker after it owns the lock.
nohup sleep 120 >/dev/null 2>&1 &
unrelated=$!
printf '%s\n' "$unrelated" > ~/.petdex/runtime/unrelated.pid
printf '%s\n' "$unrelated" > ~/.petdex/runtime/codex-watch.pid
REMOTE_SETUP

printf '%s\n' \
    "{\"remotes\":[{\"name\":\"loopback\",\"host\":\"petdex@127.0.0.1\",\"port\":$port,\"identity_file\":\"$identity\",\"agents\":{\"opencode\":{\"enabled\":true},\"codex\":{\"enabled\":true},\"hermes\":{\"enabled\":true,\"home\":\"~/.hermes-ci\"}}}]}" \
    > "$fixture/.petdex/remote-agents.json"

start_app() {
    launch_count=$((launch_count + 1))
    printf '\n=== launch %s ===\n' "$launch_count" >> "$fixture/app.log"
    HOME=$fixture PETDEX_PET=$pet_name "$binary" >> "$fixture/app.log" 2>&1 &
    app_pid=$!
}

wait_ready() {
    ready=false
    for _ in $(seq 1 60); do
        # shellcheck disable=SC2086
        if $remote 'test -s ~/.petdex/runtime/update-token && test -s ~/.petdex/runtime/codex-watch.pid && test -s ~/.petdex/runtime/hermes-watch.pid'; then
            ready=true
            break
        fi
        kill -0 "$app_pid" 2>/dev/null || break
        sleep 1
    done
    if [ "$ready" != true ]; then
        cat "$fixture/app.log" >&2
        echo "remote feed never became ready" >&2
        exit 1
    fi
}

wait_stopped() {
    stopped=false
    stable=0
    for _ in $(seq 1 24); do
        # shellcheck disable=SC2086
        if $remote 'test ! -e ~/.petdex/runtime/update-token && test ! -e ~/.petdex/runtime/tunnel-lease && test ! -e ~/.petdex/runtime/codex-watch.pid && test ! -e ~/.petdex/runtime/hermes-watch.pid && ! pgrep -f "petdex-(codex|hermes)-watch" >/dev/null' &&
            ! ps -axo command= | grep -F "$identity" | grep -F '127.0.0.1:7777:127.0.0.1:7777' | grep -v grep >/dev/null; then
            stable=$((stable + 1))
            if [ "$stable" -ge 3 ]; then
                stopped=true
                break
            fi
        else
            stable=0
        fi
        sleep 1
    done
    if [ "$stopped" != true ]; then
        cat "$fixture/app.log" >&2
        ps -axo pid,ppid,pgid,stat,command | grep -E "ssh-tunnel-supervisor|${identity}|127.0.0.1:7777:127.0.0.1:7777" | grep -v grep >&2 || true
        # shellcheck disable=SC2086
        $remote 'ls -la ~/.petdex/runtime; ps -ef | grep -E "petdex|sshd" | grep -v grep' >&2 || true
        echo "remote transport survived desktop shutdown" >&2
        exit 1
    fi
}

start_app
wait_ready

# shellcheck disable=SC2086
$remote 'test "$(stat -c %a ~/.petdex)" = 700 && test "$(stat -c %a ~/.petdex/runtime)" = 700 && test "$(stat -c %a ~/.petdex/runtime/update-token)" = 600 && grep -q my-own-codex-hook ~/.codex/hooks.json && grep -q petdex-hook ~/.codex/hooks.json && grep -q foreign_feature ~/.codex/config.toml && grep -q my-own-hermes-hook ~/.hermes-ci/profiles/snoop/config.yaml && grep -q petdex-hook ~/.hermes-ci/profiles/snoop/config.yaml && grep -q my-own-hermes-hook ~/.hermes-ci/profiles/snoop/shell-hooks-allowlist.json && grep -q preserve-root ~/.hermes-ci/config.yaml && grep -qx "$HOME/.hermes-ci" ~/.petdex/runtime/hermes-home && kill -0 "$(cat ~/.petdex/runtime/unrelated.pid)"'
# shellcheck disable=SC2086
$remote 'curl -fsS --max-time 2 http://127.0.0.1:7777/health' | grep -q '"ok":true'
printf '%s\n' '{"tool_name":"Bash","session_id":"docker-ci"}' | \
    $remote '~/.petdex/bin/petdex-hook bubble pre codex'

# Capture the merged activation files. A complete reconnect must be
# byte-idempotent: no duplicate hooks and no serialization drift.
# shellcheck disable=SC2086
first_hashes=$($remote 'sha256sum ~/.codex/hooks.json ~/.codex/config.toml ~/.hermes-ci/profiles/snoop/config.yaml ~/.hermes-ci/profiles/snoop/shell-hooks-allowlist.json')

kill "$app_pid"
wait "$app_pid" 2>/dev/null || true
app_pid=
wait_stopped

# Reconnect to the same already-patched host. The state machine must run its
# full gated verification again without changing merged user configuration.
start_app
wait_ready
# shellcheck disable=SC2086
second_hashes=$($remote 'sha256sum ~/.codex/hooks.json ~/.codex/config.toml ~/.hermes-ci/profiles/snoop/config.yaml ~/.hermes-ci/profiles/snoop/shell-hooks-allowlist.json')
if [ "$first_hashes" != "$second_hashes" ]; then
    printf '%s\n' "$first_hashes" "$second_hashes" >&2
    echo "remote reconnect was not config-idempotent" >&2
    exit 1
fi

# A hard crash cannot run normal effect teardown. The supervisor and recurring
# tunnel health guard must still reap ssh, revoke the token/lease, and let both
# watchers remove their own PID files.
kill -9 "$app_pid"
wait "$app_pid" 2>/dev/null || true
app_pid=
wait_stopped

# shellcheck disable=SC2086
$remote 'kill "$(cat ~/.petdex/runtime/unrelated.pid)" 2>/dev/null || true; rm -f ~/.petdex/runtime/unrelated.pid'

echo "remote Docker transport: passed"
