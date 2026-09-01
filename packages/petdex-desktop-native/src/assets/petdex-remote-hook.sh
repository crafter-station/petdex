#!/bin/sh
# petdex remote hook. Installed at ~/.petdex/bin/petdex-hook on REMOTE
# hosts, where the desktop binary does not exist; the hook configs the
# desktop merges (codex hooks.json, hermes config.yaml) point at this
# exact path, so they work unchanged on both sides of the tunnel.
#
# Contract mirrors the desktop petdex-hook CLI: argv `bubble [phase]
# [agent]`, hook JSON on stdin, state + bubble POSTs to 127.0.0.1:7777
# (the ssh -R tunnel back to the desktop), token-gated, and NEVER fails
# outward. An agent's hook chain must not break because a mascot is
# unreachable.

runtime="$HOME/.petdex/runtime"

# Keep a bounded useful prefix and stop after the first complete JSON value.
# Hosts are allowed to leave the write end of stdin open, so waiting for EOF
# here would leave every remote hook process stuck. Python is a declared
# dependency for remote Codex/Hermes reconciliation; on a minimal host without
# it, use an optional one-block timeout and fail closed rather than waiting
# forever.
if command -v python3 >/dev/null 2>&1; then
    payload=$(python3 -c '
import json
import os
import select
import sys
import time

CAP = 65536
READ_TIMEOUT = 0.5
DRAIN_TIMEOUT = 0.3

fd = sys.stdin.fileno()
retained = bytearray()
output = None
drain_deadline = None
deadline = time.monotonic() + READ_TIMEOUT
decoder = json.JSONDecoder()


def first_json_bytes():
    # Ignore malformed bytes only for the probe; the normal parser below still
    # rejects malformed payloads. This lets a valid JSON value followed by a
    # partial UTF-8 tail settle without waiting for the tail to complete.
    text = bytes(retained).decode("utf-8", "ignore")
    start = len(text) - len(text.lstrip())
    if start >= len(text) or text[start] not in "[{":
        return None
    try:
        _, end = decoder.raw_decode(text, start)
    except ValueError:
        return None
    return text[:end].encode("utf-8")


while True:
    until = drain_deadline if drain_deadline is not None else deadline
    remaining = until - time.monotonic()
    if remaining <= 0:
        break
    try:
        readable, _, _ = select.select([fd], [], [], remaining)
    except (OSError, ValueError):
        break
    if not readable:
        break
    try:
        chunk = os.read(fd, 8192)
    except OSError:
        break
    if not chunk:
        break
    if output is None:
        remaining_capacity = CAP - len(retained)
        if remaining_capacity > 0:
            retained.extend(chunk[:remaining_capacity])
        candidate = first_json_bytes()
        if candidate is not None:
            output = candidate
            drain_deadline = time.monotonic() + DRAIN_TIMEOUT
        elif len(retained) >= CAP:
            output = bytes(retained)
            drain_deadline = time.monotonic() + DRAIN_TIMEOUT

if output is None:
    output = bytes(retained)
sys.stdout.buffer.write(output)
' 2>/dev/null)
elif command -v timeout >/dev/null 2>&1; then
    payload=$(timeout 1s sh -c 'dd bs=65536 count=1 2>/dev/null' 2>/dev/null || true)
else
    payload=
fi

# Check the gate before doing any parsing. Draining remains unconditional so
# the hook host never sees EPIPE, but a disconnected Petdex costs no decoder.
[ -f "$runtime/hooks-disabled" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0
[ -f "$runtime/update-token" ] || exit 0
token=$(tr -d ' \t\r\n' < "$runtime/update-token")
[ -n "$token" ] || exit 0
[ "${1:-}" = "bubble" ] || exit 0
phase=${2:-}
agent=$(printf '%s' "${3:-}" | tr -cd 'A-Za-z0-9._-')

# Decode JSON once. Values are flattened to a tiny tab-separated cache after
# removing line breaks, quotes and backslashes; later shell lookups never
# invoke another JSON parser.
field_cache_ready=false
field_cache=
if command -v python3 >/dev/null 2>&1; then
    field_cache=$(printf '%s' "$payload" | python3 -c '
import json, sys
keys = (
    "session_id", "sessionId", "sessionID", "session_key", "thread_id", "conversation_id",
    "petdex_conversation_key", "parent_session_id", "petdex_parent_session_id", "child_session_id",
    "petdex_session_kind", "petdex_subagent_label", "child_role", "prompt", "user_message", "userPrompt",
    "petdex_session_title", "notification_type", "notification_kind", "tool_name", "question", "description",
    "command", "file_path", "path", "pattern", "query", "last_assistant_message", "assistant_response", "prompt_response",
    "message", "child_summary", "cwd", "turn_id", "message_id", "event_id", "call_id", "request_id",
    "tool_use_id",
)
def find(value, key):
    if isinstance(value, dict):
        found = value.get(key)
        if isinstance(found, (str, int, float)):
            return str(found)
        for child in value.values():
            result = find(child, key)
            if result:
                return result
    elif isinstance(value, list):
        for child in value:
            result = find(child, key)
            if result:
                return result
    return ""
try:
    root = json.load(sys.stdin)
except Exception:
    root = {}
    print("__parse_error__\t1")
for key in keys:
    value = "".join(" " if ord(ch) < 32 or ord(ch) == 127 else ch for ch in find(root, key))
    value = " ".join(value.split()).replace("\\", " ").replace(chr(34), " ")
    print(key + "\t" + value[:960])
' 2>/dev/null)
    if ! printf '%s\n' "$field_cache" | grep -q '^__parse_error__'; then
        field_cache_ready=true
    fi
fi

# Extract an identifier from the payload without jq. Identifiers are
# deliberately restricted because they are interpolated into JSON below.
id_field() {
    if $field_cache_ready; then
        printf '%s\n' "$field_cache" | awk -F '\t' -v wanted="$1" '$1 == wanted { sub(/^[^\t]*\t/, ""); print; exit }' | cut -c 1-256 | tr -cd 'A-Za-z0-9._-'
        return
    fi
    printf '%s' "$payload" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 | tr -cd 'A-Za-z0-9._-'
}

# Extract user-facing text from either the top-level payload or nested
# tool_input. Python is present on supported Codex hosts and gives us real
# JSON decoding; the sed fallback keeps the hook useful on minimal boxes.
# Quotes, backslashes and control characters are removed so the result is
# safe to interpolate into the compact JSON request bodies below.
text_field() {
    key=$1
    limit=${2:-96}
    if $field_cache_ready; then
        printf '%s\n' "$field_cache" | awk -F '\t' -v wanted="$key" '$1 == wanted { sub(/^[^\t]*\t/, ""); print; exit }' | cut -c "1-$limit"
        return
    fi
    printf '%s' "$payload" \
        | sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n 1 \
        | tr '\r\n\t\\"' '      ' \
        | tr -cd '[:alnum:][:space:].,;:!?@#%_+=/()-' \
        | cut -c "1-$limit"
}

session_id=$(id_field session_id)
[ -n "$session_id" ] || session_id=$(id_field sessionId)
[ -n "$session_id" ] || session_id=$(id_field sessionID)
[ -n "$session_id" ] || session_id=$(id_field session_key)
[ -n "$session_id" ] || session_id=$(id_field thread_id)
[ -n "$session_id" ] || session_id=$(id_field conversation_id)
canonical_hint=$(text_field petdex_conversation_key 960)
[ -n "$canonical_hint" ] || canonical_hint=$(text_field session_key 960)
# Hermes emits subagent lifecycle hooks on the parent stream and stores the
# worker id in child_session_id. Keep the parent as a canonical fallback, but
# make the child the raw session so its summary nests instead of overwriting
# the parent card.
parent_session_hint=$(id_field petdex_parent_session_id)
[ -n "$parent_session_hint" ] || parent_session_hint=$(id_field parent_session_id)
[ -n "$parent_session_hint" ] || parent_session_hint=$session_id
child_session_id=$(id_field child_session_id)
subagent_lifecycle=false
case "$phase" in
    subagent-start|subagent-stop)
        if [ -n "$child_session_id" ] && [ "$child_session_id" != "$parent_session_hint" ]; then
            session_id=$child_session_id
            subagent_lifecycle=true
        fi
        ;;
esac
child_role=$(text_field child_role 48)
[ -n "$child_role" ] || child_role=$(text_field petdex_subagent_label 48)
session_kind_hint=$(id_field petdex_session_kind)
case "$session_kind_hint" in primary|subagent) ;; *) session_kind_hint= ;; esac
sessions="$runtime/sessions"

