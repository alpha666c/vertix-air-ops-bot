/**
 * Static configuration for the Vertix Air ops orchestrator.
 * Channel + user IDs are env-overridable so the bot can be re-pointed
 * without code changes.
 */

export const config = {
  // Channel the orchestrator watches for dev handoffs.
  devSyncChannelId: process.env.SLACK_DEV_SYNC_CHANNEL_ID || "C0BB9P41XTL", // #development-sync
  // Channel decisions are mirrored to.
  opsLogChannelId: process.env.SLACK_OPS_LOG_CHANNEL_ID || "C0BBLHPR116", // #vertix-ops-log

  // Viktor — pinged on blockers. Set SLACK_OWNER_USER_ID for a real ping.
  ownerUserId: process.env.SLACK_OWNER_USER_ID || "",
  ownerDisplay: process.env.SLACK_OWNER_DISPLAY || "Viktor",

  // The two worker agents. Provide their Slack member IDs for real @-mentions;
  // otherwise we fall back to plain @name text.
  agents: {
    ui: {
      role: "ui" as const,
      label: "UI/UX",
      userId: process.env.SLACK_AGENT_UI_USER_ID || "",
      display: process.env.SLACK_AGENT_UI_DISPLAY || "Runable",
    },
    backend: {
      role: "backend" as const,
      label: "Backend",
      userId: process.env.SLACK_AGENT_BACKEND_USER_ID || "",
      display: process.env.SLACK_AGENT_BACKEND_DISPLAY || "CodeRabbit",
    },
  },

  model: process.env.OPS_MODEL || "anthropic/claude-sonnet-4.6",
};

export type Role = "ui" | "backend";

export const otherRole = (r: Role): Role => (r === "ui" ? "backend" : "ui");

/** Render an @-mention: real Slack mention if we have an ID, else readable text. */
export function mention(agent: { userId: string; display: string }): string {
  return agent.userId ? `<@${agent.userId}>` : `@${agent.display}`;
}

export function ownerMention(): string {
  return config.ownerUserId
    ? `<@${config.ownerUserId}>`
    : `@${config.ownerDisplay}`;
}
