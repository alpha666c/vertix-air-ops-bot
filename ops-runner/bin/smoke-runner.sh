#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/opt/vertix-air}"
RUNNER_URL="${OPS_RUNNER_URL:-http://127.0.0.1:8799}"
TOKEN="${OPS_RUNNER_TOKEN:-}"
COMMAND_ID="${1:-status}"

if [[ -z "$TOKEN" && -f "$ROOT/.env" ]]; then
  TOKEN="$(
    ROOT="$ROOT" python3 - <<'PY'
from pathlib import Path
import os

env_path = Path(os.environ["ROOT"]) / ".env"
for line in env_path.read_text().splitlines():
    if line.startswith("OPS_RUNNER_TOKEN="):
        print(line.split("=", 1)[1].strip().strip('"').strip("'"))
        break
PY
  )"
fi

if [[ -z "$TOKEN" ]]; then
  echo "OPS_RUNNER_TOKEN is not set and was not found in $ROOT/.env" >&2
  exit 2
fi

curl -fsS "$RUNNER_URL/health"
printf '\n'

curl -fsS -X POST "$RUNNER_URL/run" \
  -H "X-Vertix-Ops-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"commandId\":\"$COMMAND_ID\"}"
printf '\n'
