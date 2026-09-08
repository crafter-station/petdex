#!/usr/bin/env python3
"""Bounded remote Codex rollout follower for Petdesk.

The process runs beside Codex on an SSH host and posts the same authoritative
session-index titles and rollout prose consumed by Codex Desktop through the
reverse Petdesk tunnel. Historical completed sessions are never published.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


HOME = Path.home()
CODEX = HOME / ".codex"
RUNTIME = HOME / ".petdex" / "runtime"
TOKEN = RUNTIME / "update-token"
REMOTE_HOST = RUNTIME / "remote-host"
LEASE = RUNTIME / "tunnel-lease"
LOCK = RUNTIME / "codex-watch.lock"
PID = RUNTIME / "codex-watch.pid"
INDEX = CODEX / "session_index.jsonl"
SESSIONS = CODEX / "sessions"
ENDPOINT = "http://127.0.0.1:7777/bubble"
DISCOVERY_SECONDS = 2.0
FOLLOW_SECONDS = 0.25
MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_ROLLOUT_BYTES = 4 * 1024 * 1024
MAX_SESSION_META_BYTES = 64 * 1024
MAX_WATCHES = 8
MAX_RECENT_IDS = 32
# A rollout without a terminal event is not necessarily still alive. Codex can
# be killed, a host can reboot, or an old `codex exec` can simply stop writing.
# On initial reconciliation, only a recently-written running rollout is
# eligible. Explicit unmatched input remains eligible regardless of age so a
# question waiting across a restart is never lost.
INITIAL_RUNNING_MAX_AGE_SECONDS = 15 * 60


def bounded_tail(path: Path, limit: int) -> bytes:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            data = handle.read(limit)
            if size > limit:
                newline = data.find(b"\n")
                if newline >= 0:
                    data = data[newline + 1 :]
            return data
    except OSError:
        return b""


def session_meta_prefix(path: Path) -> bytes:
    """Return only the bounded session_meta record from a rollout prefix."""

    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_SESSION_META_BYTES)
    except OSError:
        return b""
    for line in data.splitlines():
        try:
            envelope = json.loads(line.decode("utf-8", "ignore"))
        except Exception:
            continue
        if envelope.get("type") == "session_meta":
            return line + b"\n"
    return b""


def compact(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def remote_hostname() -> str:
    try:
        return compact(REMOTE_HOST.read_text(encoding="utf-8"), 64)
    except OSError:
        return ""


def lease_alive() -> bool:
    try:
        return max(0.0, time.time() - LEASE.stat().st_mtime) <= 10.0
    except OSError:
        return False


def remove_owned_pid() -> None:
    try:
        if PID.read_text(encoding="ascii").strip() == str(os.getpid()):
            PID.unlink()
    except OSError:
        pass


def acquire_lock(lock_handle: Any) -> bool:
    for _ in range(30):
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            time.sleep(0.1)
    return False


def session_index() -> list[dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    raw = bounded_tail(INDEX, MAX_INDEX_BYTES).decode("utf-8", "ignore")
    for line in raw.splitlines():
        try:
            item = json.loads(line)
        except Exception:
            continue
        session_id = compact(item.get("id") or item.get("session_id"), 96)
        if not session_id:
            continue
        # A server-side rename appends a fresh row for an existing id. Move
        # that id to the tail as well as replacing its title so the bounded
        # recent set cannot discard an actively renamed older conversation.
        rows.pop(session_id, None)
        rows[session_id] = {
            "id": session_id,
            "title": compact(item.get("thread_name") or item.get("title"), 256),
            "updated": compact(item.get("updated_at") or item.get("timestamp"), 64),
        }
    return list(rows.values())[-MAX_RECENT_IDS:]


def rollout_catalog() -> dict[str, Path]:
    found: dict[str, tuple[float, Path]] = {}
    try:
        paths = SESSIONS.glob("*/*/*/rollout-*.jsonl")
        for path in paths:
            stem = path.stem
            session_id = stem.rsplit("-", 5)[-5:]
            # UUIDv7 session ids are the final five dash-separated segments.
            sid = "-".join(session_id)
            try:
                modified = path.stat().st_mtime
            except OSError:
                continue
            previous = found.get(sid)
            if previous is None or modified > previous[0]:
                found[sid] = (modified, path)
    except OSError:
        return {}
    return {sid: value[1] for sid, value in found.items()}


def recent_rollouts(catalog: dict[str, Path]) -> list[tuple[str, Path]]:
    """Newest rollout files, including CLI sessions absent from the index."""

    def modified(item: tuple[str, Path]) -> float:
        try:
            return item[1].stat().st_mtime
        except OSError:
            return 0.0

    return sorted(catalog.items(), key=modified, reverse=True)[:MAX_RECENT_IDS]


def request_prompt(arguments: Any) -> str:
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except Exception:
            arguments = {}
    if not isinstance(arguments, dict):
        return "Waiting for you…"
    questions = arguments.get("questions")
    if isinstance(questions, list):
        for item in questions:
            if isinstance(item, dict) and item.get("question"):
                return compact(item["question"], 960)
    for key in ("question", "justification", "prompt", "reason", "message"):
        if arguments.get(key):
            return compact(arguments[key], 960)
    return "Waiting for you…"


def new_rollout_state() -> dict[str, Any]:
    return {
        "status": "idle",
        "text": "",
        "message_kind": "status",
        "turn_id": "",
        "cwd": "",
        "lifecycle": False,
        "pending": {},
        "newest_message_id": "",
        "resolved_request_id": "",
        "fallback_title": "",
        "session_kind": "primary",
        "parent_session_id": "",
        "subagent_label": "",
        "partial": b"",
    }


def is_subagent_metadata(payload: dict[str, Any]) -> bool:
    thread_source = compact(payload.get("thread_source"), 32).lower().replace("-", "_")
    source = payload.get("source")
    source_kind = ""
    if isinstance(source, dict):
        if "subagent" in source:
            source_kind = "subagent"
        else:
            source_kind = compact(source.get("type") or source.get("kind"), 32)
    else:
        source_kind = compact(source, 32)
    source_kind = source_kind.lower().replace("-", "_")
    # Current Codex rollouts provide both explicit source markers. The final
    # parent+nickname fallback covers older multi-agent builds without treating
    # ordinary fork/continuation metadata as a child session.
    return (
        thread_source == "subagent"
        or source_kind in {"subagent", "sub_agent", "child", "worker"}
        or (
            bool(compact(payload.get("parent_thread_id"), 96))
            and bool(compact(payload.get("agent_nickname"), 64))
        )
    )


def apply_rollout_bytes(state: dict[str, Any], raw: bytes) -> None:
    data = state.get("partial", b"") + raw
    lines = data.split(b"\n")
    if data and not data.endswith(b"\n"):
        candidate = lines.pop()
        try:
            json.loads(candidate.decode("utf-8", "ignore"))
        except Exception:
            state["partial"] = candidate[-MAX_ROLLOUT_BYTES:]
        else:
            state["partial"] = b""
            lines.append(candidate)
    else:
        state["partial"] = b""
    pending: dict[str, str] = state["pending"]
    for encoded_line in lines:
        if not encoded_line:
            continue
        try:
            envelope = json.loads(encoded_line.decode("utf-8", "ignore"))
        except Exception:
            continue
        payload = envelope.get("payload")
        if not isinstance(payload, dict):
            continue
        outer = envelope.get("type")
        event_type = payload.get("type")

        if outer == "session_meta":
            state["cwd"] = compact(payload.get("cwd"), 512)
            if is_subagent_metadata(payload):
                state["session_kind"] = "subagent"
                state["parent_session_id"] = compact(payload.get("parent_thread_id"), 96)
                state["subagent_label"] = compact(payload.get("agent_nickname"), 64)
            continue
        if event_type == "user_message" and not state["fallback_title"]:
            state["fallback_title"] = compact(payload.get("message"), 256)
            continue
        if event_type == "task_started":
            state["lifecycle"] = True
            state["status"] = "running"
            state["text"] = ""
            state["message_kind"] = "status"
            state["turn_id"] = compact(payload.get("turn_id"), 64)
            state["resolved_request_id"] = ""
            pending.clear()
            continue
        if event_type == "task_complete":
            state["lifecycle"] = True
            state["status"] = "completed"
            state["turn_id"] = compact(payload.get("turn_id"), 64) or state["turn_id"]
            pending.clear()
            final = compact(payload.get("last_agent_message"), 960)
            if final:
                state["text"] = final
                state["message_kind"] = "assistant"
            elif state["message_kind"] != "assistant" or not str(state["text"]).strip():
                # Codex can finish without repeating the final response.
                # Preserve actual assistant prose, but clear a transient
                # prompt, reasoning, or “Thinking…” cue from the terminal
                # card.
                state["text"] = "Done."
                state["message_kind"] = "status"
            continue
        if event_type in {"turn_aborted", "task_failed"}:
            state["lifecycle"] = True
            state["status"] = "failed"
            state["turn_id"] = compact(payload.get("turn_id"), 64) or state["turn_id"]
            pending.clear()
            reason = compact(payload.get("reason"), 80).lower()
            state["text"] = "Interrupted." if reason == "interrupted" else "Session failed."
            state["message_kind"] = "status"
            continue
        if outer == "response_item" and event_type == "function_call":
            name = str(payload.get("name") or "")
            arguments = payload.get("arguments")
            parsed_arguments: Any = arguments
            if isinstance(arguments, str):
                try:
                    parsed_arguments = json.loads(arguments)
                except Exception:
                    parsed_arguments = {}
            requires_approval = isinstance(parsed_arguments, dict) and parsed_arguments.get("sandbox_permissions") == "require_escalated"
            if name == "request_user_input" or requires_approval:
                call_id = compact(payload.get("call_id") or payload.get("id") or "input-request", 96)
                pending[call_id] = request_prompt(parsed_arguments)
                state["newest_message_id"] = call_id
                state["status"] = "needs_input"
                state["text"] = pending[call_id]
                state["message_kind"] = "prompt"
            continue
        if outer == "response_item" and event_type in {"function_call_output", "custom_tool_call_output"}:
            call_id = compact(payload.get("call_id") or payload.get("id"), 96)
            if call_id in pending:
                pending.pop(call_id, None)
                state["resolved_request_id"] = call_id
                state["newest_message_id"] = call_id
                if not pending:
                    state["status"] = "running"
                    state["text"] = "Thinking…"
                    state["message_kind"] = "status"
            continue
        if event_type == "agent_message":
            message = compact(payload.get("message"), 960)
            if message:
                state["text"] = message
                state["message_kind"] = "assistant"
                state["newest_message_id"] = compact(payload.get("id") or envelope.get("timestamp"), 96)
            continue
        if event_type == "agent_reasoning":
            reasoning = compact(payload.get("text"), 960)
            if reasoning and state["message_kind"] != "assistant":
                state["text"] = reasoning
                state["message_kind"] = "reasoning"
                state["newest_message_id"] = compact(payload.get("id") or envelope.get("timestamp"), 96)


def event_from_state(path: Path, title: str, state: dict[str, Any]) -> dict[str, Any] | None:
    # The upstream card model has no nested-child hierarchy. Suppress Codex
    # workers at the source just like Hermes workers instead of letting their
    # tool progress evict top-level conversations from the bounded card stack.
    if state.get("session_kind") == "subagent":
        return None
    pending: dict[str, str] = state["pending"]
    status = state["status"]
    text = state["text"]
    message_kind = state["message_kind"]
    newest_message_id = state["newest_message_id"]
    if pending:
        status = "needs_input"
        newest_message_id, text = next(reversed(pending.items()))
        message_kind = "prompt"
    elif not state["lifecycle"]:
        if not text:
            return None
        status = "running"
    if not text:
        text = "Thinking…" if status == "running" else "Done."
    resolved_title = title or state["fallback_title"]
    event_kind = {
        "needs_input": "request_user_input",
        "completed": "session-end",
        "failed": "session-failure",
        "running": "assistant" if message_kind == "assistant" else "agent-progress",
    }.get(status, "reconcile")
    return {
        "text": text,
        "title": resolved_title,
        "busy": status == "running",
        "agent_source": "codex",
        "conversation_key": path.stem[-36:],
        "source_session_id": path.stem[-36:],
        "session_id": path.stem[-36:],
        "session_kind": "primary",
        "hostname": remote_hostname(),
        "remote": True,
        "source_cwd": state["cwd"],
        "turn_id": state["turn_id"],
        "message_id": newest_message_id,
        "event_kind": event_kind,
        "request_id": newest_message_id if status == "needs_input" else "",
        "resolves_request_id": state["resolved_request_id"] if status != "needs_input" else "",
        "message_kind": message_kind,
        "title_source": "server" if title else ("prompt" if state["fallback_title"] else "unknown"),
        "feed_source": "rollout",
        "status": status,
    }


def initial_rollout_state(path: Path) -> tuple[dict[str, Any], int] | None:
    try:
        size = path.stat().st_size
    except OSError:
        return None
    raw = bounded_tail(path, MAX_ROLLOUT_BYTES)
    if not raw:
        return None
    state = new_rollout_state()
    # Large rollouts can push the opening metadata outside the bounded tail.
    # Read only that one prefix record so child classification survives without
    # replaying old lifecycle/input events whose matching outputs may be in the
    # omitted middle of the file.
    if size > MAX_ROLLOUT_BYTES:
        apply_rollout_bytes(state, session_meta_prefix(path))
    apply_rollout_bytes(state, raw)
    return state, size


def append_rollout_state(path: Path, state: dict[str, Any], offset: int, size: int) -> tuple[dict[str, Any], int] | None:
    if size < offset or size - offset > MAX_ROLLOUT_BYTES:
        return initial_rollout_state(path)
    if size == offset:
        return state, offset
    try:
        with path.open("rb") as handle:
            handle.seek(offset)
            raw = handle.read(size - offset)
    except OSError:
        return None
    apply_rollout_bytes(state, raw)
    return state, size


def parse_rollout(path: Path, title: str) -> dict[str, Any] | None:
    loaded = initial_rollout_state(path)
    if loaded is None:
        return None
    state, _ = loaded
    return event_from_state(path, title, state)


def digest(event: dict[str, Any]) -> str:
    encoded = json.dumps(event, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def initial_publishable(event: dict[str, Any], path: Path, now: float | None = None) -> bool:
    if event.get("status") == "needs_input":
        return True
    if event.get("status") != "running":
        return False
    try:
        modified = path.stat().st_mtime
    except OSError:
        return False
    current = time.time() if now is None else now
    return max(0.0, current - modified) <= INITIAL_RUNNING_MAX_AGE_SECONDS


def post(event: dict[str, Any]) -> bool:
    try:
        token = TOKEN.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    if not token:
        return False
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-petdex-update-token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=0.5) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def snapshot() -> list[dict[str, Any]]:
    index = session_index()
    catalog = rollout_catalog()
    titles = {row["id"]: row["title"] for row in index}
    events: list[dict[str, Any]] = []
    for session_id, path in recent_rollouts(catalog):
        event = parse_rollout(path, titles.get(session_id, ""))
        if event and initial_publishable(event, path):
            events.append(event)
        if len(events) >= MAX_WATCHES:
            break
    return events


def discovery_paths(
    catalog: dict[str, Path],
    titles: dict[str, str],
    watched: dict[str, dict[str, Any]],
) -> dict[str, Path]:
    """Select bounded top-level work without letting stale/child files hide it."""

    ordered: list[tuple[str, Path]] = []
    seen: set[str] = set()
    # Keep an already-visible wait/running session even when many newer rollout
    # files push it outside the recent catalog window.
    for session_id, previous in watched.items():
        path = catalog.get(session_id)
        if previous.get("visible") and path is not None:
            ordered.append((session_id, path))
            seen.add(session_id)
    for session_id, path in recent_rollouts(catalog):
        if session_id not in seen:
            ordered.append((session_id, path))
            seen.add(session_id)

    selected: dict[str, Path] = {}
    for session_id, path in ordered:
        previous = watched.get(session_id)
        if previous is not None and previous.get("visible"):
            selected[session_id] = path
        else:
            event = parse_rollout(path, titles.get(session_id, ""))
            if event is None or not initial_publishable(event, path):
                continue
            selected[session_id] = path
        if len(selected) >= MAX_WATCHES:
            break
    return selected


def run() -> int:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    if not lease_alive():
        return 75
    lock_handle = LOCK.open("a+")
    if not acquire_lock(lock_handle):
        return 75
    PID.write_text(str(os.getpid()), encoding="ascii")
    watched: dict[str, dict[str, Any]] = {}
    paths: dict[str, Path] = {}
    titles: dict[str, str] = {}
    last_discovery = 0.0

    try:
        while lease_alive():
            now = time.monotonic()
            if now - last_discovery >= DISCOVERY_SECONDS:
                last_discovery = now
                rows = session_index()
                titles = {row["id"]: row["title"] for row in rows}
                catalog = rollout_catalog()
                paths = discovery_paths(catalog, titles, watched)
                for stale_id in set(watched) - set(paths):
                    watched.pop(stale_id, None)

            for session_id, path in list(paths.items()):
                try:
                    size = path.stat().st_size
                except OSError:
                    continue
                previous = watched.get(session_id)
                title = titles.get(session_id, "")
                path_changed = previous is not None and previous.get("path") != str(path)
                if previous is None or path_changed:
                    loaded = initial_rollout_state(path)
                    if loaded is None:
                        continue
                    state, offset = loaded
                    previous = {
                        "state": state,
                        "offset": offset,
                        "size": size,
                        "title": title,
                        "path": str(path),
                        "delivered_hash": "",
                        "visible": False,
                    }
                    watched[session_id] = previous
                    initial = True
                    size_changed = True
                else:
                    initial = False
                    size_changed = previous.get("size") != size
                    if size_changed:
                        loaded = append_rollout_state(
                            path,
                            previous["state"],
                            int(previous["offset"]),
                            size,
                        )
                        if loaded is None:
                            continue
                        previous["state"], previous["offset"] = loaded
                    previous["size"] = size
                    previous["title"] = title
                event = event_from_state(path, title, previous["state"])
                if not event:
                    continue
                event["conversation_key"] = session_id
                event["source_session_id"] = session_id
                event["session_id"] = session_id
                event_hash = digest(event)
                if event_hash == previous.get("delivered_hash"):
                    continue
                if not previous.get("visible"):
                    should_publish = initial_publishable(event, path) if initial or size_changed else False
                    if not should_publish:
                        previous["delivered_hash"] = event_hash
                        continue
                    previous["visible"] = True
                if post(event):
                    previous["delivered_hash"] = event_hash
                    if event.get("status") in {"completed", "failed"}:
                        # The desktop retains terminal cards. The watcher no
                        # longer needs this slot, so another active parent can
                        # enter the bounded follow set on next discovery.
                        previous["visible"] = False
            time.sleep(FOLLOW_SECONDS)
    finally:
        remove_owned_pid()
    return 0


if __name__ == "__main__":
    if "--snapshot" in sys.argv:
        for item in snapshot():
            print(json.dumps(item, ensure_ascii=False, separators=(",", ":")))
        raise SystemExit(0)
    raise SystemExit(run())
