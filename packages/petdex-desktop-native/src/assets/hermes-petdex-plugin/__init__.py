"""Petdesk lifecycle bridge for Hermes' dashboard/serve surfaces.

Hermes 0.20 registers config.yaml shell hooks for CLI and gateway agent
commands, but its Desktop backend is launched through ``hermes serve`` and
does not run that registration path.  ``serve`` does load enabled plugins,
so this compatibility plugin forwards the same lifecycle feed to the
same bounded Petdesk hook runner.  Other Hermes surfaces keep using their
native shell-hook configuration and are deliberately not duplicated here.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any


_PHASES = {
    "pre_tool_call": "pre",
    "post_tool_call": "post",
    # Carries user_message and is the only lifecycle event that can seed a
    # useful fallback before Hermes' background title generator finishes.
    "pre_llm_call": "user-prompt",
    "post_llm_call": "assistant",
    "pre_approval_request": "approval-request",
    "post_approval_response": "approval-response",
    "subagent_start": "subagent-start",
    "subagent_stop": "subagent-stop",
    "on_session_start": "session-start",
    "on_session_end": "session-end",
}


def _is_desktop_backend() -> bool:
    return any(arg in {"serve", "dashboard"} for arg in sys.argv[1:])


_SUBAGENT_SOURCES = {
    "subagent",
    "sub_agent",
    "child",
    "worker",
    "delegate",
    "delegated",
    "delegation",
    "background",
    "tool",
}


def _delegate_parent(row: dict[str, str]) -> str:
    """Return Hermes' durable delegate marker, if this row has one.

    Hermes deliberately gives compression forks and branch continuations the
    same ``parent_session_id`` relationship as delegated workers.  The
    ``model_config._delegate_from`` marker is the stable distinction, so a
    continuation must never be hidden just because it has a parent.
    """
    raw = row.get("model_config", "")
    try:
        value = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        value = {}
    if not isinstance(value, dict):
        return ""
    return str(value.get("_delegate_from") or "")


def _source_marks_subagent(row: dict[str, str]) -> bool:
    source = str(row.get("source") or "").strip().lower().replace("-", "_")
    if source in _SUBAGENT_SOURCES or bool(_delegate_parent(row)):
        return True
    # During child creation Hermes can persist the parent link before its
    # durable `_delegate_from` marker. Continuations keep a session_key;
    # parent-linked, unkeyed rows are therefore safe to suppress as children.
    return bool(row.get("parent_session_id")) and not bool(row.get("session_key"))


def _conversation_key(value: str) -> str:
    cleaned = " ".join(str(value or "").split())
    if cleaned and len(cleaned) <= 64 and all(
        char.isascii() and (char.isalnum() or char in "-_") for char in cleaned
    ):
        return cleaned
    return hashlib.sha256(cleaned.encode("utf-8")).hexdigest() if cleaned else ""


def _session_context(
    session_id: str,
    *,
    force_parent: str = "",
    force_subagent: bool = False,
    explicit_label: str = "",
) -> dict[str, str]:
    """Resolve a raw Hermes session to its stable top-level conversation.

    Continuations share ``session_key`` while worker sessions point at a
    parent. Walking that chain on each event observes background title updates
    and prevents either raw continuation ids or children becoming cards.
    """
    empty = {
        "conversation": session_id,
        "parent": "",
        "kind": "subagent" if force_subagent else "primary",
        "label": "",
        "title": "",
    }
    if not session_id:
        return empty
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    db_path = home / "state.db"
    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.05) as db:
            columns = {
                str(row[1])
                for row in db.execute("PRAGMA table_info(sessions)").fetchall()
            }
            wanted = [
                name
                for name in (
                    "id",
                    "title",
                    "display_name",
                    "source",
                    "model_config",
                    "parent_session_id",
                    "session_key",
                )
                if name in columns
            ]
            if "id" not in wanted:
                return empty

            def load(identifier: str) -> dict[str, str] | None:
                row = db.execute(
                    f"SELECT {','.join(wanted)} FROM sessions WHERE id = ? LIMIT 1",
                    (identifier,),
                ).fetchone()
                if not row:
                    return None
                return {
                    name: str(value or "")
                    for name, value in zip(wanted, row)
                }

            current = load(session_id)
            if not current:
                # Hermes fires subagent lifecycle callbacks immediately. A
                # worker may not have persisted its own row yet, but its
                # parent is already authoritative enough to choose the same
                # canonical card.
                if force_subagent and force_parent and force_parent != session_id:
                    parent_context = _session_context(force_parent)
                    return {
                        "conversation": parent_context["conversation"],
                        "parent": force_parent,
                        "kind": "subagent",
                        "label": explicit_label,
                        "title": parent_context["title"],
                    }
                return empty
            first = current
            chain = [current]
            seen = {session_id}
            for _ in range(16):
                parent = current.get("parent_session_id", "")
                if not parent or parent in seen:
                    break
                seen.add(parent)
                loaded = load(parent)
                if not loaded:
                    break
                chain.append(loaded)
                current = loaded
    except Exception:
        return empty

    root = chain[-1]
    conversation = next(
        (row.get("session_key", "") for row in reversed(chain) if row.get("session_key")),
        root.get("id", session_id),
    )
    title = next(
        (row.get("title", "") for row in reversed(chain) if row.get("title")),
        "",
    )
    marker_parent = _delegate_parent(first)
    kind = "subagent" if force_subagent or _source_marks_subagent(first) else "primary"
    parent = first.get("parent_session_id", "") or marker_parent or force_parent
    label = explicit_label or first.get("display_name", "") or (
        first.get("title", "") if kind == "subagent" else ""
    )

    def clean(value: str, limit: int) -> str:
        return " ".join(str(value or "").split())[:limit]

    return {
        "conversation": _conversation_key(conversation),
        "parent": clean(parent, 96),
        "kind": kind,
        "label": clean(label, 48),
        "title": clean(title, 256),
    }


def _callback(phase: str):
    def emit(**payload: Any) -> None:
        runner = Path.home() / ".petdex" / "bin" / "petdex-hook"
        if not runner.is_file():
            return
        try:
            # Hermes lifecycle hooks are parent-scoped: their top-level
            # session id identifies the parent while `child_session_id`
            # identifies the worker. Route those callbacks through the child
            # context so a child summary can fold into its parent card.
            parent_session_id = str(
                payload.get("parent_session_id") or payload.get("session_id") or ""
            )
            child_session_id = str(payload.get("child_session_id") or "")
            is_subagent_lifecycle = phase in {"subagent-start", "subagent-stop"}
            session_id = (child_session_id or parent_session_id) if is_subagent_lifecycle else str(
                payload.get("session_id") or payload.get("session_key") or ""
            )
            context = _session_context(
                session_id,
                force_parent=parent_session_id if is_subagent_lifecycle else "",
                force_subagent=is_subagent_lifecycle,
                explicit_label=str(payload.get("child_role") or ""),
            )
            # The base Petdex card model has no nested child hierarchy. Drop
            # delegated work instead of opening one top-level card per worker.
            if context["kind"] == "subagent" and not is_subagent_lifecycle:
                return
            if context["title"]:
                # Namespaced so a tool argument named `title` cannot be
                # mistaken for a server-side session rename by the runner.
                payload["petdex_session_title"] = context["title"]
            payload["petdex_conversation_key"] = context["conversation"]
            payload["petdex_parent_session_id"] = context["parent"]
            payload["petdex_session_kind"] = context["kind"]
            payload["petdex_subagent_label"] = context["label"]
            encoded = json.dumps(
                payload,
                default=str,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            subprocess.run(
                [str(runner), "bubble", phase, "hermes"],
                input=encoded,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=3,
                check=False,
            )
        except Exception:
            # A mascot bridge must never break or delay the agent outwardly.
            return

    return emit


def register(ctx) -> None:
    if not _is_desktop_backend():
        return
    for event, phase in _PHASES.items():
        ctx.register_hook(event, _callback(phase))
