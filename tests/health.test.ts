import { describe, expect, it } from 'vitest';
import { createHealthApp } from '../src/api/health.js';

describe('GET /healthz', () => {
  it('reports static wiring status', async () => {
    const app = createHealthApp({ dbDialect: 'sqlite', zeusMode: 'off' });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      db: string;
      zeus: string;
      time: string;
    };
    expect(body).toMatchObject({ status: 'ok', service: 'growth-agent', db: 'sqlite', zeus: 'off' });
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });
});
