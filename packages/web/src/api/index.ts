import { Hono } from 'hono';
import { cors } from "hono/cors";
import { verifySlackSignature } from "./ops/slack";
import { handleSlackMessage, postStatusSummary } from "./ops/orchestrator";
import { config } from "./ops/config";
import { verifyGithubSignature, handleGithubEvent } from "./ops/github";

const app = new Hono()
  .basePath('api')
  .use(cors({ origin: (origin) => origin ?? "*", credentials: true, exposeHeaders: ["set-auth-token"] }))
  .get('/ping', (c) => c.json({ message: `Pong! ${Date.now()}` }, 200))
  .get('/health', (c) => c.json({ status: 'ok' }, 200))

  // ---- Slack Events API ----
  .post('/slack/events', async (c) => {
    const raw = await c.req.text();
    const ts = c.req.header('x-slack-request-timestamp') ?? null;
    const sig = c.req.header('x-slack-signature') ?? null;

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }

    // URL verification handshake (no signature required by Slack here, but we still verify when secret set).
    if (body.type === 'url_verification') {
      return c.json({ challenge: body.challenge }, 200);
    }

    const valid = await verifySlackSignature(raw, ts, sig);
    if (!valid) return c.json({ error: 'invalid signature' }, 401);

    // Ack immediately, process async (Slack requires <3s response).
    if (body.type === 'event_callback' && body.event) {
      const ev = body.event;
      if ((ev.type === 'message' || ev.type === 'app_mention') && !ev.subtype && !ev.bot_id) {
        const eventId = body.event_id || `${ev.channel}-${ev.ts}`;
        queueMicrotask(() => {
          handleSlackMessage({
            eventId,
            channelId: ev.channel,
            userId: ev.user,
            text: ev.text || '',
            ts: ev.ts,
            threadTs: ev.thread_ts,
          }).catch((e) => console.error('[slack handler]', e));
        });
      }
    }
    return c.json({ ok: true }, 200);
  })

  // ---- Manual trigger: post a task-board summary ----
  .post('/ops/summary', async (c) => {
    const channel = (await c.req.json().catch(() => ({})))?.channel || config.devSyncChannelId;
    await postStatusSummary(channel);
    return c.json({ ok: true }, 200);
  })

  // ---- GitHub webhook ----
  .post('/github/webhook', async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header('x-hub-signature-256') ?? null;
    const event = c.req.header('x-github-event') ?? '';

    const valid = await verifyGithubSignature(raw, sig);
    if (!valid) return c.json({ error: 'invalid signature' }, 401);

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }

    queueMicrotask(() => {
      handleGithubEvent(event, payload).catch((e) => console.error('[github handler]', e));
    });
    return c.json({ ok: true }, 200);
  });

export type AppType = typeof app;
export default app;
