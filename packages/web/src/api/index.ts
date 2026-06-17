import { Hono } from 'hono';
import { cors } from "hono/cors";
import { verifySlackSignature } from "./ops/slack";
import { handleSlackMessage, postStatusSummary, postStandup } from "./ops/orchestrator";
import { config } from "./ops/config";
import { verifyGithubSignature, handleGithubEvent } from "./ops/github";

/* ------------------------------------------------------------------ *
 *  Debug ring-buffer — lets us SEE what Slack actually delivers.
 *  Visit GET /api/aria/debug to inspect the last inbound events.
 * ------------------------------------------------------------------ */
type DebugEntry = { at: string; kind: string; detail: unknown };
const DEBUG: DebugEntry[] = [];
function dbg(kind: string, detail: unknown) {
  DEBUG.unshift({ at: new Date().toISOString(), kind, detail });
  if (DEBUG.length > 50) DEBUG.pop();
}

const app = new Hono()
  .basePath('api')
  .use(cors({ origin: (origin) => origin ?? "*", credentials: true, exposeHeaders: ["set-auth-token"] }))
  .get('/ping', (c) => c.json({ message: `Pong! ${Date.now()}` }, 200))
  .get('/health', (c) => c.json({ status: 'ok', who: 'aria' }, 200))

  // ---- Debug: see the last inbound Slack/GitHub events ----
  .get('/aria/debug', (c) => c.json({ count: DEBUG.length, events: DEBUG }, 200))

  // ---- Slack Events API ----
  .post('/slack/events', async (c) => {
    const raw = await c.req.text();
    const ts = c.req.header('x-slack-request-timestamp') ?? null;
    const sig = c.req.header('x-slack-signature') ?? null;

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      dbg('bad_json', { raw: raw.slice(0, 200) });
      return c.json({ error: 'bad json' }, 400);
    }

    // URL verification handshake (Slack does not sign this).
    if (body.type === 'url_verification') {
      dbg('url_verification', { challenge: !!body.challenge });
      return c.json({ challenge: body.challenge }, 200);
    }

    const valid = await verifySlackSignature(raw, ts, sig);
    if (!valid) {
      dbg('slack_sig_invalid', {
        hasTs: !!ts,
        hasSig: !!sig,
        secretSet: !!process.env.SLACK_SIGNING_SECRET,
        type: body.type,
      });
      return c.json({ error: 'invalid signature' }, 401);
    }

    // Ack immediately, process async (Slack requires <3s response).
    if (body.type === 'event_callback' && body.event) {
      const ev = body.event;
      const isMessage = ev.type === 'message';
      const isMention = ev.type === 'app_mention';
      dbg('event', {
        type: ev.type,
        subtype: ev.subtype,
        channel: ev.channel,
        channel_type: ev.channel_type,
        bot_id: ev.bot_id,
        user: ev.user,
        text: (ev.text || '').slice(0, 120),
      });
      if ((isMessage || isMention) && !ev.subtype && !ev.bot_id) {
        const eventId = body.event_id || `${ev.channel}-${ev.ts}`;
        queueMicrotask(() => {
          handleSlackMessage({
            eventId,
            channelId: ev.channel,
            channelType: ev.channel_type, // "im" for DMs
            userId: ev.user,
            text: ev.text || '',
            ts: ev.ts,
            threadTs: ev.thread_ts,
            isMention,
          }).catch((e) => {
            console.error('[slack handler]', e);
            dbg('handler_error', String(e));
          });
        });
      }
    }
    return c.json({ ok: true }, 200);
  })

  // ---- Manual trigger: legacy task-board summary ----
  .post('/ops/summary', async (c) => {
    const channel = (await c.req.json().catch(() => ({})))?.channel || config.devSyncChannelId;
    await postStatusSummary(channel);
    return c.json({ ok: true }, 200);
  })

  // ---- Manual trigger: Aria standup digest (daily|weekly) ----
  .post('/aria/standup', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { period?: 'daily' | 'weekly'; channel?: string };
    const digest = await postStandup(b.period === 'weekly' ? 'weekly' : 'daily', b.channel);
    return c.json({ ok: true, digest }, 200);
  })

  // ---- GitHub webhook ----
  .post('/github/webhook', async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header('x-hub-signature-256') ?? null;
    const event = c.req.header('x-github-event') ?? '';

    const valid = await verifyGithubSignature(raw, sig);
    if (!valid) {
      dbg('github_sig_invalid', { hasSig: !!sig, secretSet: !!process.env.GITHUB_WEBHOOK_SECRET, event });
      return c.json({ error: 'invalid signature' }, 401);
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }

    dbg('github_event', { event, action: payload.action });
    queueMicrotask(() => {
      handleGithubEvent(event, payload).catch((e) => console.error('[github handler]', e));
    });
    return c.json({ ok: true }, 200);
  });

export type AppType = typeof app;
export default app;
