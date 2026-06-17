import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Vertix Air Ops Orchestrator — data model
 *
 * tasks      : a unit of work tracked through the handoff lifecycle
 * handoffs   : a role -> role handoff with the enforced template fields
 * eventLog   : raw audit trail of every Slack / GitHub event we act on
 */

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(), // nanoid
  title: text("title").notNull(),
  // which role currently owns the task: "ui" | "backend"
  ownerRole: text("owner_role"),
  // open | in_progress | in_review | blocked | done
  status: text("status").notNull().default("open"),
  prUrl: text("pr_url"),
  // slack thread this task is anchored to
  threadTs: text("thread_ts"),
  channelId: text("channel_id"),
  blockedReason: text("blocked_reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const handoffs = sqliteTable("handoffs", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  fromRole: text("from_role"), // ui | backend
  toRole: text("to_role"),
  scope: text("scope"),
  filesLinks: text("files_links"),
  expectedBehavior: text("expected_behavior"),
  knownGaps: text("known_gaps"),
  needAnswerFrom: text("need_answer_from"),
  // true once template is complete enough to be a valid handoff
  complete: integer("complete", { mode: "boolean" }).notNull().default(false),
  threadTs: text("thread_ts"),
  channelId: text("channel_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const eventLog = sqliteTable("event_log", {
  id: text("id").primaryKey(),
  source: text("source").notNull(), // slack | github
  kind: text("kind").notNull(), // app_mention | message | handoff | blocker | qa_block | pr_review | summary | github_announce
  channelId: text("channel_id"),
  threadTs: text("thread_ts"),
  actor: text("actor"), // slack user id / github login
  summary: text("summary"),
  raw: text("raw"), // JSON blob
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * processedEvents : dedupe table. Slack retries events; we store the
 * event_id / delivery id so we never act twice on the same message.
 */
export const processedEvents = sqliteTable("processed_events", {
  id: text("id").primaryKey(), // slack event_id or github delivery id
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * ariaMemory : Aria's durable long-term memory. Facts, decisions, preferences
 * she chooses to remember across conversations.
 */
export const ariaMemory = sqliteTable("aria_memory", {
  id: text("id").primaryKey(), // nanoid
  fact: text("fact").notNull(),
  scope: text("scope"),
  actor: text("actor"), // who taught her this
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
