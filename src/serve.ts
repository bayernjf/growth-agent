import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createHealthApp } from './api/health.js';
import { PostgresDriver } from './storage/postgres/postgres-driver.js';
import { migrateUp } from './storage/migrate.js';
import type { StorageDriver } from './storage/driver.js';
import { SqliteDriver } from './storage/sqlite/sqlite-driver.js';

async function createDriver(): Promise<StorageDriver> {
  const config = loadConfig();
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

async function main(): Promise<void> {
  // Load a local .env if present so GA_* settings can live in a file.
  // Kept out of config.ts so unit tests import config without env side effects.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const config = loadConfig();
  const driver = await createDriver();
  await migrateUp(driver);

  const app = new Hono();
  app.route('/', createHealthApp({ dbDialect: driver.dialect, zeusMode: config.zeusMode }));

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    console.log(
      `growth-agent listening on http://${config.host}:${config.port} (db=${config.dbDriver}, zeus=${config.zeusMode})`,
    );
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
