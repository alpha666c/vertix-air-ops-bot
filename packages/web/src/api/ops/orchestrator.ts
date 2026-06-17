/**
 * ARIA handler: given a Slack message/DM, build context + memory, ask Aria's
 * brain (Qwen), post her reply, and run any actions she requested.
 *
 * Aria is conversational and chatty — she responds to @mentions, DMs, and (in her
 * channels) jumps in when she's clearly being addressed or can genuinely help.
 * She is NOT a template-enforcing referee.
 */
import { db } from "../database";
import { tasks, eventLog, processedEvents, ariaMemory } from "../database/schema";
import { eq, desc } from "drizzle-orm";
import { config } from "./config";
import {
  ariaRespond,
  ariaStandup,
  type AriaTurn,
} from "./aria";
import {
  postMessage,
  getThreadReplies,
  getChannelHistory,
  getChannelName,
  getBotUserId,
  dmUser,
} from "./slack";
import { createIssue } from "./github";

const nano = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ------------------------------------------------------------------ *
 *  small persistence helpers
 * ------------------------------------------------------------------ */
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

/** Dedupe: true if this Slack event was already handled. */
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

/** Load Aria's durable memory as a compact bullet list. */
async function loadMemory(limit = 60): Promise<string> {
  const rows = await db
    .select()
    .from(ariaMemory)
    .orderBy(desc(ariaMemory.createdAt))
    .limit(limit);
  if (!rows.length) return "";
  return rows.map((r) => `- ${r.fact}`).join("\n");
}

async function remember(fact: string, actor?: string, scope?: string) {
  const clean = String(fact || "").trim().slice(0, 600);
  if (!clean) return;
  await db.insert(ariaMemory).values({ id: nano(), fact: clean, actor, scope });
}

/* ------------------------------------------------------------------ *
 *  incoming message
 * ------------------------------------------------------------------ */
export type IncomingSlackMessage = {
  eventId: string;
  channelId: string;
  channelType?: string; // "im" for DMs
  userId?: string;
  text: string;
  ts: string;
  threadTs?: string;
  isMention?: boolean; // came in as app_mention
};

/** Map a slack user id to a friendly display name we know. */
function nameOf(userId?: string): string {
  if (!userId) return "teammate";
  if (userId === config.agents.ui.userId) return config.agents.ui.display;
  if (userId === config.agents.backend.userId) return config.agents.backend.display;
  if (userId === config.ownerUserId) return config.ownerDisplay;
  return "teammate";
}

/** Strip a leading <@BOTID> mention from text. */
function stripMention(text: string, botId: string | null): string {
  if (!botId) return text.trim();
  return text.replace(new RegExp(`<@${botId}>`, "g"), "").trim();
}

/**
 * Should Aria respond to this message? She's chatty but not spammy.
 * - Always in DMs.
 * - Always when @mentioned.
 * - In her channels: when "aria" is named, or it's a question / clearly addressed.
 */
function shouldRespond(opts: {
  isDM: boolean;
  isMention: boolean;
  text: string;
}): boolean {
  if (opts.isDM || opts.isMention) return true;
  const t = opts.text.toLowerCase();
  if (/\baria\b/.test(t)) return true;
  // chatty: jump into questions / asks / blockers
  if (/\?\s*$/.test(opts.text.trim())) return true;
  if (/\b(blocked|blocker|help|stuck|can someone|anyone|what'?s the status|update\??)\b/.test(t))
    return true;
  return false;
}

export async function handleSlackMessage(msg: IncomingSlackMessage): Promise<boolean> {
  const isDM = msg.channelType === "im";

  // Watch DMs + Aria's known channels (dev-sync, ops-log). Ignore everything else.
  const known =
    isDM ||
    msg.channelId === config.devSyncChannelId ||
    msg.channelId === config.opsLogChannelId;
  if (!known) return false;

  // Ignore our own messages (anti-loop).
  const botId = await getBotUserId().catch(() => null);
  if (botId && msg.userId === botId) return false;

  // Dedupe Slack retries.
  if (await alreadyProcessed(msg.eventId)) return false;

  const cleanText = stripMention(msg.text, botId);
  if (!cleanText) return false;

  if (!shouldRespond({ isDM, isMention: !!msg.isMention, text: cleanText })) {
    return false;
  }

  // Build conversation context: thread replies if threaded, else recent channel history.
  let history: AriaTurn[] = [];
  if (msg.threadTs) {
    const replies = await getThreadReplies(msg.channelId, msg.threadTs, 25).catch(() => []);
    history = replies.map((r) => toTurn(r, botId));
  } else {
    const recent = await getChannelHistory(msg.channelId, 15).catch(() => []);
    // history comes newest-first; reverse to oldest-first
    history = recent.reverse().map((r) => toTurn(r, botId));
  }

  const channelLabel = isDM
    ? "dm"
    : await getChannelName(msg.channelId).catch(() => "channel");
  const memory = await loadMemory().catch(() => "");

  const result = await ariaRespond({
    memory,
    channelLabel,
    isDM,
    history,
    triggerName: isDM ? config.ownerDisplay : nameOf(msg.userId),
    triggerText: cleanText,
  });

  await logEvent({
    source: "slack",
    kind: "aria_reply",
    channelId: msg.channelId,
    threadTs: msg.threadTs,
    actor: msg.userId,
    summary: result.reply.slice(0, 200),
    raw: { trigger: cleanText, actions: result.actions },
  });

  // Run actions first (so "remember" lands before she might reference it).
  for (const a of result.actions) {
    await runAction(a, { channelId: msg.channelId, threadTs: msg.threadTs, userId: msg.userId }).catch(
      (e) => console.error("[aria action]", a.tool, e)
    );
  }

  const reply = result.reply.trim();
  if (!reply || reply.toUpperCase() === "NOOP") return false;

  await postMessage({
    channel: msg.channelId,
    text: reply,
    ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}),
  });
  return true;
}

