/**
 * Thin Slack Web API + signature verification helpers.
 * Uses the bot token at runtime (the deployed bot has its own token).
 */

const SLACK_API = "https://slack.com/api";

function botToken(): string {
  const t = process.env.SLACK_BOT_TOKEN;
  if (!t) throw new Error("SLACK_BOT_TOKEN not set");
  return t;
}

/**
 * Verify a Slack request signature.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null
): Promise<boolean> {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    console.warn("[slack] SLACK_SIGNING_SECRET not set — rejecting");
    return false;
  }
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay protection).
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base)
  );
  const expected =
    "v0=" +
    Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // constant-time compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

async function slackPost(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown };
  if (!data.ok) {
    console.error(`[slack] ${method} failed:`, data.error);
  }
  return data;
}

export async function postMessage(opts: {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
}) {
  return slackPost("chat.postMessage", {
    channel: opts.channel,
    text: opts.text,
    ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
    ...(opts.blocks ? { blocks: opts.blocks } : {}),
  });
}

/** Fetch recent thread replies for LLM context. */
export async function getThreadReplies(channel: string, thread_ts: string, limit = 30) {
  const res = await fetch(
    `${SLACK_API}/conversations.replies?channel=${channel}&ts=${thread_ts}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${botToken()}` } }
  );
  const data = (await res.json()) as {
    ok: boolean;
    messages?: Array<{ user?: string; bot_id?: string; text?: string; ts?: string }>;
  };
  return data.ok ? data.messages ?? [] : [];
}

export async function createChannel(name: string, is_private = false) {
  return slackPost("conversations.create", { name, is_private });
}

/** Cache of botUserId so we can ignore our own messages. */
let _botUserId: string | null = null;
export async function getBotUserId(): Promise<string | null> {
  if (_botUserId) return _botUserId;
  const res = await fetch(`${SLACK_API}/auth.test`, {
    headers: { Authorization: `Bearer ${botToken()}` },
  });
  const data = (await res.json()) as { ok: boolean; user_id?: string };
  _botUserId = data.ok ? data.user_id ?? null : null;
  return _botUserId;
}
