# Vertix Air — Ops Orchestrator Bot

LLM-powered Slack orchestrator that acts as the brain behind the **Vertix Air operations** Slack app (`A0BATSMGQF3`). It coordinates handoffs, blockers, status, and the first safe terminal bridge for the Vertix Air EC2 host.

## What it does

- **Detects handoffs** ("backend done" / "ui done") and auto-tags the next agent with a *specific* ask.
- **Enforces the handoff template** — nudges when Scope / Expected behavior / Known gaps are missing.
- **Enforces the QA gate** — blocks any "done" claim until the *opposite* role signs off.
- **Surfaces `BLOCKED:`** — escalates to the owner (Viktor) with the exact decision needed.
- **Mirrors decisions** to `#vertix-ops-log`.
- **Tracks task status** (open / in_progress / in_review / blocked / done) and posts a board summary.
- **GitHub tie-in** — announces CodeRabbit PR reviews in Slack and tags UI to QA on approval.
- **Local ops runner** — exposes allowlisted EC2 command IDs for n8n/Slack workflows without giving agents a raw shell.

## Stack

Bun + Hono (API) + Drizzle/SQLite (state) + AI Gateway (`generateText`). Backend-only — Slack is the UI.

## Current ops setup path

Use these docs for the EC2/n8n/CrewAI setup:

| Path | Purpose |
|------|---------|
| `docs/sitrep.md` | Current situation, what failed, and the recommended next move. |
| `docs/architecture.md` | Slack -> bot -> n8n -> local runner architecture and council model. |
| `docs/runbook.md` | Step-by-step EC2 setup and smoke tests. |
| `ops-runner/` | Token-protected allowlisted local command runner. |
| `orchestra/` | Agent council roles and approval policy. |
| `n8n/workflows/` | Workflow contract for Slack/n8n runner calls. |
| `infra/ec2/` | EC2 deployment and networking notes. |

## Architecture

```
Slack event ─► /api/slack/events ─► verify sig ─► ack ─► orchestrator
                                                              │
                          thread context ◄── Slack Web API    │
                                                              ▼
                                                          brain (LLM)
                                                              │  Decision JSON
                                                              ▼
                          post tag/reply ─► dev-sync thread + #vertix-ops-log
                                                              │
                                                          persist (tasks / handoffs / event_log)

GitHub PR review ─► /api/github/webhook ─► verify sig ─► announce + tag UI
```

## Key files

| File | Role |
|------|------|
| `packages/web/src/api/index.ts` | Routes: Slack events, GitHub webhook, summary |
| `packages/web/src/api/ops/config.ts` | Channel/agent IDs, roles, mention helpers |
| `packages/web/src/api/ops/slack.ts` | Signature verify + Slack Web API |
| `packages/web/src/api/ops/brain.ts` | The LLM decision engine (system prompt + JSON parse) |
| `packages/web/src/api/ops/orchestrator.ts` | Ties brain+slack+db, executes decisions |
| `packages/web/src/api/ops/github.ts` | PR review handling |
| `packages/web/src/api/database/schema.ts` | tasks / handoffs / event_log / processed_events |
| `ops-runner/runner.py` | Local allowlisted terminal runner for EC2 |
| `orchestra/council.yaml` | Agent council contract |

## Endpoints

- `POST /api/slack/events` — Slack Events API (handshake + signed events)
- `POST /api/github/webhook` — GitHub `pull_request_review`
- `POST /api/ops/summary` — post task board (`{ "channel": "C..." }`, optional)
- `GET /api/health`

## Environment

```
# AI gateway (provided by template)
AI_GATEWAY_BASE_URL=
AI_GATEWAY_API_KEY=

# Slack — from api.slack.com/apps -> A0BATSMGQF3
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Channel + agent IDs (defaults baked in; override to re-point)
SLACK_DEV_SYNC_CHANNEL_ID=C0BB9P41XTL     # #development-sync
SLACK_OPS_LOG_CHANNEL_ID=C0BBLHPR116      # #vertix-ops-log
SLACK_OWNER_USER_ID=                       # Viktor — for real @ pings on blockers
SLACK_AGENT_UI_USER_ID=                    # Runable bot member id
SLACK_AGENT_BACKEND_USER_ID=               # CodeRabbit bot member id

# GitHub
GITHUB_WEBHOOK_SECRET=

OPS_MODEL=anthropic/claude-sonnet-4.6

# Local EC2 ops runner
OPS_RUNNER_ROOT=/opt/vertix-air
OPS_RUNNER_BIND=127.0.0.1
OPS_RUNNER_PORT=8799
OPS_RUNNER_TOKEN=
OPS_RUNNER_TIMEOUT=60
```

## Slack app setup (A0BATSMGQF3)

1. **OAuth scopes** (Bot Token Scopes): `app_mentions:read`, `channels:history`, `chat:write`, `groups:read`, `users:read`, `channels:manage`.
2. **Event Subscriptions** → Request URL = `https://<deploy-host>/api/slack/events`; subscribe to bot events: `message.channels`, `app_mention`.
3. Install/reinstall the app, copy the **Bot Token** + **Signing Secret** into `.env`.
4. Invite the bot to `#development-sync` and `#vertix-ops-log`.

## GitHub setup

Repo → Settings → Webhooks → add `https://<deploy-host>/api/github/webhook`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events: *Pull request reviews*.

## Run

```bash
bun install
cd packages/web && bun run db:push   # create tables
cd ../.. && bun run dev --port 4200   # start
```
