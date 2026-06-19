#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/../.."

python3 -m py_compile ops-runner/runner.py
bash -n ops-runner/bin/smoke-runner.sh
bash -n ops-runner/bin/validate.sh
