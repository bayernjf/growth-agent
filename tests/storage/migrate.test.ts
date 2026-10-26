import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp, migrationStatus } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, '..', 'fixtures');

let db: SqliteDriver;

beforeAll(() => {
  process.env.GA_REPO_ROOT = fixturesRoot;
  db = new SqliteDriver(':memory:');
});

afterAll(async () => {
  await db.close();
});

describe('migrate (dual-dialect runner, sqlite fixture)', () => {
  it('applies pending migrations and records them', async () => {
    const applied = await migrateUp(db);
    expect(applied).toEqual(['001_smoke']);

    const status = await migrationStatus(db);
    expect(status.pending).toEqual([]);
    expect(status.applied).toContain('001_smoke');

    // The migrated table is usable.
    await db.run('INSERT INTO smoke_items (id, name) VALUES (?, ?)', ['x', 'hello']);
    const row = await db.get<{ name: string }>('SELECT name FROM smoke_items WHERE id = ?', ['x']);
    expect(row?.name).toBe('hello');
  });

  it('is idempotent: a second run applies nothing', async () => {
    expect(await migrateUp(db)).toEqual([]);
  });
});
