// F-14 regression (2026-11-02 review): a global `replace(/\?/g)` rewrote
// `?` inside string literals, quoted identifiers and comments, shifting every
// following placeholder so parameters bound to the wrong position. The
// converter must touch ONLY real placeholders and leave `$1`/`$foo` text as-is.

import { describe, expect, it, vi } from 'vitest';
import { PostgresDriver, toDollarParams } from '../../src/storage/postgres/postgres-driver.js';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('pg', () => {
  class FakeClient {
    constructor(_config: { connectionString: string }) {}
    async connect() {
      calls.push('connect');
    }
    async query() {
      calls.push('query');
      return { rows: [], rowCount: 0 };
    }
    async end() {
      calls.push('end');
    }
  }
  return { Client: FakeClient };
});

describe('toDollarParams (F-14)', () => {
  it('converts bare ? placeholders in order', () => {
    const { text, count } = toDollarParams('SELECT * FROM t WHERE a = ? AND b = ?');
    expect(text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(count).toBe(2);
  });

  it('leaves literal $1 and $foo untouched while converting the real placeholder', () => {
    const { text } = toDollarParams("SELECT '$1' AS a, '$foo' AS b FROM t WHERE id = ?");
    // Only the trailing placeholder is rewritten; parameter values themselves
    // are passed separately and are never part of the SQL text.
    expect(text).toBe("SELECT '$1' AS a, '$foo' AS b FROM t WHERE id = $1");
  });

  it("does not rewrite ? inside single-quoted strings (with '' escapes)", () => {
    const { text, count } = toDollarParams("SELECT 'what?' AS q, 'it''s ?' AS b WHERE x = ?");
    expect(text).toBe("SELECT 'what?' AS q, 'it''s ?' AS b WHERE x = $1");
    expect(count).toBe(1);
  });

  it('does not rewrite ? inside quoted identifiers, line or block comments', () => {
    const { text, count } = toDollarParams(
      'SELECT "odd?name" -- comment ?\nFROM t /* block ? /* nested ? */ */ WHERE a = ?',
    );
    expect(text).toBe(
      'SELECT "odd?name" -- comment ?\nFROM t /* block ? /* nested ? */ */ WHERE a = $1',
    );
    expect(count).toBe(1);
  });
});

describe('PostgresDriver.connect (connect-before-query regression)', () => {
  it('connects the client before probing with SELECT 1', async () => {
    calls.length = 0;
    const driver = await PostgresDriver.connect('postgres://u:p@127.0.0.1:5432/db');
    expect(calls).toEqual(['connect', 'query']);
    await driver.close();
    expect(calls).toEqual(['connect', 'query', 'end']);
  });
});