function toTurn(
  r: { user?: string; bot_id?: string; text?: string },
  botId: string | null
): AriaTurn {
  const isAria = r.bot_id != null || (botId != null && r.user === botId);
  return {
    role: isAria ? "assistant" : "user",
    name: isAria ? "ARIA" : nameOf(r.user),
    content: r.text ?? "",
  };
}

/* ------------------------------------------------------------------ *
 *  Aria's actions
 * ------------------------------------------------------------------ */
async function runAction(
  action: { tool: string; args: Record<string, unknown> },
  ctx: { channelId: string; threadTs?: string; userId?: string }
) {
  const { tool, args } = action;
  switch (tool) {
    case "remember": {
      await remember(String(args.fact ?? ""), ctx.userId);
      return;
    }
    case "ops_log": {
      const text = String(args.text ?? "").trim();
      if (text) await postMessage({ channel: config.opsLogChannelId, text: `📌 ${text}` });
      return;
    }
    case "ping_owner": {
      const text = String(args.text ?? "").trim();
      if (!text) return;
      if (config.ownerUserId) {
        await dmUser(config.ownerUserId, `👋 ${text}`);
      } else {
        await postMessage({ channel: ctx.channelId, text: `${ownerTag()} ${text}` });
      }
      return;
    }
    case "github_issue": {
      const repo = String(args.repo ?? "alpha666c/vertix-air-ltd");
      const title = String(args.title ?? "").trim();
      const body = String(args.body ?? "").trim();
      if (!title) return;
      const res = await createIssue(repo, title, body);
      if (res?.html_url) {
        await postMessage({
          channel: ctx.channelId,
          text: `📋 Issue created: <${res.html_url}|${title}>`,
          ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
        });
      }
      return;
    }
    default:
      console.warn("[aria] unknown action:", tool);
  }
}

function ownerTag(): string {
  return config.ownerUserId ? `<@${config.ownerUserId}>` : `@${config.ownerDisplay}`;
}

/* ------------------------------------------------------------------ *
 *  Standup digest (manual trigger or scheduled)
 * ------------------------------------------------------------------ */
export async function postStandup(period: "daily" | "weekly", channelId?: string) {
  const facts = await loadMemory(40).catch(() => "");
  const since = period === "daily" ? Date.now() - 864e5 : Date.now() - 7 * 864e5;
  const events = await db
    .select()
    .from(eventLog)
    .orderBy(desc(eventLog.createdAt))
    .limit(40);
  const recent = events
    .filter((e) => +new Date(e.createdAt) >= since)
    .map((e) => `- [${e.source}/${e.kind}] ${e.summary ?? ""}`)
    .join("\n");

  const digest = await ariaStandup({ period, facts, recentActivity: recent });

  if (config.ownerUserId && !channelId) {
    await dmUser(config.ownerUserId, digest);
  } else {
    await postMessage({ channel: channelId || config.devSyncChannelId, text: digest });
  }
  return digest;
}

/** Legacy task-board summary (kept for the /ops/summary route). */
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
