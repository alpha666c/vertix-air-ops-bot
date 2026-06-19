# Vertix Air Ops Sitrep

As of 2026-06-19, the practical state is:

- n8n is reachable at `https://n8n.crypto-alpha.cloud`.
- CrewAI smoke testing is working on the EC2 host through `/opt/vertix-air/bin/smoke-crewai.sh`.
- The working Qwen-compatible endpoint is the US Model Studio compatible endpoint:
  - `QWEN_BASE_URL=https://dashscope-us.aliyuncs.com/compatible-mode/v1`
  - `QWEN_MODEL=openai/qwen3.7-max-2026-06-08`
- The local ops runner can start on `127.0.0.1:8799` and answer `/health`.
- `/run` must return `200` before Slack/n8n command execution is wired. A `401` means the runner process did not receive the same `OPS_RUNNER_TOKEN` as the client request.

## What is going wrong

The current failure mode is not an AI-agent problem. It is deployment hygiene:

- The EC2 host has working pieces that were patched manually.
- The runner script was edited directly on the server, which caused a Python syntax crash before it was fixed.
- Token and network boundaries are not yet captured in source control.
- Dockerized n8n cannot call a host service through its own `127.0.0.1`.

## Best next move

Make this repository the source of truth for the ops layer:

1. Keep the existing Slack orchestrator app here.
2. Add the local EC2 runner here.
3. Add the n8n workflow contract here.
4. Add the agent council contract here.
5. Deploy from GitHub to `/opt/vertix-air` instead of editing server files by hand.

Air Suite should become the dashboard and memory/control plane later. It should not be the first place where raw terminal command execution lives.