# Read the title owned by each agent's server/session store. This runs on every
# event so delayed auto-titles and manual renames replace the prompt fallback
# without waiting for a reinstall or a new conversation.
provider_context() {
    command -v python3 >/dev/null 2>&1 || return
    python3 -c '
import hashlib, json, os, re, sqlite3, sys
from pathlib import Path

agent, sid, force_parent, force_subagent, explicit_label = sys.argv[1:6]
title = ""
conversation = sid
parent = ""
# Missing or temporarily locked state must not suppress a real top-level
# session. Only explicit child lifecycle evidence defaults to subagent.
kind = "subagent" if force_subagent == "true" else "primary"
label = ""
subagent_sources = {
    "subagent", "sub_agent", "child", "worker", "delegate", "delegated",
    "delegation", "background", "tool",
}
def delegate_parent(row):
    raw = row.get("model_config", "")
    try:
        config = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        config = {}
    return str(config.get("_delegate_from") or "") if isinstance(config, dict) else ""
def is_subagent(row):
    source = str(row.get("source", "") or "").strip().lower().replace("-", "_")
    if source in subagent_sources or bool(delegate_parent(row)):
        return True
    return bool(row.get("parent_session_id")) and not bool(row.get("session_key"))
try:
    if agent == "codex":
        # Codex writes explicit multi-agent ancestry into the rollout prefix,
        # while session_index contains only display titles. Read one bounded
        # metadata record so child Stop/Permission hooks cannot create cards
        # even when the rollout watcher correctly suppresses that same child.
        meta = {}
        session_root = Path.home() / ".codex" / "sessions"
        for candidate in session_root.glob(f"*/*/*/rollout-*{sid}.jsonl"):
            with candidate.open("rb") as handle:
                prefix = handle.read(65536)
            for encoded in prefix.splitlines():
                try:
                    envelope = json.loads(encoded.decode("utf-8", "ignore"))
                except Exception:
                    continue
                if envelope.get("type") == "session_meta" and isinstance(envelope.get("payload"), dict):
                    meta = envelope["payload"]
                    break
            if meta:
                break
        source = meta.get("source")
        if isinstance(source, dict):
            source_kind = "subagent" if "subagent" in source else str(source.get("type") or source.get("kind") or "")
        else:
            source_kind = str(source or "")
        source_kind = source_kind.strip().lower().replace("-", "_")
        thread_source = str(meta.get("thread_source") or "").strip().lower().replace("-", "_")
        codex_child = (
            thread_source == "subagent"
            or source_kind in {"subagent", "sub_agent", "child", "worker"}
            or (bool(meta.get("parent_thread_id")) and bool(meta.get("agent_nickname")))
        )
        if codex_child:
            kind = "subagent"
            parent = str(meta.get("parent_thread_id") or force_parent or "")
            conversation = parent or sid
            label = explicit_label or str(meta.get("agent_nickname") or "")

        path = Path.home() / ".codex" / "session_index.jsonl"
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 4 * 1024 * 1024))
            raw_index = handle.read(4 * 1024 * 1024)
        if size > len(raw_index):
            newline = raw_index.find(b"\n")
            raw_index = raw_index[newline + 1 :] if newline >= 0 else b""
        for line in reversed(raw_index.decode("utf-8", "ignore").splitlines()[-2000:]):
            row = json.loads(line)
            if str(row.get("id") or "") == conversation:
                title = str(row.get("thread_name") or row.get("title") or "")
                break
    elif agent == "hermes":
        configured_home = ""
        try:
            configured_home = (Path.home() / ".petdex" / "runtime" / "hermes-home").read_text(encoding="utf-8").strip()
        except OSError:
            pass
        root = Path(os.environ.get("HERMES_HOME") or configured_home or (Path.home() / ".hermes")).expanduser()
        try:
            profile = (root / "active_profile").read_text(encoding="utf-8").strip()
        except OSError:
            profile = ""
        if profile and profile != "default" and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", profile):
            root = root / "profiles" / profile
        db_path = root / "state.db"
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.05) as db:
            columns = {str(row[1]) for row in db.execute("PRAGMA table_info(sessions)").fetchall()}
            wanted = [name for name in ("id", "title", "display_name", "source", "model_config", "parent_session_id", "session_key") if name in columns]
            def load(identifier):
                if "id" not in wanted:
                    return None
                row = db.execute(f"SELECT {chr(44).join(wanted)} FROM sessions WHERE id = ? LIMIT 1", (identifier,)).fetchone()
                return dict(zip(wanted, [str(value or "") for value in row])) if row else None
            first = load(sid)
            if first:
                chain = [first]
                current = first
                seen = {sid}
                for _ in range(16):
                    next_id = current.get("parent_session_id", "")
                    if not next_id or next_id in seen:
                        break
                    seen.add(next_id)
                    current = load(next_id)
                    if not current:
                        break
                    chain.append(current)
                root_row = chain[-1]
                conversation = next((row.get("session_key", "") for row in reversed(chain) if row.get("session_key")), root_row.get("id", sid))
                title = next((row.get("title", "") for row in reversed(chain) if row.get("title")), "")
                parent = first.get("parent_session_id", "") or delegate_parent(first) or force_parent
                kind = "subagent" if force_subagent == "true" or is_subagent(first) else "primary"
                label = explicit_label or first.get("display_name", "") or (first.get("title", "") if kind == "subagent" else "")
            elif force_subagent == "true" and force_parent and force_parent != sid:
                parent_row = load(force_parent)
                if parent_row:
                    chain = [parent_row]
                    current = parent_row
                    seen = {force_parent}
                    for _ in range(16):
                        next_id = current.get("parent_session_id", "")
                        if not next_id or next_id in seen:
                            break
                        seen.add(next_id)
                        current = load(next_id)
                        if not current:
                            break
                        chain.append(current)
                    root_row = chain[-1]
                    conversation = next((row.get("session_key", "") for row in reversed(chain) if row.get("session_key")), root_row.get("id", force_parent))
                    title = next((row.get("title", "") for row in reversed(chain) if row.get("title")), "")
                else:
                    conversation = force_parent
                parent = force_parent
                kind = "subagent"
                label = explicit_label
