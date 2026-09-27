#!/usr/bin/env python3
"""Bounded metadata-only Hermes session reconciler for Petdesk.

Hermes gateways retain their hook registry for the life of the service. This
small companion covers the interval after Petdesk is installed but before an
already-running gateway can safely restart: it discovers only recent,
top-level active sessions in the active profile's state database and posts a
canonical card update through the existing reverse tunnel. It intentionally
does not read or forward assistant message content, tool arguments, or
workspace paths; normal lifecycle hooks resume richer updates after reload.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


HOME = Path.home()
HERMES_ROOT = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path(
    os.environ.get("HERMES_HOME") or (HOME / ".hermes")
).expanduser()
RUNTIME = HOME / ".petdex" / "runtime"
TOKEN = RUNTIME / "update-token"
REMOTE_HOST = RUNTIME / "remote-host"
LEASE = RUNTIME / "tunnel-lease"
LOCK = RUNTIME / "hermes-watch.lock"
PID = RUNTIME / "hermes-watch.pid"
ENDPOINT = "http://127.0.0.1:7777/bubble"
DISCOVERY_SECONDS = 2.0
MAX_WATCHES = 8
# Hermes commonly leaves ended/abandoned gateway rows open. Reconciliation is
# a fallback for an already-running gateway, not a session browser: require a
# recent durable progress description before creating any card. Normal hooks
# own richer, longer-lived updates after the gateway reloads.
ACTIVE_RECONCILE_MAX_AGE_SECONDS = 90
PROFILE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
SUBAGENT_SOURCES = {
    "subagent",
    "sub-agent",
    "sub_agent",
    "child",
    "worker",
    "delegate",
    "delegated",
    "delegation",
    "background",
    "tool",
}


def compact(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def remote_hostname() -> str:
    try:
        return compact(REMOTE_HOST.read_text(encoding="utf-8"), 64)
    except OSError:
        return ""


def canonical_key(value: Any) -> str:
    cleaned = " ".join(str(value or "").split())
    if cleaned and len(cleaned) <= 64 and all(
        char.isascii() and (char.isalnum() or char in "-_") for char in cleaned
    ):
        return cleaned
    return hashlib.sha256(cleaned.encode("utf-8")).hexdigest() if cleaned else ""


def lease_alive() -> bool:
    try:
        return max(0.0, time.time() - LEASE.stat().st_mtime) <= 10.0
    except OSError:
        return False


def remove_owned_pid() -> None:
    try:
        if PID.read_text(encoding="utf-8").strip() == str(os.getpid()):
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


def active_home() -> Path:
    """Return the active Hermes profile home without trusting arbitrary text."""

    try:
        name = (HERMES_ROOT / "active_profile").read_text(encoding="utf-8").strip()
    except OSError:
        return HERMES_ROOT
    if name == "default" or not PROFILE_NAME.fullmatch(name):
        return HERMES_ROOT
    candidate = HERMES_ROOT / "profiles" / name
    return candidate if candidate.is_dir() else HERMES_ROOT


def timestamp(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def is_subagent(
    source: Any,
    model_config: Any,
    parent_session_id: Any,
    session_key: Any,
) -> bool:
    normalized = str(source or "").strip().lower()
    if normalized in SUBAGENT_SOURCES:
        return True
    try:
        config = json.loads(model_config) if model_config else {}
    except (TypeError, ValueError):
        config = {}
    if isinstance(config, dict) and bool(config.get("_delegate_from")):
        return True
    # A delegated row can be observed between parent linkage and persistence
    # of `_delegate_from`. Real compression/continuation rows retain their
    # stable session_key; an unkeyed child with a parent is safe to suppress.
    return bool(str(parent_session_id or "").strip()) and not bool(
        str(session_key or "").strip()
    )


def snapshot() -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]] | None:
    """Return active records plus terminal transitions for prior records."""

    db_path = active_home() / "state.db"
    if not db_path.is_file():
        return None
    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.15) as db:
            columns = {str(row[1]) for row in db.execute("PRAGMA table_info(sessions)")}
            required = {
                "id",
                "session_key",
                "title",
                "source",
                "model_config",
                "parent_session_id",
                "started_at",
                "last_activity_at",
                "last_activity_description",
                "ended_at",
            }
            if not required.issubset(columns):
                return None
            rows = db.execute(
                """
                SELECT id, session_key, title, source, model_config,
                       parent_session_id, started_at, last_activity_at,
                       last_activity_description, ended_at
                FROM sessions
                ORDER BY COALESCE(last_activity_at, started_at) DESC
                LIMIT 32
                """
            ).fetchall()
    except (OSError, sqlite3.Error):
        return None

    now = time.time()
    hostname = remote_hostname()
    events: list[dict[str, Any]] = []
    terminals: dict[str, dict[str, Any]] = {}
    for row in rows:
        source_session_id = compact(row[0], 96)
        if not source_session_id or is_subagent(row[3], row[4], row[5], row[1]):
            continue
        conversation_key = canonical_key(row[1] or source_session_id)
        if not conversation_key:
            continue
        activity = compact(row[8], 160)
        activity_at = timestamp(row[7] or row[6])
        title = compact(row[2], 256) or "Hermes session"
        base = {
            "agent_source": "hermes",
            "remote": True,
            "hostname": hostname,
            "session_id": conversation_key,
            "source_session_id": source_session_id,
            "conversation_key": conversation_key,
            "session_kind": "primary",
            "title": title,
            "title_source": "server",
            "feed_source": "state-db",
        }
        ended = bool(row[9])
        stale = (
            not activity
            or activity_at <= 0
            or max(0.0, now - activity_at) > ACTIVE_RECONCILE_MAX_AGE_SECONDS
        )
        if ended or stale:
            terminals[conversation_key] = {
                **base,
                "text": "Done." if ended else "Idle.",
                "busy": False,
                "event_kind": "session-end" if ended else "reconcile-idle",
                "message_kind": "status",
                "status": "completed" if ended else "idle",
            }
            continue
        events.append(
            {
                **base,
                # This is intentionally metadata-only. Rich assistant prose
                # comes from lifecycle hooks once a running gateway reloads.
                "text": activity,
                "busy": True,
                "event_kind": "reconcile",
                "message_kind": "status",
                "status": "running",
            }
        )
        if len(events) >= MAX_WATCHES:
            break
    return events, terminals


def digest(event: dict[str, Any]) -> str:
    data = json.dumps(event, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


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


def run() -> int:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    if not lease_alive():
        return 75
    with LOCK.open("w", encoding="utf-8") as lock:
        if not acquire_lock(lock):
            return 75
        PID.write_text(str(os.getpid()), encoding="utf-8")
        previous: dict[str, dict[str, Any]] = {}
        try:
            while lease_alive():
                result = snapshot()
                if result is None:
                    time.sleep(DISCOVERY_SECONDS)
                    continue
                active, terminals = result
                current: set[str] = set()
                for event in active:
                    key = str(event["conversation_key"])
                    current.add(key)
                    value = digest(event)
                    if previous.get(key, {}).get("digest") == value:
                        continue
                    # Keep retrying a new event until the reverse tunnel is
                    # available; only a successful post advances the digest.
                    if post(event):
                        previous[key] = {"digest": value, "event": event}
                for key in tuple(previous):
                    if key not in current:
                        terminal = terminals.get(key)
                        if terminal is None:
                            terminal = {
                                **previous[key]["event"],
                                "text": "Idle.",
                                "busy": False,
                                "event_kind": "reconcile-idle",
                                "message_kind": "status",
                                "status": "idle",
                            }
                        if post(terminal):
                            previous.pop(key, None)
                time.sleep(DISCOVERY_SECONDS)
        finally:
            remove_owned_pid()
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
