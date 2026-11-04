// F-14 regression (2026-11-02 review): a global `replace(/\?/g)` rewrote
// `?` inside string literals, quoted identifiers and comments, shifting every
// following placeholder so parameters bound to the wrong position. The
// converter must touch ONLY real placeholders and leave `$1`/`$foo` text as-is.

import { describe, expect, it } from 'vitest';
import { toDollarParams } from '../../src/storage/postgres/postgres-driver.js';

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