except Exception:
    pass
def clean(value, limit):
    value = "".join(" " if ord(ch) < 32 or ord(ch) == 127 else ch for ch in str(value or ""))
    return " ".join(value.split()).replace("\\", " ").replace(chr(34), " ")[:limit]
def canonical(value):
    value = " ".join(str(value or "").split())
    if value and len(value) <= 64 and all(ch.isascii() and (ch.isalnum() or ch in "-_") for ch in value):
        return value
    return hashlib.sha256(value.encode("utf-8")).hexdigest() if value else ""
conversation = canonical(conversation)
for value, limit in ((title, 256), (conversation, 64), (parent, 96), (kind, 16), (label, 48)):
    print(clean(value, limit))
' "$agent" "$session_id" "$parent_session_hint" "$subagent_lifecycle" "$child_role" 2>/dev/null
}

# The first prompt is a cross-agent fallback for harnesses without a generated
# title API. It is written only once; an authoritative provider title below
# always wins and is refreshed on every lifecycle update.
if [ "$phase" = "user-prompt" ] && [ -n "$session_id" ]; then
    prompt_title=$(text_field prompt 60)
    [ -n "$prompt_title" ] || prompt_title=$(text_field user_message 60)
    [ -n "$prompt_title" ] || prompt_title=$(text_field userPrompt 60)
    if [ -n "$prompt_title" ]; then
        umask 077
        mkdir -p "$sessions" 2>/dev/null || true
        title_file="$sessions/$session_id.title"
        if [ ! -s "$title_file" ]; then
            title_tmp="$title_file.tmp.$$"
            if printf '%s' "$prompt_title" > "$title_tmp" 2>/dev/null; then
                mv -f "$title_tmp" "$title_file" 2>/dev/null || true
            fi
        fi
    fi
