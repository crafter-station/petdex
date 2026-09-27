#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' 0 1 2 15
mkdir -p "$fixture/home/.petdex/runtime" "$fixture/bin"
printf 'test-token\n' > "$fixture/home/.petdex/runtime/update-token"
printf 'configured-alias\n' > "$fixture/home/.petdex/runtime/remote-host"
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
grep -q '"hostname":"configured-alias"' "$fixture/capture"

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

# Hermes' background-review fork fires the same pre_llm_call hook as a real
# turn, with its own review prompt as the user message. It must never seed a
# title or reach the hook server, and it must not damage the earlier sessions.
before=$(wc -l < "$fixture/capture")
printf '%s' '{"session_id":"custom-raw","user_message":"Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update."}' \
| HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble user-prompt hermes
after=$(wc -l < "$fixture/capture")
test "$before" -eq "$after"
test ! -f "$fixture/home/.petdex/runtime/sessions/custom-raw.title"

# The fork also reuses the parent session id and points at it as its own
# parent, which catches its prompt-less hooks (assistant/approval).
printf '%s' '{"session_id":"custom-raw","parent_session_id":"custom-raw","assistant_response":"Nothing to save."}' \
| HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant hermes
after_self_parent=$(wc -l < "$fixture/capture")
test "$before" -eq "$after_self_parent"

# A user turn that merely opens with the same words stays visible, and so does
# a genuinely parented worker whose parent is a different session.
printf '%s' '{"session_id":"custom-raw","user_message":"Review the conversation above and tell me which decisions we settled on."}' \
| HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble user-prompt hermes
after_user_prompt=$(wc -l < "$fixture/capture")
test "$after_user_prompt" -gt "$before"
grep -q '"title":"Custom server title"' "$fixture/capture"

before=$after_user_prompt
printf '%s' '{"session_id":"child","parent_session_id":"parent","last_assistant_message":"worker done"}' \
| HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant hermes
test "$before" -lt "$(wc -l < "$fixture/capture")"

python3 - "$root/src/assets/petdex-remote-hook.sh" "$fixture" "$test_path" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

script, fixture, test_path = sys.argv[1:]
fixture = Path(fixture)
capture = fixture / "capture"
cache = fixture / "home" / ".petdex" / "runtime" / "sessions"
environment = {
    **os.environ,
    "HOME": str(fixture / "home"),
    "PATH": str(fixture / "bin") + ":" + test_path,
    "PETDEX_CAPTURE": str(capture),
}
prompt = "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this Projectless task"

def send(phase, payload):
    before = len(capture.read_text().splitlines())
    subprocess.run(
        ["sh", script, "bubble", phase, "codex"],
        input=json.dumps(payload), text=True, env=environment, check=True, timeout=5,
    )
    return len(capture.read_text().splitlines()) - before

assert send("user-prompt", {"session_id": "hidden", "prompt": prompt}) == 0
assert not (cache / "hidden.title").exists()
marker = (cache / "hidden.codex-hidden.json").read_text()
assert "prompt" not in marker and "Overview" not in marker
assert send("pre", {"session_id": "hidden", "tool_name": "Read"}) == 0
assert send("stop", {"session_id": "hidden", "last_assistant_message": "Internal answer"}) == 0
assert send("user-prompt", {"session_id": "projectless", "cwd": "", "prompt": "Suggest work for me"}) > 0
assert send("user-prompt", {"session_id": "workspace", "cwd": "/work", "prompt": "Fix the tests"}) > 0
assert send("user-prompt", {"session_id": "hidden", "thread_source": "user", "prompt": prompt}) > 0
assert not (cache / "hidden.codex-hidden.json").exists()
assert send("user-prompt", {"session_id": "structured", "thread_source": "ambient_suggestions", "prompt": "Internal"}) == 0
assert not (cache / "structured.title").exists()

rollout = fixture / "home" / ".codex" / "sessions" / "2026" / "08" / "13" / "rollout-test-from-meta.jsonl"
rollout.write_text(json.dumps({
    "type": "session_meta",
    "payload": {"id": "from-meta", "thread_source": "ambient_suggestions"},
}) + "\n")
assert send("pre", {"session_id": "from-meta", "tool_name": "Read"}) == 0

(cache / "expired.codex-hidden.json").write_text('{"hidden":true,"at":1}')
assert send("pre", {"session_id": "cleanup", "thread_source": "chatgpt_hidden", "tool_name": "Read"}) == 0
assert not (cache / "expired.codex-hidden.json").exists()
print("Hidden Codex hooks: PASS")
PY

# A failed tool is intermediate: keep the session busy/running while the
# per-agent failed state drives only the temporary sprite.
payload='{"session_id":"gemini-tool-failure","tool_name":"shell"}'
printf '%s' "$payload" | HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble tool-failure gemini
failure_body=$(tail -n 1 "$fixture/capture")
printf '%s\n' "$failure_body" | grep -q '"busy":true'
printf '%s\n' "$failure_body" | grep -q '"status":"running"'
printf '%s\n' "$failure_body" | grep -q '"agent_state":"failed"'

# Gemini's final turn event names its assistant prose prompt_response.
payload='{"session_id":"gemini-final","prompt_response":"Gemini answer"}'
printf '%s' "$payload" | HOME="$fixture/home" PATH="$fixture/bin:$test_path" \
    PETDEX_CAPTURE="$fixture/capture" sh "$root/src/assets/petdex-remote-hook.sh" bubble assistant gemini
answer_body=$(tail -n 1 "$fixture/capture")
printf '%s\n' "$answer_body" | grep -q '"text":"Gemini answer"'
