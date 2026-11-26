import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import {
  GrowthAgentMetricsService,
  renderPrometheusMetrics,
} from '../src/observability/prometheus.js';
import { createMetricsApp } from '../src/api/metrics.js';

describe('growth-agent metrics', () => {
  let driver: SqliteDriver;
  let service: GrowthAgentMetricsService;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    service = new GrowthAgentMetricsService(driver, Date.now() - 30_000);
  });

  afterEach(async () => {
    await driver.close();
  });

  async function seed(): Promise<void> {
    await driver.withTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO growth_tasks (id, site_id, task_type, status, cost_micros_total, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['gt-1', 'bayjf', 'write', 'merged', 1000, 'gt:gt-1', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO growth_tasks (id, site_id, task_type, status, cost_micros_total, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['gt-2', 'bayjf', 'fix', 'done', 500, 'gt:gt-2', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO api_calls (id, provider, method, endpoint, units, cost_micros, cached, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['ac-1', 'gsc', 'GET', 'searchanalytics', 10, 1000, 0, '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO api_calls (id, provider, method, endpoint, units, cost_micros, cached, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['ac-2', 'llm', 'POST', 'chat.completions', 120, 500, 0, '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO zeus_webhook_deliveries (delivery_id, decision_id, event_type, signature_valid, processing_result, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        ['d-1', 'dec-1', 'approved', 1, 'accepted', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO github_webhook_deliveries (id, pr_number, event_type, action, signature_valid, processing_result, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['gh:7:opened', 7, 'pull_request', 'opened', 1, 'ignored', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO channel_failures (id, channel, reason, retryable, attempts, last_error, created_at, last_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['cf-1', 'zeus_webhook', 'INVALID_SIGNATURE', 0, 3, 'sanitized', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO gsc_daily_snapshot (site_url, snapshot_date, dimension_key, clicks, impressions, position, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['https://bayjf.com/', '2026-11-21', 'query', 4, 40, 2.5, '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
      );
    });
  }

  it('aggregates only persisted, bounded-count fields', async () => {
    await seed();
    const snapshot = await service.getMetrics(new Date('2026-11-22T12:00:00.000Z'));

    expect(snapshot.tasksTotal).toBe(2);
    expect(snapshot.tasks.merged).toBe(1);
    expect(snapshot.tasks.done).toBe(1);
    expect(snapshot.tasksByType.write).toBe(1);
    expect(snapshot.tasksByType.fix).toBe(1);
    expect(snapshot.apiCallsTotal).toBe(2);
    expect(snapshot.apiCalls.gsc).toBe(1);
    expect(snapshot.apiCalls.llm).toBe(1);
    expect(snapshot.apiCostMicrosTotal).toBe(1500);
    expect(snapshot.apiCostMicros.gsc).toBe(1000);
    expect(snapshot.apiCostMicros.llm).toBe(500);
    expect(snapshot.webhookDeliveries.total).toBe(2);
    expect(snapshot.webhookDeliveries.zeus.accepted).toBe(1);
    expect(snapshot.webhookDeliveries.github.ignored).toBe(1);
    expect(snapshot.channelFailures.zeus_webhook).toBe(3);
    expect(snapshot.gscSnapshots).toBe(1);
    expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);

    const text = renderPrometheusMetrics(snapshot);
    expect(text).toContain('growth_agent_up 1');
    expect(text).toContain('growth_agent_tasks{status="merged"} 1');
    expect(text).toContain('growth_agent_tasks_by_type{task_type="write"} 1');
    expect(text).toContain('growth_agent_api_calls{provider="gsc"} 1');
    expect(text).toContain('growth_agent_api_cost_micros{provider="llm"} 500');
    expect(text).toContain('growth_agent_webhook_deliveries{source="zeus",result="accepted"} 1');
    expect(text).toContain('growth_agent_channel_failures{channel="zeus_webhook"} 3');
    expect(text).not.toContain('gt-1');
    expect(text).not.toContain('dec-1');
    expect(text).not.toContain('https://bayjf.com/');
    expect(text).not.toContain('sanitized');
  });

  it('serves /metrics as Prometheus text', async () => {
    const app = createMetricsApp({ service });
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('growth_agent_up 1');
  });
});
