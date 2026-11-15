import type { StorageDriver } from '../driver.js';

/**
 * Postgres driver for production. The `pg` package is an optional
 * dependency that is NOT installed in local CI: constructing this driver
 * without it fails closed with an actionable error instead of silently
 * falling back to another dialect.
 *
 * Business SQL uses `?` placeholders; this driver converts them to `$1..$n`
 * (see `toDollarParams` below for the literal/comment-aware scanner).
 */
/**
 * Convert business `?` placeholders to `$1..$n` while copying SQL text
 * verbatim everywhere else (F-14, 2026-11-02 review). A plain global
 * `replace(/\?/g)` would also rewrite a `?` inside a string literal, a quoted
 * identifier or a comment; the extra `$n` then shifts every following
 * placeholder so parameters bind to the wrong column (or fail outright).
 *
 * Skipped regions (copied unchanged):
 *   - single-quoted strings (with '' escapes)
 *   - double-quoted identifiers (with "" escapes)
 *   - -- line comments and (nested) block comments
 * Literal text such as `$1` or `$foo` is never touched; only bare `?`
 * placeholders outside those regions consume the next parameter.
 */
export function toDollarParams(sql: string): { text: string; count: number } {
  let text = '';
  let count = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      text += ch;
      i++;
      while (i < sql.length) {
        const inner = sql[i] as string;
        text += inner;
        i++;
        if (inner === quote) {
          if (sql[i] === quote) {
            text += quote;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        text += sql[i] as string;
        i++;
      }
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      text += '/*';
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          text += '*/';
          i += 2;
          depth--;
        } else if (sql[i] === '/' && sql[i + 1] === '*') {
          text += '/*';
          i += 2;
          depth++;
        } else {
          text += sql[i] as string;
          i++;
        }
      }
      continue;
    }
    if (ch === '?') {
      count++;
      text += `$${count}`;
      i++;
      continue;
    }
    text += ch as string;
    i++;
  }
  return { text, count };
}

export class PostgresDriver implements StorageDriver {
  readonly dialect = 'postgres' as const;
  // Minimal structural surface of pg.Client used here.
  private readonly client: {
    connect: () => Promise<void>;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    end: () => Promise<void>;
  };
  // Single-connection client: serialize transactions so BEGIN/COMMIT blocks
  // cannot interleave across concurrent requests.
  private txQueue: Promise<unknown> = Promise.resolve();

  private constructor(client: PostgresDriver['client']) {
    this.client = client;
  }

  static async connect(connectionString: string): Promise<PostgresDriver> {
    let pg: { Client: new (config: { connectionString: string }) => PostgresDriver['client'] };
    try {
      // `pg` is an optional production dependency that is not installed in
      // local CI; its types are intentionally absent here.
      // @ts-expect-error -- optional runtime dependency, see class doc
      pg = (await import('pg')) as typeof pg;
    } catch {
      throw new Error(
        'Postgres driver requested but the optional `pg` dependency is not installed. Run `npm install pg` in the production environment.',
      );
    }
    const client = new pg.Client({ connectionString });
    // pg.Client does not auto-connect on query(): without an explicit
    // connect() the probe below would queue forever (0 active handles,
    // silent hang) instead of failing with an auth/network error.
    await client.connect();
    await client.query('SELECT 1');
    return new PostgresDriver(client);
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const { text } = toDollarParams(sql);
    const result = await this.client.query(text, [...params]);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const { text } = toDollarParams(sql);
    const result = await this.client.query(text, [...params]);
    return { changes: result.rowCount };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async withTransaction<T>(fn: (tx: StorageDriver) => Promise<T>): Promise<T> {
    const previous = this.txQueue;
    let release: () => void;
    this.txQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.client.query('BEGIN');
      const result = await fn(this);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    } finally {
      release!();
    }
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
