// Hono surface for inbound zeus decision events (T-A5). The route only reads
// the EXACT raw bytes zeus POSTed and hands them to the pure handler: the
// signature must be computed over what the wire carried, never over a
// re-serialized JSON object.

import { Hono } from 'hono';
import { handleInboundZeusEvent, type InboundDeps } from '../../connector/zeus/inbound.js';

export function createZeusWebhookApp(deps: InboundDeps): Hono {
  const app = new Hono();
  app.post('/', async (c) => {
    const rawBody = await c.req.raw.text();
    const result = await handleInboundZeusEvent(deps, rawBody, {
      signature: c.req.header('x-zeus-signature') ?? null,
      deliveryId: c.req.header('x-zeus-delivery-id') ?? null,
      webhookSignature: c.req.header('x-zeus-webhook-signature') ?? null,
      webhookTimestamp: c.req.header('x-zeus-webhook-timestamp') ?? null,
      webhookNonce: c.req.header('x-zeus-webhook-nonce') ?? null,
    });
    return c.json(result.body, result.status as 200 | 400 | 401 | 409 | 422 | 500 | 503);
  });
  return app;
}