fi

context=$(provider_context)
provider_title=$(printf '%s\n' "$context" | sed -n '1p')
conversation_key=$(printf '%s\n' "$context" | sed -n '2p')
parent_session_id=$(printf '%s\n' "$context" | sed -n '3p')
session_kind=$(printf '%s\n' "$context" | sed -n '4p')
subagent_label=$(printf '%s\n' "$context" | sed -n '5p')
[ -n "$conversation_key" ] || conversation_key=$session_id
[ -n "$session_kind" ] || session_kind=primary
[ -n "$canonical_hint" ] && conversation_key=$canonical_hint
[ -n "$session_kind_hint" ] && session_kind=$session_kind_hint
if [ "$subagent_lifecycle" = true ]; then
    # A just-spawned worker can race state.db creation. Its known parent still
    # gives us the correct aggregate identity until the durable marker lands.
    [ -n "$parent_session_id" ] || parent_session_id=$parent_session_hint
    [ "$conversation_key" = "$session_id" ] && [ -n "$parent_session_hint" ] && conversation_key=$parent_session_hint
    session_kind=subagent
    [ -n "$subagent_label" ] || subagent_label=$child_role
fi

normalize_key() {
    value=$1
    [ -n "$value" ] || return
    case "$value" in
        *[!A-Za-z0-9_-]*) ;;
        *)
            [ "${#value}" -le 64 ] && { printf '%s' "$value"; return; }
            ;;
    esac
    if command -v sha256sum >/dev/null 2>&1; then
        printf '%s' "$value" | sha256sum | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        printf '%s' "$value" | shasum -a 256 | awk '{print $1}'
    elif command -v python3 >/dev/null 2>&1; then
        printf '%s' "$value" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
    else
        cksum_result=$(printf '%s' "$value" | cksum)
        cksum_sum=$(printf '%s\n' "$cksum_result" | awk '{print $1}')
        cksum_length=$(printf '%s\n' "$cksum_result" | awk '{print $2}')
        printf 'cksum-%s-%s' "$cksum_sum" "$cksum_length"
    fi
}
conversation_key=$(normalize_key "$conversation_key")

