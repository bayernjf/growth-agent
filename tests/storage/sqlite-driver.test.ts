import { describe, expect, it } from 'vitest';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';

async function withDriver(fn: (db: SqliteDriver) => Promise<void>): Promise<void> {
  const db = new SqliteDriver(':memory:');
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

describe('SqliteDriver', () => {
  it('creates a table and does CRUD with ? placeholders', () =>
    withDriver(async (db) => {
      await db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL);');
      expect((await db.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1])).changes).toBe(1);
      await db.run('INSERT INTO t (id, n) VALUES (?, ?)', ['b', 2]);

      const row = await db.get<{ id: string; n: number }>('SELECT id, n FROM t WHERE id = ?', ['a']);
      expect(row?.n).toBe(1);

      const all = await db.all<{ id: string }>('SELECT id FROM t ORDER BY id');
      expect(all.map((r) => r.id)).toEqual(['a', 'b']);

      expect((await db.run('UPDATE t SET n = ? WHERE id = ?', [9, 'a'])).changes).toBe(1);
      expect((await db.get<{ n: number }>('SELECT n FROM t WHERE id = ?', ['a']))?.n).toBe(9);
    }));

  it('enforces foreign keys', () =>
    withDriver(async (db) => {
      await db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY);');
      await db.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));');
      await expect(
        db.run('INSERT INTO child (id, parent_id) VALUES (?, ?)', ['c', 'missing']),
      ).rejects.toThrow();
    }));
});
