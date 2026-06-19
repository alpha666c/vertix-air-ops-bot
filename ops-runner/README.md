# Vertix Ops Runner

Small HTTP service for Slack/n8n to run approved local operations on the EC2 host.

The runner is not a general shell. It only executes command IDs defined in `runner.py`, requires `X-Vertix-Ops-Token`, and returns bounded command output.

## Commands

| Command ID | Purpose |
| --- | --- |
| `status` | Show `docker compose ps` for `/opt/vertix-air`. |
| `crewai_logs` | Return the last CrewAI container logs. |
| `smoke_crewai` | Run `/opt/vertix-air/bin/smoke-crewai.sh`. |

## Environment

```bash
OPS_RUNNER_ROOT=/opt/vertix-air
OPS_RUNNER_BIND=127.0.0.1
OPS_RUNNER_PORT=8799
OPS_RUNNER_TOKEN=<64+ char random token>
OPS_RUNNER_TIMEOUT=60
OPS_RUNNER_MAX_OUTPUT_CHARS=12000
```

Keep `OPS_RUNNER_TOKEN` in the EC2 `.env` or systemd environment file. Do not commit it.

## Local EC2 test

```bash
curl -fsS http://127.0.0.1:8799/health

curl -fsS -X POST http://127.0.0.1:8799/run \
  -H "X-Vertix-Ops-Token: $OPS_RUNNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commandId":"smoke_crewai"}'
```

Or use the helper:

```bash
bash /opt/vertix-air/ops-runner/bin/smoke-runner.sh smoke_crewai
```

If `/health` succeeds but `/run` returns `401`, the process and the shell are using different token values. Restart the service after changing the environment file:

```bash
sudo systemctl daemon-reload
sudo systemctl restart vertix-ops-runner
sudo journalctl -u vertix-ops-runner --no-pager -n 80
```

## n8n reachability

When this runs as a host systemd service bound to `127.0.0.1`, Docker containers cannot call it through their own `127.0.0.1`. Use one of these deployment choices:

- Preferred first setup: n8n calls the host runner through the Docker host gateway and the runner binds only to the Docker bridge address.
- Later hardening: package the runner as a private Compose service on the same internal Docker network as n8n.

Do not expose this runner on the public internet.
