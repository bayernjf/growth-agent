import type { StorageDriver } from '../storage/driver.js';
import { GROWTH_TASK_STATUSES } from '../task/state-machine.js';

/**
 * Read-only metrics for the Tier0 collector.
 *
 * The snapshot is derived from persisted rows only and reduced to bounded
 * counts. Task ids, PR refs (which carry repo URLs), decision ids, delivery
 * ids, event payloads and failure error text never become labels or values:
 * they are unbounded or identifying, and must not be copied into Prometheus.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const TASK_TYPES = ['write', 'fix', 'monitor'] as const;

export interface GrowthAgentMetricsSnapshot {
  capturedAt: string;
  uptimeSeconds: number;
  tasks: Record<string, number>;
  tasksTotal: number;
  tasksByType: Record<string, number>;
  apiCalls: Record<string, number>;
  apiCallsTotal: number;
  apiCostMicros: Record<string, number>;
  apiCostMicrosTotal: number;
  webhookDeliveries: {
    zeus: Record<string, number>;
    github: Record<string, number>;
    total: number;
  };
  channelFailures: Record<string, number>;
  gscSnapshots: number;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class GrowthAgentMetricsService {
  private readonly startedAtMs: number;

  constructor(
    private readonly driver: StorageDriver,
    startedAtMs = Date.now(),
  ) {
    this.startedAtMs = startedAtMs;
  }

  async getMetrics(now = new Date()): Promise<GrowthAgentMetricsSnapshot> {
    const [
      taskStatusRows,
      taskTypeRows,
      apiProviderRows,
      apiTotalRow,
      apiCostRows,
      apiCostTotalRow,
      zeusWebhookRows,
      githubWebhookRows,
      failureRows,
      gscRow,
    ] = await Promise.all([
      this.driver.all<{ status: string; count: unknown }>(
        'SELECT status, COUNT(*) AS count FROM growth_tasks GROUP BY status',
      ),
      this.driver.all<{ task_type: string; count: unknown }>(
        'SELECT task_type, COUNT(*) AS count FROM growth_tasks GROUP BY task_type',
      ),
      this.driver.all<{ provider: string; count: unknown }>(
        'SELECT provider, COUNT(*) AS count FROM api_calls GROUP BY provider',
      ),
      this.driver.get<{ count: unknown }>('SELECT COUNT(*) AS count FROM api_calls'),
      this.driver.all<{ provider: string; cost: unknown }>(
        'SELECT provider, SUM(cost_micros) AS cost FROM api_calls GROUP BY provider',
      ),
      this.driver.get<{ cost: unknown }>('SELECT SUM(cost_micros) AS cost FROM api_calls'),
      this.driver.all<{ processing_result: string; count: unknown }>(
        'SELECT processing_result, COUNT(*) AS count FROM zeus_webhook_deliveries GROUP BY processing_result',
      ),
      this.driver.all<{ processing_result: string; count: unknown }>(
        'SELECT processing_result, COUNT(*) AS count FROM github_webhook_deliveries GROUP BY processing_result',
      ),
      this.driver.all<{ channel: string; attempts: unknown }>(
        'SELECT channel, SUM(attempts) AS attempts FROM channel_failures GROUP BY channel',
      ),
      this.driver.get<{ count: unknown }>('SELECT COUNT(*) AS count FROM gsc_daily_snapshot'),
    ]);

    const tasks: Record<string, number> = {};
    for (const status of GROWTH_TASK_STATUSES) tasks[status] = 0;
    for (const row of taskStatusRows) {
      if ((GROWTH_TASK_STATUSES as readonly string[]).includes(row.status)) {
        tasks[row.status] = count(row.count);
      }
    }

    const tasksByType: Record<string, number> = {};
    for (const type of TASK_TYPES) tasksByType[type] = 0;
    for (const row of taskTypeRows) {
      if ((TASK_TYPES as readonly string[]).includes(row.task_type)) {
        tasksByType[row.task_type] = count(row.count);
      }
    }

    const apiCalls: Record<string, number> = {};
    for (const row of apiProviderRows) apiCalls[row.provider] = count(row.count);

    const apiCostMicros: Record<string, number> = {};
    for (const row of apiCostRows) apiCostMicros[row.provider] = count(row.cost);

    const zeus: Record<string, number> = {};
    for (const row of zeusWebhookRows) zeus[row.processing_result] = count(row.count);

    const github: Record<string, number> = {};
    for (const row of githubWebhookRows) github[row.processing_result] = count(row.count);

    const channelFailures: Record<string, number> = {};
    for (const row of failureRows) channelFailures[row.channel] = count(row.attempts);

    const webhookTotal =
      Object.values(zeus).reduce((sum, value) => sum + value, 0) +
      Object.values(github).reduce((sum, value) => sum + value, 0);

    return {
      capturedAt: now.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - this.startedAtMs) / 1000)),
      tasks,
      tasksTotal: Object.values(tasks).reduce((sum, value) => sum + value, 0),
      tasksByType,
      apiCalls,
      apiCallsTotal: count(apiTotalRow?.count),
      apiCostMicros,
      apiCostMicrosTotal: count(apiCostTotalRow?.cost),
      webhookDeliveries: { zeus, github, total: webhookTotal },
      channelFailures,
      gscSnapshots: count(gscRow?.count),
    };
  }
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(',')}}`;
}

class Family {
  private readonly samples: string[] = [];

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly type: 'gauge' | 'counter',
  ) {}

  add(value: number, pairs: ReadonlyArray<readonly [string, string]> = []): void {
    if (!Number.isFinite(value)) return;
    this.samples.push(`${this.name}${labels(pairs)} ${value}`);
  }

  render(): string {
    if (this.samples.length === 0) return '';
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n${this.samples.join('\n')}\n`;
  }
}

export function renderPrometheusMetrics(snapshot: GrowthAgentMetricsSnapshot): string {
  const blocks: string[] = [];
  const push = (family: Family): void => {
    const text = family.render();
    if (text) blocks.push(text);
  };

  const up = new Family(
    'growth_agent_up',
    'Always 1 while the growth-agent runtime serves a metrics snapshot.',
    'gauge',
  );
  up.add(1);
  push(up);

  const uptime = new Family('growth_agent_uptime_seconds', 'Process uptime in seconds.', 'gauge');
  uptime.add(snapshot.uptimeSeconds);
  push(uptime);

  const captured = new Family(
    'growth_agent_metrics_snapshot_timestamp_seconds',
    'Unix time the snapshot was captured; a stale value means the aggregation stopped advancing.',
    'gauge',
  );
  captured.add(Date.parse(snapshot.capturedAt) / 1000);
  push(captured);

  const tasks = new Family('growth_agent_tasks', 'Growth tasks, by state-machine status.', 'gauge');
  for (const [status, value] of Object.entries(snapshot.tasks)) tasks.add(value, [['status', status]]);
  push(tasks);

  const tasksTotal = new Family('growth_agent_tasks_total', 'Total growth tasks across all states.', 'gauge');
  tasksTotal.add(snapshot.tasksTotal);
  push(tasksTotal);

  const tasksByType = new Family(
    'growth_agent_tasks_by_type',
    'Growth tasks, by task type (write/fix/monitor).',
    'gauge',
  );
  for (const [taskType, value] of Object.entries(snapshot.tasksByType)) {
    tasksByType.add(value, [['task_type', taskType]]);
  }
  push(tasksByType);

  const apiCalls = new Family('growth_agent_api_calls', 'Cost-ledger API calls, by provider.', 'gauge');
  for (const [provider, value] of Object.entries(snapshot.apiCalls)) {
    apiCalls.add(value, [['provider', provider]]);
  }
  push(apiCalls);

  const apiCallsTotal = new Family('growth_agent_api_calls_total', 'Total cost-ledger API calls.', 'gauge');
  apiCallsTotal.add(snapshot.apiCallsTotal);
  push(apiCallsTotal);

  const apiCost = new Family(
    'growth_agent_api_cost_micros',
    'Estimated API cost in micro units, by provider.',
    'gauge',
  );
  for (const [provider, value] of Object.entries(snapshot.apiCostMicros)) {
    apiCost.add(value, [['provider', provider]]);
  }
  push(apiCost);

  const apiCostTotal = new Family(
    'growth_agent_api_cost_micros_total',
    'Total estimated API cost in micro units across all providers.',
    'gauge',
  );
  apiCostTotal.add(snapshot.apiCostMicrosTotal);
  push(apiCostTotal);

  const webhooks = new Family(
    'growth_agent_webhook_deliveries',
    'Inbound webhook deliveries, by source (zeus/github) and processing result.',
    'gauge',
  );
  for (const [result, value] of Object.entries(snapshot.webhookDeliveries.zeus)) {
    webhooks.add(value, [
      ['source', 'zeus'],
      ['result', result],
    ]);
  }
  for (const [result, value] of Object.entries(snapshot.webhookDeliveries.github)) {
    webhooks.add(value, [
      ['source', 'github'],
      ['result', result],
    ]);
  }
  push(webhooks);

  const webhookTotal = new Family(
    'growth_agent_webhook_deliveries_total',
    'Total inbound webhook deliveries across zeus and github.',
    'gauge',
  );
  webhookTotal.add(snapshot.webhookDeliveries.total);
  push(webhookTotal);

  const failures = new Family(
    'growth_agent_channel_failures',
    'Channel failure attempts, by channel.',
    'gauge',
  );
  for (const [channel, value] of Object.entries(snapshot.channelFailures)) {
    failures.add(value, [['channel', channel]]);
  }
  push(failures);

  const gsc = new Family(
    'growth_agent_gsc_snapshots',
    'Rows in the GSC daily snapshot table.',
    'gauge',
  );
  gsc.add(snapshot.gscSnapshots);
  push(gsc);

  return blocks.join('\n');
}
