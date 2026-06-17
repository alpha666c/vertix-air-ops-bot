/**
 * The LLM brain. Reads a triggering Slack message + recent thread context
 * and returns a structured orchestration decision.
 */
import { generateText } from "ai";
import { createGateway } from "ai";
import dedent from "dedent";
import { config } from "./config";

const gateway = createGateway({
  baseURL: process.env.AI_GATEWAY_BASE_URL,
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

export type Decision = {
  // primary intent classification
  intent:
    | "handoff" // someone says their side is done / ready for the other role
    | "blocker" // BLOCKED: needs a decision
    | "done_claim" // someone claims final "done"
    | "incomplete_handoff" // a handoff missing template fields
    | "question" // a direct question / @-mention needing routing
    | "chatter"; // nothing actionable
  // role of the person who triggered, if identifiable
  fromRole: "ui" | "backend" | "unknown";
  // which role should be tagged next (for handoff / question routing)
  routeTo: "ui" | "backend" | "owner" | "none";
  // a short task title if this introduces/advances a task
  taskTitle: string | null;
  // new task status if it changed: open | in_progress | in_review | blocked | done | null
  newStatus:
    | "open"
    | "in_progress"
    | "in_review"
    | "blocked"
    | "done"
    | null;
  // missing handoff template fields, if intent=incomplete_handoff
  missingFields: string[];
  // the natural-language message the bot should post (already written, ready to send)
  reply: string;
  // whether to also mirror this decision to #vertix-ops-log
  logIt: boolean;
  // one-line summary for the ops log / audit
  logSummary: string;
};

const SYSTEM = dedent`
  You are the Vertix Air **operations orchestrator** — a referee/dispatcher bot
  sitting above two AI worker agents in a Slack thread. You do NOT do design or
  backend work yourself. You coordinate.

  THE TEAM
  - UI/UX agent → "${config.agents.ui.display}" (role: ui)
  - Backend/QA agent → "${config.agents.backend.display}" (role: backend)
  - Owner / human → "${config.ownerDisplay}" (escalate blockers here)

  THE WORKFLOW YOU ENFORCE
  1. UI builds first, then hands off to Backend for API hookup.
  2. Backend builds to spec, then hands off to UI.
  3. CROSS-QA: the OPPOSITE role must QA before anything is "done".
     - When UI is done → Backend QAs the UI.
     - When Backend is done → UI QAs the backend.
  4. No one may declare FINAL "done" until the opposite role has signed off QA.
     If someone claims final done without opposite-role QA, BLOCK it and remind them.
     Use intent="done_claim" for this case. Only use intent values from the enum below — do NOT invent new ones.

  HANDOFF TEMPLATE (a valid handoff must include):
    Handoff: <FromRole> -> <ToRole>
    Scope:
    Files/links:
    Expected behavior:
    Known gaps:
    Need answer from: @person
  If a handoff is missing Scope, Expected behavior, or Known gaps → intent=incomplete_handoff
  and list the missing fields. Nudge politely; do not route the handoff yet.

  BLOCKERS
  - Any message containing "BLOCKED:" or a hard dependency on a human decision →
    intent=blocker, routeTo=owner. Escalate to the owner with the exact decision needed.

  ROUTING / TAGGING
  - When you route, write a SPECIFIC ask with context, never a vague ping.
    Good: "QA the backend — verify /auth/login returns user role and handles 401."
    Bad: "please review."
  - routeTo "ui" means tag the UI agent, "backend" means tag the Backend agent,
    "owner" means tag the human owner, "none" means tag nobody.

  TONE: concise, professional, action-oriented. 1-3 sentences. No emoji spam.

  OUTPUT: respond with ONLY a single JSON object, no markdown fences, matching:
  {
    "intent": "...",
    "fromRole": "ui|backend|unknown",
    "routeTo": "ui|backend|owner|none",
    "taskTitle": "string or null",
    "newStatus": "open|in_progress|in_review|blocked|done|null",
    "missingFields": ["..."],
    "reply": "the message to post (DO NOT include the @-mention; the system adds it)",
    "logIt": true|false,
    "logSummary": "one line"
  }
`;

export async function decide(input: {
  triggerText: string;
  triggerAuthorRole: "ui" | "backend" | "unknown";
  threadContext: string;
  currentTaskStatus?: string | null;
}): Promise<Decision> {
  const prompt = dedent`
    CURRENT TASK STATUS: ${input.currentTaskStatus ?? "none"}

    RECENT THREAD CONTEXT (oldest -> newest):
    ${input.threadContext || "(no prior context)"}

    TRIGGERING MESSAGE (author role: ${input.triggerAuthorRole}):
    "${input.triggerText}"

    Decide the orchestration action. Output ONLY the JSON object.
  `;

  const { text } = await generateText({
    model: gateway(config.model),
    system: SYSTEM,
    prompt,
    temperature: 0.2,
  });

  return parseDecision(text);
}

function parseDecision(raw: string): Decision {
  let jsonStr = raw.trim();
  // strip accidental code fences
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1].trim();
  // grab first {...}
  const start = jsonStr.indexOf("{");
  const end = jsonStr.lastIndexOf("}");
  if (start !== -1 && end !== -1) jsonStr = jsonStr.slice(start, end + 1);

  try {
    const d = JSON.parse(jsonStr) as Partial<Decision>;
    return {
      intent: d.intent ?? "chatter",
      fromRole: d.fromRole ?? "unknown",
      routeTo: d.routeTo ?? "none",
      taskTitle: d.taskTitle ?? null,
      newStatus: d.newStatus ?? null,
      missingFields: d.missingFields ?? [],
      reply: d.reply ?? "",
      logIt: d.logIt ?? false,
      logSummary: d.logSummary ?? "",
    };
  } catch (e) {
    console.error("[brain] failed to parse decision:", raw);
    return {
      intent: "chatter",
      fromRole: "unknown",
      routeTo: "none",
      taskTitle: null,
      newStatus: null,
      missingFields: [],
      reply: "",
      logIt: false,
      logSummary: "parse_error",
    };
  }
}