# This PR targets the base card model, which has no nested child hierarchy.
# Suppress every confidently classified worker at the source instead of
# opening standalone cards for delegated tool progress.
if [ "$session_kind" = "subagent" ]; then
    exit 0
fi

title=$(text_field petdex_session_title 256)
[ -n "$title" ] || title=$provider_title
title_source=server
if [ -z "$title" ] && [ -n "$session_id" ] && [ -f "$sessions/$session_id.title" ]; then
    title=$(head -c 240 "$sessions/$session_id.title" 2>/dev/null | tr -d '\r\n\\"')
    title_source=prompt
fi

# phase -> sprite state, a port of hook_runner.stateForEvent. Missing
# phases deliberately map to nothing: an event we do not understand
# must not move the pet.
state=
busy=false
text=
session_status=idle
message_kind=status
agent_state=
post_bubble=true
notification_kind=$(id_field notification_type)
[ -n "$notification_kind" ] || notification_kind=$(id_field notification_kind)
case "$phase" in
    pre|post)
        tool=$(id_field tool_name)
        lower_tool=$(printf '%s' "$tool" | tr '[:upper:]' '[:lower:]')
        session_status=running
        message_kind=tool
        if [ "$lower_tool" = "clarify" ]; then
            if [ "$phase" = "pre" ]; then
                state=waiting
                session_status=needs_input
                message_kind=prompt
                text=$(text_field question 960)
                [ -n "$text" ] || text=$(text_field prompt 960)
                [ -n "$text" ] || text="Waiting for you…"
            else
                state=running
                text="Continuing…"
            fi
        else
            if [ "$phase" = "post" ]; then
                state=running
            else
                case "$lower_tool" in
                    read|read_file|grep|glob) state=review ;;
                    *) state=running ;;
                esac
            fi
            busy=true
            before=true
            [ "$phase" = "post" ] && before=false
            case "$lower_tool" in
                bash|shell|exec|exec_command)
                    description=$(text_field description 72)
                    command=$(text_field command 72)
                    command_name=$(printf '%s' "$command" | awk '{print $1}')
                    if [ -n "$description" ]; then
                        text=$description
                    elif [ -n "$command_name" ]; then
                        if $before; then text="Running $command_name"; else text="Ran $command_name"; fi
                    elif $before; then text="Running command"; else text="Ran command"; fi
                    ;;
                read|read_file)
                    path=$(text_field file_path 160)
                    [ -n "$path" ] || path=$(text_field path 160)
                    name=${path##*/}
                    if [ -n "$name" ]; then
                        if $before; then text="Reading $name"; else text="Read $name"; fi
                    elif $before; then text="Reading file"; else text="Read file"; fi
                    ;;
                grep|search|search_query|rg)
                    pattern=$(text_field pattern 48)
                    [ -n "$pattern" ] || pattern=$(text_field query 48)
                    if [ -n "$pattern" ]; then
                        if $before; then text="Searching $pattern"; else text="Searched $pattern"; fi
                    elif $before; then text="Searching code"; else text="Searched code"; fi
                    ;;
                glob|find)
                    if $before; then text="Finding files"; else text="Found files"; fi
                    ;;
                apply_patch|edit|edit_file|write|write_file)
                    if $before; then text="Editing files"; else text="Edited files"; fi
                    ;;
                *)
                    if [ -n "$tool" ]; then
                        if $before; then text="Calling $tool"; else text="Called $tool"; fi
                    elif $before; then text="Working…"; else text="Updated"; fi
                    ;;
            esac
        fi
        [ "$agent" = "codex" ] && post_bubble=false
        ;;
    tool-failure)
        state=failed
        busy=true
        session_status=running
        message_kind=tool
        agent_state=failed
        text="Tool failed"
        [ "$agent" = "codex" ] && post_bubble=false
        ;;
    stop|session-end)
        state=waving
        session_status=completed
        message_kind=lifecycle
        text=$(text_field last_assistant_message 960)
        [ -n "$text" ] || text="Done."
        ;;
    user-prompt)
        state=jumping
        busy=true
        session_status=running
        message_kind=prompt
        text="Thinking…"
        ;;
    session-start)
        state=jumping
        busy=true
        session_status=running
        message_kind=lifecycle
        text="Starting session…"
        ;;
    assistant)
        state=waving
        session_status=completed
        message_kind=assistant
        text=$(text_field assistant_response 960)
        [ -n "$text" ] || text=$(text_field last_assistant_message 960)
        [ -n "$text" ] || text=$(text_field prompt_response 960)
        [ -n "$text" ] || text=$(text_field message 960)
        [ -n "$text" ] || text="Done."
        ;;
    approval-request)
        state=waiting
        session_status=needs_input
        message_kind=prompt
        text=$(text_field question 960)
        [ -n "$text" ] || text=$(text_field prompt 960)
        [ -n "$text" ] || text=$(text_field message 960)
        [ -n "$text" ] || text="Waiting for you…"
        ;;
    notification)
        case "$notification_kind" in
            permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input)
                state=waiting
                session_status=needs_input
                message_kind=prompt
                text=$(text_field question 960)
                [ -n "$text" ] || text=$(text_field prompt 960)
                [ -n "$text" ] || text=$(text_field message 960)
                [ -n "$text" ] || text="Waiting for you…"
                ;;
            idle_prompt|agent_completed)
                state=waving
                session_status=completed
                message_kind=lifecycle
                text=$(text_field message 960)
                [ -n "$text" ] || text="Done."
                ;;
            *)
                # Authentication and unknown notifications are informational,
                # not correlated input requests.
                post_bubble=false
                ;;
        esac
        ;;
    waiting)
        # Legacy mascot phase only; no explicit request means no orange card.
        post_bubble=false
        ;;
    approval-response)
        state=running
        busy=true
        session_status=running
        message_kind=status
        text="Continuing…"
        ;;
    subagent-start|subagent-stop)
        state=running
        busy=true
        session_status=running
        message_kind=lifecycle
        # A spawn is only lifecycle noise. At stop Hermes provides a concise
        # child_summary; promote that one value to assistant prose so it folds
        # beneath the parent card instead of becoming another top-level bubble.
        if [ "$phase" = "subagent-stop" ]; then
            text=$(text_field child_summary 960)
            [ -n "$text" ] && message_kind=assistant
        fi
        ;;
