#!/usr/bin/env python3
"""Behavioral oracles for the embedded SSH session reconcilers."""

from __future__ import annotations

import importlib.util
import fcntl
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "src" / "assets" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CodexWatcherTests(unittest.TestCase):
    def test_rollout_following_parses_only_appended_bytes(self) -> None:
        watcher = load("petdex_codex_watch_test", "petdex-codex-watch.py")
        with tempfile.TemporaryDirectory() as directory:
            rollout = Path(directory) / "rollout-00000000-0000-0000-0000-000000000001.jsonl"
            initial = [
                {"type": "session_meta", "payload": {"cwd": "/work"}},
                {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
                {"type": "event_msg", "payload": {"type": "agent_reasoning", "text": "Checking"}},
            ]
            rollout.write_text(
                "".join(json.dumps(item) + "\n" for item in initial), encoding="utf-8"
            )
            state, offset = watcher.initial_rollout_state(rollout)
            event = watcher.event_from_state(rollout, "Title", state)
            self.assertEqual("Checking", event["text"])
            self.assertEqual("running", event["status"])

            encoded = json.dumps(
                {
                    "type": "event_msg",
                    "payload": {"type": "agent_message", "message": "Done now"},
                }
            ) + "\n"
            midpoint = len(encoded) // 2
            with rollout.open("a", encoding="utf-8") as handle:
                handle.write(encoded[:midpoint])
            partial_size = rollout.stat().st_size
            state, offset = watcher.append_rollout_state(
                rollout, state, offset, partial_size
            )
            event = watcher.event_from_state(rollout, "Title", state)
            self.assertEqual("Checking", event["text"])

            with rollout.open("a", encoding="utf-8") as handle:
                handle.write(encoded[midpoint:])
            size = rollout.stat().st_size
            state, offset = watcher.append_rollout_state(rollout, state, offset, size)
            event = watcher.event_from_state(rollout, "Title", state)
            self.assertEqual(size, offset)
            self.assertEqual("Done now", event["text"])

    def test_bare_completion_replaces_transient_copy_and_keeps_prose(self) -> None:
        watcher = load("petdex_codex_completion_test", "petdex-codex-watch.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transient = root / "rollout-00000000-0000-0000-0000-000000000010.jsonl"
            transient_rows = [
                {"type": "event_msg", "payload": {"type": "task_started"}},
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "request_user_input",
                        "call_id": "q1",
                        "arguments": json.dumps({"questions": [{"question": "Continue?"}]}),
                    },
                },
                {
                    "type": "response_item",
                    "payload": {"type": "function_call_output", "call_id": "q1"},
                },
                {"type": "event_msg", "payload": {"type": "task_complete"}},
            ]
            transient.write_text(
                "".join(json.dumps(row) + "\n" for row in transient_rows),
                encoding="utf-8",
            )
            event = watcher.parse_rollout(transient, "Transient")
            self.assertEqual("completed", event["status"])
            self.assertFalse(event["busy"])
            self.assertEqual("Done.", event["text"])

            prose = root / "rollout-00000000-0000-0000-0000-000000000011.jsonl"
            prose_rows = [
                {"type": "event_msg", "payload": {"type": "task_started"}},
                {
                    "type": "event_msg",
                    "payload": {"type": "agent_message", "message": "Useful final answer."},
                },
                {
                    "type": "event_msg",
                    "payload": {"type": "task_complete", "last_agent_message": "   "},
                },
            ]
            prose.write_text(
                "".join(json.dumps(row) + "\n" for row in prose_rows),
                encoding="utf-8",
            )
            retained = watcher.parse_rollout(prose, "Prose")
            self.assertEqual("completed", retained["status"])
            self.assertFalse(retained["busy"])
            self.assertEqual("Useful final answer.", retained["text"])

    def test_subagent_rollouts_do_not_hide_an_older_primary(self) -> None:
        watcher = load("petdex_codex_subagent_test", "petdex-codex-watch.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def rollout(session_id: str, metadata: dict[str, object]) -> Path:
                path = root / f"rollout-{session_id}.jsonl"
                rows = [
                    {"type": "session_meta", "payload": {"id": session_id, **metadata}},
                    {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
                    {"type": "event_msg", "payload": {"type": "agent_reasoning", "text": "Working"}},
                ]
                path.write_text(
                    "".join(json.dumps(row) + "\n" for row in rows),
                    encoding="utf-8",
                )
                return path

            primary_id = "00000000-0000-0000-0000-000000000001"
            catalog = {primary_id: rollout(primary_id, {"thread_source": "user"})}
            for index in range(watcher.MAX_WATCHES):
                child_id = f"00000000-0000-0000-0000-{index + 2:012d}"
                catalog[child_id] = rollout(
                    child_id,
                    {
                        "thread_source": "subagent",
                        "source": {"subagent": "worker"},
                        "parent_thread_id": primary_id,
                        "agent_nickname": f"worker-{index}",
                    },
                )
                # Make every child newer than the real parent.
                modified = time.time() + index + 1
                os.utime(catalog[child_id], (modified, modified))

            selected = watcher.discovery_paths(catalog, {}, {})
            self.assertEqual({primary_id}, set(selected))
            for child_id, path in catalog.items():
                if child_id != primary_id:
                    self.assertIsNone(watcher.parse_rollout(path, "Child"))

    def test_large_rollout_keeps_subagent_metadata_outside_the_tail(self) -> None:
        watcher = load("petdex_codex_large_subagent_test", "petdex-codex-watch.py")
        watcher.MAX_ROLLOUT_BYTES = 256
        with tempfile.TemporaryDirectory() as directory:
            session_id = "00000000-0000-0000-0000-000000000099"
            rollout = Path(directory) / f"rollout-{session_id}.jsonl"
            rows = [
                {
                    "type": "session_meta",
                    "payload": {
                        "thread_source": "subagent",
                        "source": {"subagent": "worker"},
                        "parent_thread_id": "00000000-0000-0000-0000-000000000001",
                        "agent_nickname": "worker",
                    },
                },
                *(
                    {"type": "event_msg", "payload": {"type": "agent_reasoning", "text": "filler"}}
                    for _ in range(12)
                ),
            ]
            rollout.write_text(
                "".join(json.dumps(row) + "\n" for row in rows),
                encoding="utf-8",
            )
            self.assertGreater(rollout.stat().st_size, watcher.MAX_ROLLOUT_BYTES)
            self.assertIsNone(watcher.parse_rollout(rollout, "Child"))


class HermesWatcherTests(unittest.TestCase):
    def test_custom_home_yields_canonical_active_and_terminal_events(self) -> None:
        watcher = load("petdex_hermes_watch_test", "petdex-hermes-watch.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            watcher.HERMES_ROOT = root
            now = time.time()
            with sqlite3.connect(root / "state.db") as database:
                database.execute(
                    """
                    CREATE TABLE sessions (
                        id TEXT, session_key TEXT, title TEXT, source TEXT,
                        model_config TEXT, parent_session_id TEXT,
                        started_at REAL, last_activity_at REAL,
                        last_activity_description TEXT, ended_at REAL
                    )
                    """
                )
                database.execute(
                    "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("raw", "stable.key", "Top", "primary", "{}", "", now, now, "Working", None),
                )
                database.execute(
                    "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("ended", "ended-key", "Done", "primary", "{}", "", now, now, "Finished", now),
                )
                database.execute(
                    "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("child", "", "Worker", "subagent", '{"_delegate_from":"raw"}', "raw", now, now, "Tool noise", None),
                )
                database.execute(
                    "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("delegated", "delegated-key", "Worker", "desktop", '{"_delegate_from":"raw"}', "raw", now, now, "Tool noise", None),
                )
                # A keyed parent-linked continuation without delegation
                # metadata is a real conversation, not a worker.
                database.execute(
                    "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("continuation", "continuation-key", "Continued", "desktop", "{}", "raw", now, now, "Working", None),
                )

            result = watcher.snapshot()
            self.assertIsNotNone(result)
            active, terminals = result
            canonical = watcher.canonical_key("stable.key")
            self.assertEqual(64, len(canonical))
            self.assertEqual(
                {canonical, "continuation-key"},
                {event["session_id"] for event in active},
            )
            self.assertEqual("completed", terminals["ended-key"]["status"])


class WatcherOwnershipTests(unittest.TestCase):
    def test_pid_cleanup_never_removes_another_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for name, filename in (
                ("codex_pid_test", "petdex-codex-watch.py"),
                ("hermes_pid_test", "petdex-hermes-watch.py"),
            ):
                watcher = load(name, filename)
                watcher.PID = Path(directory) / f"{name}.pid"
                watcher.PID.write_text("999999", encoding="ascii")
                watcher.remove_owned_pid()
                self.assertTrue(watcher.PID.exists())
                watcher.PID.write_text(str(os.getpid()), encoding="ascii")
                watcher.remove_owned_pid()
                self.assertFalse(watcher.PID.exists())

    def test_lock_acquisition_waits_for_previous_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for name, filename in (
                ("codex_lock_test", "petdex-codex-watch.py"),
                ("hermes_lock_test", "petdex-hermes-watch.py"),
            ):
                watcher = load(name, filename)
                path = Path(directory) / f"{name}.lock"
                with path.open("a+") as first, path.open("a+") as second:
                    fcntl.flock(first.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    release = threading.Timer(0.2, lambda: fcntl.flock(first.fileno(), fcntl.LOCK_UN))
                    release.start()
                    self.assertTrue(watcher.acquire_lock(second))
                    release.join()


class RemoteIdentityTests(unittest.TestCase):
    def test_watchers_publish_the_configured_remote_principal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            remote_host = Path(directory) / "remote-host"
            remote_host.write_text("configured-alias\n", encoding="utf-8")
            watchers = []
            for name, filename in (
                ("codex_remote_identity_test", "petdex-codex-watch.py"),
                ("hermes_remote_identity_test", "petdex-hermes-watch.py"),
            ):
                watcher = load(name, filename)
                watcher.REMOTE_HOST = remote_host
                watchers.append(watcher)
                self.assertEqual("configured-alias", watcher.remote_hostname())

            remote_host.unlink()
            for watcher in watchers:
                self.assertEqual("", watcher.remote_hostname())


if __name__ == "__main__":
    unittest.main()
