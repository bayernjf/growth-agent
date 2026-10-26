import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createHealthApp } from './api/health.js';
import { createZeusWebhookApp } from './api/webhooks/zeus.js';
import { createGithubWebhookApp } from './api/webhooks/github.js';
import { PostgresDriver } from './storage/postgres/postgres-driver.js';
import { migrateUp } from './storage/migrate.js';
import type { StorageDriver } from './storage/driver.js';
import { SqliteDriver } from './storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from './task/repository.js';
import {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
} from './connector/zeus/webhook-repository.js';
import { GithubWebhookRepository } from './publisher/github/webhook-repository.js';
import { createZeusDecisionClient } from './connector/zeus/registry.js';
import {
  runStartupChecks,
  type StartupCheckReport,
} from './startup/self-check.js';

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
  // 1. Migrations always run on boot (idempotent; growth-os convention).
  await migrateUp(driver);

  const tasks = new GrowthTaskRepository(driver);
  const failures = new ChannelFailureRepository(driver);
  const zeus = createZeusDecisionClient(config);

  // 2. Startup self-check chain (T-F2): credential presence, zeus ping +
  // webhook re-subscription, decision reconciliation. Fails closed.
  const startupReport: StartupCheckReport = await runStartupChecks({
    config,
    driver,
    zeus,
    tasks,
    failures,
    now: () => new Date().toISOString(),
  });

  const app = new Hono();
  app.route(
    '/',
    createHealthApp({
      dbDialect: driver.dialect,
      zeusMode: config.zeusMode,
      getStartupReport: () => startupReport,
    }),
  );
  app.route(
    '/webhooks/zeus',
    createZeusWebhookApp({
      secret: config.zeusWebhookSecret ?? '',
      deliveries: new WebhookDeliveryRepository(driver),
      failures,
      tasks,
      now: () => new Date().toISOString(),
    }),
  );
  app.route(
    '/webhooks/github',
    createGithubWebhookApp({
      secret: config.githubWebhookSecret ?? '',
      deliveries: new GithubWebhookRepository(driver),
      failures,
      tasks,
      now: () => new Date().toISOString(),
    }),
  );

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    console.log(
      `growth-agent listening on http://${config.host}:${config.port} (db=${config.dbDriver}, zeus=${config.zeusMode}, status=${startupReport?.status ?? 'unknown'})`,
    );
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
