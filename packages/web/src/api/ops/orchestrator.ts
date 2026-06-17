/**
 * Orchestrator core: given a Slack message event, run the brain and
 * execute the resulting decision (post tags, enforce QA, escalate, log).
 */
import { db } from "../database";
import { tasks, handoffs, eventLog, processedEvents } from "../database/schema";
import { eq, desc } from "drizzle-orm";
import { config, mention, ownerMention, type Role } from "./config";
import { decide, type Decision } from "./brain";
import { postMessage, getThreadReplies, getBotUserId } from "./slack";

const nano = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Map a slack user id to a role, if it's one of our known agents. */
function roleOf(userId?: string): Role | "unknown" {
  if (!userId) return "unknown";
  if (userId === config.agents.ui.userId) return "ui";
  if (userId === config.agents.backend.userId) return "backend";
  return "unknown";
}

function agentFor(role: "ui" | "backend") {
  return role === "ui" ? config.agents.ui : config.agents.backend;
}

/** Build the routed mention string for a decision. */
function routeMention(routeTo: Decision["routeTo"]): string {
  if (routeTo === "ui") return mention(config.agents.ui);
  if (routeTo === "backend") return mention(config.agents.backend);
  if (routeTo === "owner") return ownerMention();
  return "";
}

async function logEvent(e: {
  source: string;
  kind: string;
  channelId?: string;
  threadTs?: string;
  actor?: string;
  summary?: string;
  raw?: unknown;
}) {
  await db.insert(eventLog).values({
    id: nano(),
    source: e.source,
    kind: e.kind,
    channelId: e.channelId,
    threadTs: e.threadTs,
    actor: e.actor,
    summary: e.summary,
    raw: e.raw ? JSON.stringify(e.raw) : null,
  });
}

/** Find or create the task anchored to a thread. */
async function getOrCreateTask(channelId: string, threadTs: string, title?: string | null) {
  const existing = await db
    .select()
    .from(tasks)
    .where(eq(tasks.threadTs, threadTs))
    .limit(1);
  if (existing.length) return existing[0];

  const id = nano();
  await db.insert(tasks).values({
    id,
    title: title || "Untitled task",
    threadTs,
    channelId,
    status: "open",
  });
  const created = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return created[0];
}

async function updateTaskStatus(taskId: string, status: string, extra?: Partial<{ blockedReason: string; ownerRole: string }>) {
  await db
    .update(tasks)
    .set({ status, updatedAt: new Date(), ...(extra ?? {}) })
    .where(eq(tasks.id, taskId));
}

/** Dedupe: returns true if this event was already processed. */
async function alreadyProcessed(eventId: string): Promise<boolean> {
  const hit = await db
    .select()
    .from(processedEvents)
    .where(eq(processedEvents.id, eventId))
    .limit(1);
  if (hit.length) return true;
  await db.insert(processedEvents).values({ id: eventId }).onConflictDoNothing();
  return false;
}

export type IncomingSlackMessage = {
  eventId: string; // for dedupe
  channelId: string;
  userId?: string;
  text: string;
  ts: string;
  threadTs?: string;
};

/**
 * Main entry: process one Slack message/app_mention event.
 * Returns true if the bot took an action.
 */
export async function handleSlackMessage(msg: IncomingSlackMessage): Promise<boolean> {
  // Only watch the dev-sync channel.
  if (msg.channelId !== config.devSyncChannelId) return false;

  // Ignore our own messages.
  const botId = await getBotUserId().catch(() => null);
  if (botId && msg.userId === botId) return false;

  // Dedupe Slack retries.
  if (await alreadyProcessed(msg.eventId)) return false;

  const threadTs = msg.threadTs || msg.ts;
  const authorRole = roleOf(msg.userId);

  // Pull thread context for the brain.
  const replies = await getThreadReplies(msg.channelId, threadTs, 30).catch(() => []);
  const threadContext = replies
    .map((r) => {
      const who =
        roleOf(r.user) !== "unknown"
          ? agentFor(roleOf(r.user) as Role).label
          : r.user || (r.bot_id ? "bot" : "user");
      return `[${who}] ${r.text ?? ""}`;
    })
    .join("\n")
    .slice(-6000);

  // Current task status, if any.
  const task = await getOrCreateTask(msg.channelId, threadTs);
  const decision = await decide({
    triggerText: msg.text,
    triggerAuthorRole: authorRole,
    threadContext,
    currentTaskStatus: task.status,
  });

  await logEvent({
    source: "slack",
    kind: decision.intent,
    channelId: msg.channelId,
    threadTs,
    actor: msg.userId,
    summary: decision.logSummary,
    raw: { trigger: msg.text, decision },
  });

  // Nothing actionable.
  if (decision.intent === "chatter" && decision.routeTo === "none" && !decision.reply) {
    return false;
  }

  await executeDecision(decision, { channelId: msg.channelId, threadTs, task });
  return true;
}

