import { Hono } from 'hono';

export interface HealthDeps {
  dbDialect: 'sqlite' | 'postgres';
  zeusMode: 'off' | 'online';
}

/**
 * Liveness/readiness probe. T-A1 only reports static wiring status; later
 * tasks add migration and upstream reachability checks.
 */
export function createHealthApp(deps: HealthDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) =>
    c.json({
      status: 'ok',
      service: 'growth-agent',
      db: deps.dbDialect,
      zeus: deps.zeusMode,
      time: new Date().toISOString(),
    }),
  );
  return app;
}
