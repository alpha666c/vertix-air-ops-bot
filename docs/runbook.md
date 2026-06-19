# EC2 Setup Runbook

Use this runbook to move from manual EC2 patches to a repeatable setup.

## 1. Put the repo on the host

```bash
cd /opt
sudo git clone https://github.com/alpha666c/vertix-air-ops-bot.git vertix-air-ops-bot
sudo rsync -a /opt/vertix-air-ops-bot/ops-runner/ /opt/vertix-air/ops-runner/
```

If `/opt/vertix-air` is already the deployment root, keep app runtime files there and treat this repo as the source for the ops runner and docs.

## 2. Configure the runner token

Generate a token on the host:

```bash
openssl rand -hex 32
```

Add it to `/opt/vertix-air/.env`:

```bash
OPS_RUNNER_TOKEN=<generated-token>
OPS_RUNNER_ROOT=/opt/vertix-air
OPS_RUNNER_BIND=127.0.0.1
OPS_RUNNER_PORT=8799
```

Do not commit the token.

## 3. Install systemd service

```bash
sudo cp /opt/vertix-air/ops-runner/systemd/vertix-ops-runner.service /etc/systemd/system/vertix-ops-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now vertix-ops-runner
sudo systemctl status vertix-ops-runner --no-pager
```

## 4. Smoke test locally

```bash
cd /opt/vertix-air
bash ops-runner/bin/smoke-runner.sh status
bash ops-runner/bin/smoke-runner.sh smoke_crewai
```

Expected:

- `/health` returns `ok: true`.
- `/run` returns `ok: true`.
- `smoke_crewai` shows a successful CrewAI response.

If `/run` returns `401`, restart the service and confirm the service environment:

```bash
sudo systemctl restart vertix-ops-runner
sudo journalctl -u vertix-ops-runner --no-pager -n 80
```

## 5. Connect n8n

In n8n, create an HTTP Request node:

- Method: `POST`
- URL: the runner URL reachable from the n8n container
- Header: `X-Vertix-Ops-Token`
- Header: `Content-Type: application/json`
- Body:

```json
{"commandId":"status"}
```

If n8n runs in Docker, do not use `http://127.0.0.1:8799` unless the runner is in the same container. Use a host-gateway address or package the runner into the Compose network.

## 6. Connect Slack

Recommended first version:

1. Slack sends command requests to the ops bot or n8n webhook.
2. n8n asks for confirmation for mutating commands.
3. n8n calls the runner with a command ID.
4. n8n posts stdout/stderr summary back to the Slack thread.
5. The ops bot or Archivist updates GitHub docs when the setup changes.

Do not connect Slack directly to arbitrary shell execution.
