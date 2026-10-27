// Storage driver factory shared by the HTTP server and the batch CLI. Both
// need the same fail-closed behaviour: postgres without DATABASE_URL is an
// error, never a silent sqlite fallback, and a file-backed sqlite path gets
// its directory created first.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AppConfig } from '../config.js';
import type { StorageDriver } from './driver.js';
import { PostgresDriver } from './postgres/postgres-driver.js';
import { SqliteDriver } from './sqlite/sqlite-driver.js';

export async function openDriver(config: AppConfig): Promise<StorageDriver> {
  if (config.dbDriver === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for GA_DB_DRIVER=postgres');
    return PostgresDriver.connect(url);
  }
  if (config.sqlitePath !== ':memory:') {
    mkdirSync(dirname(config.sqlitePath), { recursive: true });
  }
  return new SqliteDriver(config.sqlitePath);
}
