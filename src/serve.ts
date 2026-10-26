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
  // Fail-closed boot check (T-A5): inbound webhook verification needs the same
  // shared secret zeus signs with. An online deployment without it must refuse
  // to start rather than silently accept unsigned lifecycle events.
  if (config.zeusMode === 'online' && (config.zeusWebhookSecret ?? '').length < 16) {
    throw new Error(
      'GA_ZEUS_MODE=online requires GA_ZEUS_WEBHOOK_SECRET (>=16 chars) to verify inbound zeus webhooks',
    );
  }
  // Inbound GitHub PR events must be verified: an online publisher deployment
  // without the webhook secret must refuse to start rather than accept
  // unsigned lifecycle events.
  if (config.githubMode === 'online' && (config.githubWebhookSecret ?? '').length < 16) {
    throw new Error(
      'GA_GITHUB_MODE=online requires GA_GITHUB_WEBHOOK_SECRET (>=16 chars) to verify inbound GitHub webhooks',
    );
  }
  const driver = await createDriver();
  await migrateUp(driver);

  const app = new Hono();
  app.route('/', createHealthApp({ dbDialect: driver.dialect, zeusMode: config.zeusMode }));
  app.route(
    '/webhooks/zeus',
    createZeusWebhookApp({
      secret: config.zeusWebhookSecret ?? '',
      deliveries: new WebhookDeliveryRepository(driver),
      failures: new ChannelFailureRepository(driver),
      tasks: new GrowthTaskRepository(driver),
      now: () => new Date().toISOString(),
    }),
  );
  app.route(
    '/webhooks/github',
    createGithubWebhookApp({
      secret: config.githubWebhookSecret ?? '',
      deliveries: new GithubWebhookRepository(driver),
      failures: new ChannelFailureRepository(driver),
      tasks: new GrowthTaskRepository(driver),
      now: () => new Date().toISOString(),
    }),
  );

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
