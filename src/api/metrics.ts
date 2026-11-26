import { Hono } from 'hono';
import {
  type GrowthAgentMetricsService,
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusMetrics,
} from '../observability/prometheus.js';

/**
 * Prometheus scrapes `/metrics` from the local tier0-net. This route is
 * deliberately outside every webhook/auth guard: it exposes aggregate counts
 * only, never task ids, PR refs (repo URLs), decision ids or error text.
 */
export function createMetricsApp(deps: { service: GrowthAgentMetricsService }): Hono {
  const app = new Hono();
  app.get('/metrics', async (c) => {
    const snapshot = await deps.service.getMetrics();
    return c.text(renderPrometheusMetrics(snapshot), 200, {
      'Content-Type': PROMETHEUS_CONTENT_TYPE,
      'Cache-Control': 'no-store',
    });
  });
  return app;
}
