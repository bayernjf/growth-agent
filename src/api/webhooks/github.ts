// Hono surface for inbound GitHub pull_request webhooks (T-D3). Like the
// zeus route, the signature is verified over the EXACT raw bytes GitHub
// POSTed, never over a re-serialized JSON object.

import { Hono } from 'hono';
import { handleInboundGithubEvent, type GithubInboundDeps } from '../../publisher/github/inbound.js';

export function createGithubWebhookApp(deps: GithubInboundDeps): Hono {
  const app = new Hono();
  app.post('/', async (c) => {
    const rawBody = await c.req.raw.text();
    const result = await handleInboundGithubEvent(deps, rawBody, {
      event: c.req.header('x-github-event') ?? null,
      delivery: c.req.header('x-github-delivery') ?? null,
      signature: c.req.header('x-hub-signature-256') ?? null,
    });
    return c.json(result.body, result.status as 200 | 400 | 401 | 409 | 422 | 500 | 503);
  });
  return app;
}