esac

# Every visible bubble replaces the prior per-conversation Flock state. A
# tool failure is intermediate; later progress and terminal events must carry
# their current state instead of leaving the previous `failed` value sticky.
if [ -n "$text" ] && $post_bubble; then
    agent_state=$state
fi

post() {
    # -m 2: the tunnel adds latency the local 300ms budget never sees,
    # but a wedged tunnel still must not stall the agent.
    curl -sS -m 2 -o /dev/null \
        -X POST \
        -H "x-petdex-update-token: $token" \
        -H "content-type: application/json" \
        --data "$2" \
        "http://127.0.0.1:7777/$1" 2>/dev/null || true
}

if [ -n "$state" ]; then
    # failed carries its dwell so the animation survives a whole cycle,
    # same 1220ms as the desktop runner.
    if [ "$state" = "failed" ]; then
        post state "{\"state\":\"$state\",\"duration\":1220,\"agent_source\":\"$agent\"}"
    else
        post state "{\"state\":\"$state\",\"agent_source\":\"$agent\"}"
    fi
fi

if [ -n "$text" ] && $post_bubble; then
    metadata=',"remote":true'
    [ -n "$conversation_key" ] && metadata="$metadata,\"session_id\":\"$conversation_key\""
    [ -n "$session_id" ] && metadata="$metadata,\"source_session_id\":\"$session_id\""
    [ -n "$conversation_key" ] && metadata="$metadata,\"conversation_key\":\"$conversation_key\""
    [ -n "$parent_session_id" ] && metadata="$metadata,\"parent_session_id\":\"$parent_session_id\""
    metadata="$metadata,\"session_kind\":\"$session_kind\""
    [ -n "$subagent_label" ] && metadata="$metadata,\"subagent_label\":\"$subagent_label\""
    [ -n "$title" ] && metadata="$metadata,\"title\":\"$title\""
    metadata="$metadata,\"title_source\":\"$title_source\",\"feed_source\":\"hook\",\"event_kind\":\"$phase\",\"message_kind\":\"$message_kind\",\"status\":\"$session_status\""
    [ -n "$agent_state" ] && metadata="$metadata,\"agent_state\":\"$agent_state\""
    [ -n "$notification_kind" ] && metadata="$metadata,\"notification_kind\":\"$notification_kind\""
    source_cwd=$(text_field cwd 240)
    [ -n "$source_cwd" ] && metadata="$metadata,\"source_cwd\":\"$source_cwd\""
    hostname=$(sed -n '1p' "$HOME/.petdex/runtime/remote-host" 2>/dev/null | tr -cd 'A-Za-z0-9_-')
    [ -n "$hostname" ] && metadata="$metadata,\"hostname\":\"$hostname\""
    turn_id=$(id_field turn_id)
    [ -n "$turn_id" ] && metadata="$metadata,\"turn_id\":\"$turn_id\""
    message_id=$(id_field message_id)
    [ -n "$message_id" ] || message_id=$(id_field event_id)
    [ -n "$message_id" ] || message_id=$(id_field call_id)
    [ -n "$message_id" ] && metadata="$metadata,\"message_id\":\"$message_id\""
    correlation_id=$(id_field request_id)
    [ -n "$correlation_id" ] || correlation_id=$(id_field tool_use_id)
    [ -n "$correlation_id" ] || correlation_id=$message_id
    if [ "$session_status" = "needs_input" ] && [ -n "$correlation_id" ]; then
        metadata="$metadata,\"request_id\":\"$correlation_id\""
    elif { [ "$phase" = "approval-response" ] || { [ "$phase" = "post" ] && [ "${lower_tool:-}" = "clarify" ]; }; } && [ -n "$correlation_id" ]; then
        metadata="$metadata,\"resolves_request_id\":\"$correlation_id\""
    fi
    [ "$agent" = "codex" ] && metadata="$metadata,\"source_app\":\"codex\""
    post bubble "{\"text\":\"$text\",\"busy\":$busy,\"agent_source\":\"$agent\"$metadata}"
fi

exit 0
