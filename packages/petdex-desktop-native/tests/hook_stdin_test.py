#!/usr/bin/env python3
"""Exercise the native hook runner's bounded stdin lifetime.

The runner exits before starting the desktop UI.  Keeping the parent pipe open
therefore tests the exact failure mode that used to leave agent hook processes
waiting forever, without requiring a display, a token, or a running server.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


MAX_EXIT_SECONDS = 3.0


def run_case(binary: Path, label: str, payload: bytes | None) -> None:
    with tempfile.TemporaryDirectory(prefix="petdex-hook-test-") as home:
        env = os.environ.copy()
        env["HOME"] = home
        env["USERPROFILE"] = home
        env["APPDATA"] = home

        child = subprocess.Popen(
            [str(binary), "bubble", "post", "codex"],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        try:
            if payload is not None:
                assert child.stdin is not None
                child.stdin.write(payload)
                child.stdin.flush()
                # Deliberately do not close stdin.  The parent keeps the pipe
                # open to reproduce hosts that write JSON but never send EOF.

            started = time.monotonic()
            try:
                exit_code = child.wait(timeout=MAX_EXIT_SECONDS)
            except subprocess.TimeoutExpired as error:
                child.kill()
                child.wait()
                raise AssertionError(f"native hook did not exit for {label}") from error

            elapsed = time.monotonic() - started
            if exit_code != 0:
                raise AssertionError(f"native hook exited {exit_code} for {label}")
            if elapsed > MAX_EXIT_SECONDS:
                raise AssertionError(f"native hook exceeded timeout for {label}")
        finally:
            if child.stdin is not None:
                child.stdin.close()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: hook_stdin_test.py <native-binary>", file=sys.stderr)
        return 2

    binary = Path(sys.argv[1])
    if not binary.is_file() and Path(f"{binary}.exe").is_file():
        binary = Path(f"{binary}.exe")
    if not binary.is_file():
        print("native hook binary is missing", file=sys.stderr)
        return 2

    run_case(binary, "complete payload without EOF", b'{"tool_name":"Read"}')
    run_case(binary, "silent stdin", None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
