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

            result = watcher.snapshot()
            self.assertIsNotNone(result)
            active, terminals = result
            canonical = watcher.canonical_key("stable.key")
            self.assertEqual(64, len(canonical))
            self.assertEqual(canonical, active[0]["session_id"])
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


if __name__ == "__main__":
    unittest.main()
