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

describe('002_zeus_webhook migration (sqlite execution)', () => {
  it('applies on the already-migrated database and is idempotent on a second run', async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain('002_zeus_webhook');
    expect(status.pending).toEqual([]);
    expect(await migrateUp(db)).toEqual([]);
  });

  it('creates zeus_webhook_deliveries and channel_failures with usable columns', async () => {
    await db.run(
      `INSERT INTO zeus_webhook_deliveries
         (delivery_id, decision_id, event_type, task_id, signature_valid,
          processing_result, error_code, event_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'dec_x:approved:2026-10-26T08:00:00.000Z',
        'dec_x',
        'approved',
        'gt_x',
        1,
        'accepted',
        null,
        '{"type":"approved"}',
        '2026-10-26T09:00:00.000Z',
        '2026-10-26T09:00:00.000Z',
      ],
    );
    await db.run(
      `INSERT INTO channel_failures
         (id, channel, reason, external_ref, retryable, attempts, last_error, created_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'cf:zeus_webhook:INVALID_SIGNATURE',
        'zeus_webhook',
        'INVALID_SIGNATURE',
        'dec_x:approved:2026-10-26T08:00:00.000Z',
        0,
        1,
        'mismatch',
        '2026-10-26T09:00:00.000Z',
        '2026-10-26T09:00:00.000Z',
      ],
    );
    const delivery = await db.get<{ processing_result: string }>(
      'SELECT processing_result FROM zeus_webhook_deliveries WHERE delivery_id = ?',
      ['dec_x:approved:2026-10-26T08:00:00.000Z'],
    );
    expect(delivery?.processing_result).toBe('accepted');
    const failure = await db.get<{ attempts: number }>(
      'SELECT attempts FROM channel_failures WHERE id = ?',
      ['cf:zeus_webhook:INVALID_SIGNATURE'],
    );
    expect(failure?.attempts).toBe(1);
  });
});

