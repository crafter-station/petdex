import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading

binary = Path(sys.argv[1]).resolve()
if not binary.is_file():
    binary = Path(str(binary) + ".exe")
assert binary.is_file(), binary
requests = []
token = secrets.token_hex(24)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.headers.get("x-petdex-update-token") != token:
            self.send_error(403)
            return
        body = self.rfile.read(int(self.headers["Content-Length"]))
        requests.append((self.path, json.loads(body)))
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 7777), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix="petdex-hidden-hook-") as directory:
        home = Path(directory)
        runtime = home / ".petdex" / "runtime"
        runtime.mkdir(parents=True)
        (runtime / "update-token").write_text(token)
        environment = {
            **os.environ,
            "HOME": directory,
            "USERPROFILE": directory,
            "APPDATA": directory,
            "PWD": directory,
        }

        def send(phase, payload):
            before = len(requests)
            subprocess.run(
                [str(binary), "bubble", phase, "codex"],
                input=json.dumps(payload), text=True, env=environment,
                cwd=directory, check=True, timeout=5, capture_output=True,
            )
            return requests[before:]

        def journal_events():
            return [
                json.loads(line)["event"]
                for path in (runtime / "session-journal").glob("*.jsonl*")
                for line in path.read_text().splitlines()
            ]

        prompt = "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this Projectless task"
        assert not send("user-prompt", {"session_id": "hidden", "prompt": prompt})
        assert not send("pre", {"session_id": "hidden", "tool_name": "Read"})
        assert not send("post", {"session_id": "hidden", "tool_name": "Read"})
        assert not (runtime / "sessions" / "hidden.json").exists()
        assert "prompt" not in (runtime / "sessions" / "hidden.codex-hidden.json").read_text()

        assert not journal_events()

        for session, cwd in (("projectless", ""), ("workspace", "/project")):
            events = send("user-prompt", {"session_id": session, "cwd": cwd, "prompt": "Help me plan"})
            assert any(path == "/bubble" and body["session_id"] == session for path, body in events)
            assert (runtime / "sessions" / f"{session}.json").is_file()

        assert not send("user-prompt", {"session_id": "internal", "thread_source": "ambient_suggestions", "prompt": "Internal"})
        assert {event["session_id"] for event in journal_events()} == {"projectless", "workspace"}
        assert send("user-prompt", {"session_id": "hidden", "thread_source": "user", "prompt": "My visible task"})
        assert not (runtime / "sessions" / "hidden.codex-hidden.json").exists()
        (runtime / "update-token").unlink()
        before = journal_events()
        assert not send("user-prompt", {"session_id": "offline-hidden", "prompt": prompt})
        assert not send("pre", {"session_id": "offline-hidden", "tool_name": "Read"})
        assert journal_events() == before
        assert not (runtime / "sessions" / "offline-hidden.json").exists()
        assert not send("user-prompt", {"session_id": "offline-visible", "prompt": "Resume after restart"})
        assert any(event["session_id"] == "offline-visible" for event in journal_events())
        print("PASS: hidden hooks produce no posts, titles or journals; visible hooks journal while offline")
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
