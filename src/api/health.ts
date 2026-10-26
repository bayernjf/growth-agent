import { Hono } from 'hono';
import type { StartupCheckReport } from '../startup/self-check.js';

export interface HealthDeps {
  dbDialect: 'sqlite' | 'postgres';
  zeusMode: 'off' | 'online';
  /** Post-boot startup self-check report; undefined while booting. */
  getStartupReport?: () => StartupCheckReport | undefined;
}

/**
 * Liveness/readiness probe. Before the startup self-check finishes it
 * reports the static wiring; afterwards it surfaces the full boot chain
 * (migrations, credential presence, zeus reachability, reconciliation).
 */
export function createHealthApp(deps: HealthDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => {
    const startup = deps.getStartupReport?.();
    return c.json({
      // Before the self-check report exists this is a liveness probe only;
      // readiness (ready/degraded) is reported once the boot chain completes.
      status: startup?.status ?? 'ok',
      service: 'growth-agent',
      db: deps.dbDialect,
      zeus: deps.zeusMode,
      ...(startup !== undefined ? { startup } : {}),
      time: new Date().toISOString(),
    });
  });
  return app;
}
