/**
 * GitHub webhook handling. We care about PR review events — when CodeRabbit
 * (or any reviewer) submits a review, the orchestrator announces it in Slack
 * and tags the UI agent to QA the changes.
 */
import { config, mention } from "./config";
import { postMessage } from "./slack";
import { ariaSummarizePR } from "./aria";
import { db } from "../database";
import { eventLog } from "../database/schema";

const nano = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ------------------------------------------------------------------ *
 *  GitHub REST helper — create an issue (used by Aria's github_issue action).
 *  Auth via GITHUB_TOKEN (a PAT/installation token set on the server).
 * ------------------------------------------------------------------ */
export async function createIssue(
  repoFullname: string,
  title: string,
  body: string
): Promise<{ html_url?: string; number?: number } | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("[github] GITHUB_TOKEN not set — cannot create issue");
    return null;
  }
  const res = await fetch(`https://api.github.com/repos/${repoFullname}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "aria-vertix-air",
    },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) {
    console.error("[github] createIssue failed:", res.status, await res.text());
    return null;
  }
  return (await res.json()) as { html_url?: string; number?: number };
}

/** Verify GitHub webhook HMAC SHA-256 signature (x-hub-signature-256). */
export async function verifyGithubSignature(
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[github] GITHUB_WEBHOOK_SECRET not set — rejecting");
    return false;
  }
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

type GithubReviewPayload = {
  action?: string;
  review?: { state?: string; user?: { login?: string }; html_url?: string; body?: string };
  pull_request?: { title?: string; html_url?: string; number?: number };
  repository?: { full_name?: string };
};

const CODERABBIT_LOGINS = ["coderabbitai", "coderabbitai[bot]", "coderabbit"];

export async function handleGithubEvent(event: string, payload: GithubReviewPayload): Promise<boolean> {
  if (event !== "pull_request_review") return false;
  if (payload.action !== "submitted") return false;

  const reviewer = (payload.review?.user?.login || "").toLowerCase();
  const isCodeRabbit = CODERABBIT_LOGINS.some((l) => reviewer.includes(l.replace("[bot]", "")));
  const state = payload.review?.state || "commented";
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name || "";

  const stateLabel =
    state === "approved" ? "✅ approved" : state === "changes_requested" ? "🔧 requested changes" : "💬 commented";

  const reviewerName = isCodeRabbit ? config.agents.backend.display : payload.review?.user?.login || "reviewer";

  // Aria writes a short, human take on the review.
  let ariaNote = "";
  try {
    ariaNote = await ariaSummarizePR({
      title: pr?.title ?? "",
      body: payload.review?.body ?? "",
      files: `${repo} #${pr?.number} — ${stateLabel}`,
    });
  } catch (e) {
    console.error("[github] aria PR summary failed:", e);
  }

  const announce =
    `🔍 *${reviewerName} ${stateLabel}* on <${pr?.html_url}|${repo} #${pr?.number}: ${pr?.title ?? ""}>` +
    (ariaNote ? `\n${ariaNote}` : "");

  // Announce in dev-sync; tag UI to QA if CodeRabbit (backend) reviewed/approved.
  let text = announce;
  if (isCodeRabbit && state === "approved") {
    text += `\n${mention(config.agents.ui)} backend review's in — give it a QA pass against the UI spec and confirm flows + states still hold.`;
  }

  await postMessage({ channel: config.devSyncChannelId, text });
  await postMessage({
    channel: config.opsLogChannelId,
    text: `🔍 *github* — ${reviewerName} ${stateLabel} on ${repo} #${pr?.number}`,
  });

  await db.insert(eventLog).values({
    id: nano(),
    source: "github",
    kind: "pr_review",
    actor: reviewer,
    summary: `${reviewerName} ${stateLabel} ${repo}#${pr?.number}`,
    raw: JSON.stringify({ pr: pr?.html_url, state }),
  });

  return true;
}