async function executeDecision(
  decision: Decision,
  ctx: { channelId: string; threadTs: string; task: typeof tasks.$inferSelect }
) {
  const tag = routeMention(decision.routeTo);
  const body = decision.reply?.trim();

  // Update task status.
  if (decision.newStatus) {
    const extra: { blockedReason?: string; ownerRole?: string } = {};
    if (decision.newStatus === "blocked") extra.blockedReason = decision.logSummary;
    if (decision.fromRole !== "unknown") extra.ownerRole = decision.fromRole;
    await updateTaskStatus(ctx.task.id, decision.newStatus, extra);
  }
  if (decision.taskTitle && ctx.task.title === "Untitled task") {
    await db.update(tasks).set({ title: decision.taskTitle }).where(eq(tasks.id, ctx.task.id));
  }

  // Record handoff template state.
  if (decision.intent === "handoff" || decision.intent === "incomplete_handoff") {
    await db.insert(handoffs).values({
      id: nano(),
      taskId: ctx.task.id,
      fromRole: decision.fromRole === "unknown" ? null : decision.fromRole,
      toRole: decision.routeTo === "ui" || decision.routeTo === "backend" ? decision.routeTo : null,
      complete: decision.intent === "handoff",
      threadTs: ctx.threadTs,
      channelId: ctx.channelId,
    });
  }

  if (!body) return;

  const text = tag ? `${tag} ${body}` : body;

  // Post into the originating thread.
  await postMessage({ channel: ctx.channelId, text, thread_ts: ctx.threadTs });

  // Escalate blockers to owner in-thread already done via routeTo=owner.
  // Mirror to ops log when flagged.
  if (decision.logIt) {
    await mirrorToOpsLog(decision, ctx);
  }
}

async function mirrorToOpsLog(
  decision: Decision,
  ctx: { channelId: string; threadTs: string; task: typeof tasks.$inferSelect }
) {
  const icon =
    decision.intent === "blocker"
      ? "🚧"
      : decision.intent === "done_claim"
      ? "🛑"
      : decision.intent === "handoff"
      ? "🔁"
      : "📌";
  const line =
    `${icon} *${decision.intent}* — ${decision.logSummary || decision.reply}` +
    (decision.taskTitle ? `\n• Task: ${decision.taskTitle}` : "") +
    (decision.newStatus ? `\n• Status → ${decision.newStatus}` : "") +
    `\n• Thread: <#${ctx.channelId}>`;
  await postMessage({ channel: config.opsLogChannelId, text: line });
  await logEvent({
    source: "slack",
    kind: "ops_log_mirror",
    channelId: config.opsLogChannelId,
    threadTs: ctx.threadTs,
    summary: decision.logSummary,
  });
}

/** Post a status summary of all open tasks to a channel. */
export async function postStatusSummary(channelId: string) {
  const all = await db.select().from(tasks).orderBy(desc(tasks.updatedAt)).limit(20);
  if (!all.length) {
    await postMessage({ channel: channelId, text: "📋 No tracked tasks yet." });
    return;
  }
  const byStatus: Record<string, string[]> = {};
  for (const t of all) {
    (byStatus[t.status] ??= []).push(`• ${t.title}${t.ownerRole ? ` _(${t.ownerRole})_` : ""}`);
  }
  const order = ["blocked", "in_review", "in_progress", "open", "done"];
  const sections = order
    .filter((s) => byStatus[s])
    .map((s) => `*${s.toUpperCase()}*\n${byStatus[s].join("\n")}`)
    .join("\n\n");
  await postMessage({ channel: channelId, text: `📋 *Task Board*\n\n${sections}` });
}