describe('002_zeus_webhook migration (postgres dialect structural check, no live PG)', () => {
  const sqliteSql = readFileSync(
    join(repoRoot, 'db', 'migrations', 'sqlite', '002_zeus_webhook.sql'),
    'utf8',
  );
  const pgSql = readFileSync(
    join(repoRoot, 'db', 'migrations', 'postgres', '002_zeus_webhook.sql'),
    'utf8',
  );

  it('creates the same two tables in both dialects', () => {
    for (const table of ['zeus_webhook_deliveries', 'channel_failures']) {
      expect(sqliteSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(pgSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('stores the event payload as TEXT on sqlite and JSONB on postgres', () => {
    expect(sqliteSql).toContain('event_payload TEXT');
    expect(pgSql).toContain('event_payload JSONB');
  });

  it('declares boolean columns as INTEGER on sqlite and BOOLEAN on postgres', () => {
    expect(sqliteSql).toContain('signature_valid INTEGER NOT NULL DEFAULT 1');
    expect(pgSql).toContain('signature_valid BOOLEAN NOT NULL DEFAULT true');
    expect(sqliteSql).toContain('retryable INTEGER NOT NULL DEFAULT 0');
    expect(pgSql).toContain('retryable BOOLEAN NOT NULL DEFAULT false');
  });

  it('uses no ? placeholders in DDL (placeholders belong to the driver layer)', () => {
    expect(sqliteSql).not.toContain('?');
    expect(pgSql).not.toContain('?');
  });

  it('includes the delivery-id primary key and channel-failure aggregate columns', () => {
    for (const col of ['delivery_id', 'decision_id', 'event_type', 'processing_result', 'error_code']) {
      expect(sqliteSql).toContain(col);
      expect(pgSql).toContain(col);
    }
    for (const col of ['channel', 'reason', 'external_ref', 'attempts', 'last_error']) {
      expect(sqliteSql).toContain(col);
      expect(pgSql).toContain(col);
    }
  });
});

describe('004/006 github webhook ledger (sqlite execution)', () => {
  it('dedupes lifecycle actions by deterministic primary key id', async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain('004_github_webhook');
    expect(status.applied).toContain('006_github_ledger_repeatable');
    expect(status.pending).toEqual([]);
    const row = [
      'gh:1:opened',
      1,
      'pull_request',
      'opened',
      'gt_x',
      1,
      'accepted',
      null,
      '{"action":"opened"}',
      '2026-10-26T10:00:00.000Z',
      '2026-10-26T10:00:00.000Z',
    ];
    await db.run(
      `INSERT INTO github_webhook_deliveries
         (id, pr_number, event_type, action, task_id, signature_valid,
          processing_result, error_code, event_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row,
    );
    // Redelivery of the same lifecycle event keeps the same deterministic id.
    await expect(
      db.run(
        `INSERT INTO github_webhook_deliveries
           (id, pr_number, event_type, action, task_id, signature_valid,
            processing_result, error_code, event_payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['gh:1:opened', 1, 'pull_request', 'opened', null, 1, 'accepted', null, '{}', '2026-10-26T10:01:00.000Z', '2026-10-26T10:01:00.000Z'],
      ),
    ).rejects.toThrow();
    // closed-merged and closed-unmerged are distinct ledger actions.
    await db.run(
      `INSERT INTO github_webhook_deliveries
         (id, pr_number, event_type, action, task_id, signature_valid,
          processing_result, error_code, event_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['gh:1:closed-merged', 1, 'pull_request', 'closed-merged', 'gt_x', 1, 'accepted', null, '{}', '2026-10-26T10:02:00.000Z', '2026-10-26T10:02:00.000Z'],
    );
  });

  it('006 allows multiple synchronize rows per PR (human edit pushes)', async () => {
    for (const sha of ['aaa111', 'bbb222', 'ccc333']) {
      await db.run(
        `INSERT INTO github_webhook_deliveries
           (id, pr_number, event_type, action, task_id, signature_valid,
            processing_result, error_code, event_payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`gh:9:synchronize:${sha}`, 9, 'pull_request', 'synchronize', 'gt_x', 1, 'ignored', null, '{}', '2026-10-26T10:03:00.000Z', '2026-10-26T10:03:00.000Z'],
      );
    }
    const rows = await db.all<{ id: string }>(
      `SELECT id FROM github_webhook_deliveries WHERE pr_number = 9 AND action = 'synchronize'`,
    );
    expect(rows).toHaveLength(3);
  });
});

describe('004_github_webhook migration (postgres dialect structural check, no live PG)', () => {
  const sqliteSql = readFileSync(
    join(repoRoot, 'db', 'migrations', 'sqlite', '004_github_webhook.sql'),
    'utf8',
  );
  const pgSql = readFileSync(
    join(repoRoot, 'db', 'migrations', 'postgres', '004_github_webhook.sql'),
    'utf8',
  );

  it('creates github_webhook_deliveries in both dialects', () => {
    expect(sqliteSql).toContain('CREATE TABLE IF NOT EXISTS github_webhook_deliveries');
    expect(pgSql).toContain('CREATE TABLE IF NOT EXISTS github_webhook_deliveries');
  });

  it('stores the event payload as TEXT on sqlite and JSONB on postgres', () => {
    expect(sqliteSql).toContain('event_payload TEXT');
    expect(pgSql).toContain('event_payload JSONB');
  });

  it('declares signature_valid as INTEGER on sqlite and BOOLEAN on postgres', () => {
    expect(sqliteSql).toContain('signature_valid INTEGER NOT NULL DEFAULT 1');
    expect(pgSql).toContain('signature_valid BOOLEAN NOT NULL DEFAULT true');
  });

  it('deduplicates with a unique (pr_number, action) index in both dialects', () => {
    expect(sqliteSql).toContain('uq_github_delivery_action');
    expect(pgSql).toContain('uq_github_delivery_action');
    expect(sqliteSql).toContain('ON github_webhook_deliveries(pr_number, action)');
    expect(pgSql).toContain('ON github_webhook_deliveries(pr_number, action)');
  });

  it('uses no ? placeholders in DDL', () => {
    expect(sqliteSql).not.toContain('?');
    expect(pgSql).not.toContain('?');
  });
});

describe('006_github_ledger_repeatable migration (structural check, no live PG)', () => {
  const sqliteSql = readFileSync(
    join(repoRoot, 'db', 'migrations', 'sqlite', '006_github_ledger_repeatable.sql'),
    'utf8',
  );
  const pgSql = readFileSync(
    join(repoRoot, 'db', 'migrations', 'postgres', '006_github_ledger_repeatable.sql'),
    'utf8',
  );

  it('removes the composite unique index in both dialects', () => {
    expect(pgSql).toContain('DROP INDEX IF EXISTS uq_github_delivery_action');
    expect(sqliteSql).toContain('DROP INDEX IF EXISTS uq_github_delivery_action');
  });

  it('keeps a non-unique pr_number index for lookups in both dialects', () => {
    expect(sqliteSql).toContain('idx_github_delivery_pr');
    expect(pgSql).toContain('idx_github_delivery_pr');
    expect(sqliteSql).not.toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(pgSql).not.toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
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
