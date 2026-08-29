#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' 0 1 2 15
mkdir -p "$fixture/home/.petdex/runtime" "$fixture/bin"
printf 'test-token\n' > "$fixture/home/.petdex/runtime/update-token"
python3_path=$(command -v python3 || true)
if [ -n "$python3_path" ]; then
    test_path="$(dirname "$python3_path"):/usr/bin:/bin"
else
    test_path="/usr/bin:/bin"
fi

cat > "$fixture/bin/curl" <<'MOCK'
#!/bin/sh
while [ "$#" -gt 0 ]; do
    if [ "$1" = "--data" ]; then
        shift
        printf '%s\n' "$1" >> "$PETDEX_CAPTURE"
    fi
    shift
done
exit 0
MOCK
chmod +x "$fixture/bin/curl"

wait_for_marker() {
    marker=$1
    attempts=0
    while [ "$attempts" -lt 30 ]; do
        [ -f "$marker" ] && return 0
        attempts=$((attempts + 1))
        sleep 0.1
    done
    return 1
}

payload='{"session_id":"raw-turn","session_key":"gateway/session key","petdex_session_title":"Canonical title","last_assistant_message":"Remote answer"}'
printf '%s' "$payload" | HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant hermes

grep -Eq '"session_id":"[0-9a-f]{64}"' "$fixture/capture"
grep -q '"source_session_id":"raw-turn"' "$fixture/capture"
grep -q '"session_kind":"primary"' "$fixture/capture"

# A host may keep the stdin write end open after the JSON is complete. The
# remote hook must return within its bounded drain window instead of waiting
# for EOF indefinitely.
bounded_fifo="$fixture/bounded-input"
bounded_done="$fixture/bounded-done"
mkfifo "$bounded_fifo"
(
    HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
        PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant hermes
    : > "$bounded_done"
) < "$bounded_fifo" &
bounded_pid=$!
exec 3>"$bounded_fifo"
printf '%s' "$payload" >&3
if ! wait_for_marker "$bounded_done"; then
    echo "remote hook waited for EOF after a complete payload" >&2
    kill "$bounded_pid" 2>/dev/null || true
    exec 3>&-
    wait "$bounded_pid" 2>/dev/null || true
    exit 1
fi
exec 3>&-
wait "$bounded_pid"

# Silent stdin is bounded too; a disconnected or miswired host must not leave
# a remote shell process behind forever.
silent_fifo="$fixture/silent-input"
silent_done="$fixture/silent-done"
mkfifo "$silent_fifo"
(
    HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
        PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant hermes
    : > "$silent_done"
) < "$silent_fifo" &
silent_pid=$!
exec 4>"$silent_fifo"
if ! wait_for_marker "$silent_done"; then
    echo "remote hook waited for silent stdin" >&2
    kill "$silent_pid" 2>/dev/null || true
    exec 4>&-
    wait "$silent_pid" 2>/dev/null || true
    exit 1
fi
exec 4>&-
wait "$silent_pid"

# The transport-published Hermes home must drive hook-side canonical lookup
# even when the hook process itself does not inherit HERMES_HOME.
mkdir -p "$fixture/custom-hermes/profiles/snoop"
printf 'snoop\n' > "$fixture/custom-hermes/active_profile"
printf '%s\n' "$fixture/custom-hermes" > "$fixture/home/.petdex/runtime/hermes-home"
python3 - "$fixture/custom-hermes/profiles/snoop/state.db" <<'PY'
import sqlite3
import sys

with sqlite3.connect(sys.argv[1]) as database:
    database.execute(
        "CREATE TABLE sessions (id TEXT, title TEXT, display_name TEXT, source TEXT, model_config TEXT, parent_session_id TEXT, session_key TEXT)"
    )
    database.execute(
        "INSERT INTO sessions VALUES (?,?,?,?,?,?,?)",
        ("custom-raw", "Custom server title", "", "primary", "{}", "", "custom-key"),
    )
PY
payload='{"session_id":"custom-raw","last_assistant_message":"Custom answer"}'
printf '%s' "$payload" | HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant hermes
tail -n 1 "$fixture/capture" | grep -q '"session_id":"custom-key"'
tail -n 1 "$fixture/capture" | grep -q '"title":"Custom server title"'

# Remote metadata is untrusted text even though the transport is authenticated.
# Controls, quotes, and backslashes must not escape the compact JSON body or
# create a second synthetic field when the shell interpolates it.
python3 - <<'PY' | HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant hermes
import json
import sys

json.dump(
    {
        "session_id": "custom-raw",
        "last_assistant_message": 'Line one\nLine two "quoted" \\ path\x7f end',
    },
    sys.stdout,
)
PY
python3 - "$fixture/capture" <<'PY'
import json
import sys

event = json.loads(open(sys.argv[1], encoding="utf-8").read().splitlines()[-1])
assert "Line one" in event["text"] and "Line two" in event["text"]
assert "quoted" in event["text"] and "path" in event["text"]
assert all(ord(char) >= 32 and ord(char) != 127 for char in event["text"])
assert '"' not in event["text"] and "\\" not in event["text"]
PY

# Explicit worker metadata must be suppressed even without state.db, while the
# primary fixture above proves missing provider state no longer suppresses all
# Hermes sessions.
before=$(wc -l < "$fixture/capture")
payload='{"session_id":"child","petdex_conversation_key":"parent","petdex_session_kind":"subagent","last_assistant_message":"noise"}'
printf '%s' "$payload" | HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant hermes
after=$(wc -l < "$fixture/capture")
test "$before" -eq "$after"

# Codex child identity lives in the rollout prefix rather than session_index.
# A child Stop hook must be suppressed too; otherwise it can recreate the very
# standalone card that the rollout watcher filtered out.
mkdir -p "$fixture/home/.codex/sessions/2026/08/13"
python3 - "$fixture/home/.codex" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
parent = "00000000-0000-0000-0000-000000000001"
child = "00000000-0000-0000-0000-000000000002"
(root / "session_index.jsonl").write_text(
    json.dumps({"id": parent, "thread_name": "Parent conversation"}) + "\n",
    encoding="utf-8",
)
rollout = root / "sessions" / "2026" / "08" / "13" / f"rollout-test-{child}.jsonl"
rollout.write_text(
    json.dumps(
        {
            "type": "session_meta",
            "payload": {
                "id": child,
                "thread_source": "subagent",
                "source": {"subagent": "worker"},
                "parent_thread_id": parent,
                "agent_nickname": "worker",
            },
        }
    )
    + "\n",
    encoding="utf-8",
)
PY
before=$(wc -l < "$fixture/capture")
payload='{"session_id":"00000000-0000-0000-0000-000000000002","last_assistant_message":"child done"}'
printf '%s' "$payload" | HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble stop codex
after=$(wc -l < "$fixture/capture")
test "$before" -eq "$after"

# The corresponding primary remains publishable and keeps its server title.
payload='{"session_id":"00000000-0000-0000-0000-000000000001","last_assistant_message":"parent done"}'
printf '%s' "$payload" | HOME="$fixture/home" PATH="$fixture/bin:/usr/bin:/bin" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble stop codex
tail -n 1 "$fixture/capture" | grep -q '"title":"Parent conversation"'
