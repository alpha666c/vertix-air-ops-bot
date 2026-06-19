#!/usr/bin/env python3
"""Allowlisted local command runner for Vertix Air ops.

This service is intentionally small. It accepts only named command IDs, requires
an ops token for execution, and returns bounded stdout/stderr for Slack/n8n.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(os.environ.get("OPS_RUNNER_ROOT", "/opt/vertix-air")).resolve()
BIND = os.environ.get("OPS_RUNNER_BIND", "127.0.0.1")
PORT = int(os.environ.get("OPS_RUNNER_PORT", "8799"))
TOKEN = os.environ.get("OPS_RUNNER_TOKEN", "")
TIMEOUT_SECONDS = int(os.environ.get("OPS_RUNNER_TIMEOUT", "60"))
MAX_OUTPUT_CHARS = int(os.environ.get("OPS_RUNNER_MAX_OUTPUT_CHARS", "12000"))


@dataclass(frozen=True)
class CommandSpec:
    argv: list[str]
    cwd: Path = ROOT
    timeout_seconds: int = TIMEOUT_SECONDS


COMMANDS: dict[str, CommandSpec] = {
    "status": CommandSpec(["docker", "compose", "ps"]),
    "crewai_logs": CommandSpec(["docker", "compose", "logs", "--tail=120", "crewai"]),
    "smoke_crewai": CommandSpec([str(ROOT / "bin" / "smoke-crewai.sh")]),
}


def bounded(value: str) -> str:
    if len(value) <= MAX_OUTPUT_CHARS:
        return value
    return value[-MAX_OUTPUT_CHARS:]


def run_command(command_id: str) -> dict[str, Any]:
    spec = COMMANDS.get(command_id)
    if spec is None:
        return {
            "ok": False,
            "error": "unknown_command",
            "commands": sorted(COMMANDS.keys()),
        }

    started = time.monotonic()
    try:
        completed = subprocess.run(
            spec.argv,
            cwd=str(spec.cwd),
            text=True,
            capture_output=True,
            timeout=spec.timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "commandId": command_id,
            "error": "timeout",
            "timeoutSeconds": spec.timeout_seconds,
            "stdout": bounded(exc.stdout or ""),
            "stderr": bounded(exc.stderr or ""),
        }
    except FileNotFoundError as exc:
        return {
            "ok": False,
            "commandId": command_id,
            "error": "missing_executable",
            "detail": str(exc),
        }

    return {
        "ok": completed.returncode == 0,
        "commandId": command_id,
        "returncode": completed.returncode,
        "durationMs": int((time.monotonic() - started) * 1000),
        "stdout": bounded(completed.stdout),
        "stderr": bounded(completed.stderr),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "VertixOpsRunner/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any] | None:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_json"})
            return None
        if not isinstance(value, dict):
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_body"})
            return None
        return value

    def do_GET(self) -> None:
        if self.path != "/health":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
            return
        self._json(
            HTTPStatus.OK,
            {
                "ok": True,
                "service": "vertix-ops-runner",
                "commands": sorted(COMMANDS.keys()),
            },
        )

    def do_POST(self) -> None:
        if self.path != "/run":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
            return
        if not TOKEN:
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "token_not_configured"})
            return
        if self.headers.get("X-Vertix-Ops-Token", "") != TOKEN:
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"})
            return

        body = self._read_json()
        if body is None:
            return
        command_id = str(body.get("commandId", "")).strip()
        if not command_id:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "missing_command_id"})
            return

        result = run_command(command_id)
        status = HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_REQUEST
        self._json(status, result)


def main() -> int:
    if not ROOT.exists():
        print(f"warning: OPS_RUNNER_ROOT does not exist: {ROOT}", file=sys.stderr)
    if not TOKEN:
        print("warning: OPS_RUNNER_TOKEN is not configured; /run will reject requests", file=sys.stderr)

    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"VertiX ops runner listening on {BIND}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopping", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
