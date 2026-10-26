import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp, migrationStatus } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const migrationFile = (dialect: string) =>
  join(repoRoot, 'db', 'migrations', dialect, '001_growth_tasks.sql');

let db: SqliteDriver;

beforeAll(() => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
});

afterAll(async () => {
  await db.close();
});

describe('001_growth_tasks migration (sqlite execution)', () => {
  it('applies on a fresh database', async () => {
    const applied = await migrateUp(db);
    expect(applied).toContain('001_growth_tasks');

    const status = await migrationStatus(db);
    expect(status.pending).toEqual([]);
  });

  it('is idempotent: a second run applies nothing and does not error', async () => {
    expect(await migrateUp(db)).toEqual([]);
  });

  it('creates growth_tasks and api_calls with the §3.1/§11.1 columns', async () => {
    await db.run(
      `INSERT INTO growth_tasks
         (id, site_id, task_type, status, qa_revision_count, cost_micros_total,
          idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['gt_m', 'bayjf.com', 'write', 'signaled', 0, 0, 'gt:gt_m', '2026-10-26T06:00:00.000Z', '2026-10-26T06:00:00.000Z'],
    );
    // api_calls.task_id FK points at growth_tasks.
    await db.run(
      `INSERT INTO api_calls (id, provider, method, endpoint, task_id, units, cost_micros, http_status, cached, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['api_1', 'serp:dataforseo', 'GET', 'serp/task_id', 'gt_m', 10, 1500, 200, 0, '2026-10-26T06:01:00.000Z'],
    );
    const row = await db.get<{ provider: string; cached: number }>(
      'SELECT provider, cached FROM api_calls WHERE id = ?',
      ['api_1'],
    );
    expect(row?.provider).toBe('serp:dataforseo');
    expect(row?.cached).toBe(0);
  });

  it('rejects an api_calls row whose task_id has no matching growth_tasks row', async () => {
    await expect(
      db.run(
        `INSERT INTO api_calls (id, provider, endpoint, task_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['api_bad', 'llm', 'atlas/generate', 'gt_nope', '2026-10-26T06:02:00.000Z'],
      ),
    ).rejects.toThrow();
  });
});

describe('001_growth_tasks migration (postgres dialect structural check, no live PG)', () => {
  const sqliteSql = readFileSync(migrationFile('sqlite'), 'utf8');
  const pgSql = readFileSync(migrationFile('postgres'), 'utf8');

  it('creates the same two tables in both dialects', () => {
    for (const table of ['growth_tasks', 'api_calls']) {
      expect(sqliteSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(pgSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('stores JSON as TEXT on sqlite and JSONB on postgres', () => {
    for (const col of ['pr_ref', 'qa_result', 'verify_result']) {
      expect(sqliteSql).toContain(`${col} TEXT`);
      expect(pgSql).toContain(`${col} JSONB`);
    }
  });

  it('declares the task_id FK inline on postgres and api_calls has cached/provider columns', () => {
    expect(pgSql).toContain('task_id TEXT REFERENCES growth_tasks(id)');
    expect(sqliteSql).toMatch(/FOREIGN KEY \(task_id\) REFERENCES growth_tasks\(id\)/);
    expect(sqliteSql).toContain('cached INTEGER NOT NULL DEFAULT 0');
    expect(pgSql).toContain('cached BOOLEAN NOT NULL DEFAULT false');
  });

  it('uses no ? placeholders in DDL (placeholders belong to the driver layer)', () => {
    expect(sqliteSql).not.toContain('?');
    expect(pgSql).not.toContain('?');
  });

  it('includes the design-mandated cost and state columns', () => {
    for (const col of ['cost_micros_total', 'qa_revision_count', 'idempotency_key', 'zeus_decision_id']) {
      expect(sqliteSql).toContain(col);
      expect(pgSql).toContain(col);
    }
    for (const col of ['provider', 'method', 'endpoint', 'http_status', 'units', 'cost_micros']) {
      expect(sqliteSql).toContain(col);
      expect(pgSql).toContain(col);
    }
  });
});
