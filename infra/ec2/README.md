# EC2 Deployment Notes

## Current target

Host:

- Deployment root: `/opt/vertix-air`
- Runner: `/opt/vertix-air/ops-runner/runner.py`
- n8n public URL: `https://n8n.crypto-alpha.cloud`
- Runner default bind: `127.0.0.1:8799`

## Network choices

### Option A: Host systemd runner

Use systemd for the runner and keep it off the public internet.

Pros:

- Simple to debug with `journalctl`.
- Direct access to host Docker CLI and `/opt/vertix-air`.

Cons:

- Dockerized n8n cannot call host `127.0.0.1` directly.
- Requires explicit host-gateway or bridge networking.

### Option B: Internal Compose runner

Run the runner as a private Docker Compose service on the same internal network as n8n.

Pros:

- n8n can call `http://ops-runner:8799`.
- Easier to keep network private.

Cons:

- Needs Docker socket or a narrow host-control bridge if it must operate host containers.
- More packaging work.

## Recommended path

Use Option A for the first working version because it matches the current EC2 state. Move to Option B after Slack/n8n command flow is stable.
