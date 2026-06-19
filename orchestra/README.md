# Agent Council

The council is the operating model for Vertix Air ops.

It should start simple. Do not build five autonomous services first. Build one Slack-facing coordinator with clear internal roles and one safe terminal bridge.

## Roles

| Role | Job |
| --- | --- |
| Commander | Understand the Slack request and decide which workflow should run. |
| Operator | Run allowlisted command IDs through the local runner. |
| Analyst | Interpret logs/results and recommend the next step. |
| Reviewer | Enforce approvals, safety boundaries, and secret handling. |
| Archivist | Turn verified setup changes into GitHub docs or PRs. |

## First useful flow

1. User asks Slack: "Run CrewAI smoke test."
2. Commander maps request to `smoke_crewai`.
3. Reviewer checks that it is read-only and does not require approval.
4. Operator calls the local runner through n8n.
5. Analyst summarizes the result.
6. Archivist updates docs only if the setup changed.

## Terminal access rule

The council does not get raw terminal access. It gets an allowlisted runner with named commands. Add new commands in code review, not from a Slack message.

## When to expand

Add more agents only after these basics work:

- Slack request reaches n8n.
- n8n reaches the runner.
- Runner returns command output.
- Approval flow exists for mutating actions.
- GitHub stores docs and runner code.
