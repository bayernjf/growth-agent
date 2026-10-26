import { describe, expect, it } from 'vitest';
import { createHealthApp } from '../src/api/health.js';
import type { StartupCheckReport } from '../src/startup/self-check.js';

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

  it('surfaces the post-boot startup self-check report', async () => {
    const report: StartupCheckReport = {
      status: 'ready',
      startedAt: '2026-10-26T06:00:00.000Z',
      db: { dialect: 'sqlite' },
      credentials: [],
      zeus: { mode: 'off', ping: true },
      reconcile: { reconciled: 0, unchanged: 0, drifted: 0, missingDecision: 0 },
    };
    const app = createHealthApp({
      dbDialect: 'sqlite',
      zeusMode: 'off',
      getStartupReport: () => report,
    });
    const body = (await (await app.request('/healthz')).json()) as {
      status: string;
      startup?: StartupCheckReport;
    };
    expect(body.status).toBe('ready');
    expect(body.startup?.zeus.ping).toBe(true);
  });
});
