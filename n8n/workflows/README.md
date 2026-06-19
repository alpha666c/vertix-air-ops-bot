# n8n Workflow Contract

Store workflow exports here only after removing secrets.

## First workflow: Slack to local runner

Trigger:

- Slack slash command, Slack app action, or n8n webhook.

Steps:

1. Parse requested command.
2. Map it to a runner command ID.
3. If command is mutating, request human approval in Slack.
4. Call the local runner.
5. Summarize result in the Slack thread.

## Runner request

```http
POST /run
X-Vertix-Ops-Token: <stored in n8n credentials>
Content-Type: application/json
```

```json
{"commandId":"status"}
```

## Safe command IDs

- `status`
- `crewai_logs`
- `smoke_crewai`

Add new commands in `ops-runner/runner.py` first, then update this document and the Slack command menu.

## Secrets

Do not export real values for:

- Slack bot tokens
- Slack signing secrets
- Qwen/DashScope/API keys
- `OPS_RUNNER_TOKEN`
- n8n credentials
