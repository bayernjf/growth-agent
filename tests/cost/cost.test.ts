import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { parseCostRates, Pricing } from '../../src/cost/pricing.js';
import { CostRecorder } from '../../src/cost/recorder.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { GrowthAgentErrors } from '../../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

let db: SqliteDriver;
let repo: ApiCallRepository;

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
  repo = new ApiCallRepository(db);
  // api_calls.task_id has an FK to growth_tasks (migration 001).
  await new GrowthTaskRepository(db).create(
    { id: 'gt_1', siteId: 's', type: 'write', status: 'signaled' },
    '2026-10-19T00:00:00.000Z',
  );
});

afterAll(async () => {
  await db.close();
});

describe('Pricing (§11.1)', () => {
  it('estimates zero without configured rates', () => {
    expect(new Pricing().estimate('serp:dataforseo', 100)).toBe(0);
  });

  it('applies configured micros-per-unit rates', () => {
    const pricing = new Pricing(parseCostRates('{"serp:dataforseo":12.5}'));
    expect(pricing.estimate('serp:dataforseo', 4)).toBe(50);
  });

  it('fails closed on malformed or non-numeric GA_COST_RATES', () => {
    expect(() => parseCostRates('{not json')).toThrowError(/GA_COST_RATES/);
    expect(() => parseCostRates('[]')).toThrowError();
    expect(() => parseCostRates('{"serp:-1}')).toThrowError();
    expect(() => parseCostRates('{"serp":"x"}')).toThrowError();
  });

  it('treats empty string as zero rates', () => {
    expect(parseCostRates('').microsPerUnit).toEqual({});
  });
});

describe('ApiCallRepository + CostRecorder', () => {
  const t0 = '2026-10-20T00:00:00.000Z';
  const t1 = '2026-10-20T06:00:00.000Z';
  const t2 = '2026-10-21T06:00:00.000Z';
  const pricing = new Pricing(parseCostRates('{"serp":10,"gsc":0}'));

  it('records a successful metered call with cost and units', async () => {
    const recorder = new CostRecorder(repo, pricing, () => t0);
    const data = await recorder.measure(
      { provider: 'serp', method: 'GET', endpoint: 'serp', taskId: 'gt_1' },
      async () => ({ data: { ok: true }, units: 3, httpStatus: 200 }),
    );
    expect(data).toEqual({ ok: true });
    const rows = await repo.list(t0, t2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'serp',
      units: 3,
      costMicros: 30,
      httpStatus: 200,
      taskId: 'gt_1',
      cached: false,
    });
  });

  it('records a zero-cost failure row then rethrows', async () => {
    const recorder = new CostRecorder(repo, pricing, () => t1);
    await expect(
      recorder.measure(
        { provider: 'gsc', method: 'GET', endpoint: 'searchanalytics' },
        async () => {
          throw GrowthAgentErrors.upstreamUnavailable('gsc 503');
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    const rows = await repo.list(t0, t2);
    const failed = rows.find(r => r.provider === 'gsc');
    expect(failed).toBeDefined();
    expect(failed?.units).toBe(0);
    expect(failed?.costMicros).toBe(0);
    expect(failed?.httpStatus).toBe(503);
  });

  it('aggregates range cost and per-provider splits', async () => {
    const range = await repo.rangeCost(t0, t2);
    expect(range.calls).toBe(2);
    expect(range.costMicros).toBe(30);
    const byProvider = await repo.costByProvider(t0, t2);
    expect(byProvider.map(r => r.provider)).toContain('serp');
    const serp = byProvider.find(r => r.provider === 'serp');
    expect(serp?.costMicros).toBe(30);
  });

  it('excludes rows outside the [from, to) window', async () => {
    const range = await repo.rangeCost(t2, '2026-10-22T00:00:00.000Z');
    expect(range.calls).toBe(0);
  });
});
