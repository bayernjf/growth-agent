import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { ChannelFailureRepository } from '../../src/connector/zeus/webhook-repository.js';
import { OfflineZeusClient } from '../../src/connector/zeus/offline.js';
import {
  assertCredentialPresence,
  checkCredentialPresence,
  runStartupChecks,
} from '../../src/startup/self-check.js';
import type { AppConfig } from '../../src/config.js';
import type { ZeusDecisionClient, ZeusSelfCheckResult, ZeusDecisionReplay } from '../../src/connector/zeus/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const offlineConfig: AppConfig = {
  host: '127.0.0.1',
  port: 8790,
  dbDriver: 'sqlite',
  sqlitePath: ':memory:',
  zeusMode: 'off',
  gscMode: 'off',
  gscTokenDir: '/tmp/tokens',
  serpMode: 'off',
  loomMode: 'off',
  draftMode: 'inbox',
  draftInboxDir: '/tmp/drafts',
  githubMode: 'off',
  githubBaseBranch: 'main',
  reportDir: '/tmp/reports',
  zeusWebhookMaxSkewSeconds: 300,
};

let db: SqliteDriver;

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
});

afterAll(async () => {
  await db.close();
});

describe('checkCredentialPresence (fail-closed boot matrix)', () => {
  it('passes everything in all-offline mode', () => {
    const presence = checkCredentialPresence(offlineConfig);
    expect(presence.every(p => p.ok)).toBe(true);
    expect(presence.every(p => !p.checked)).toBe(true);
  });

  it('lists every missing zeus credential at once', () => {
    const presence = checkCredentialPresence({ ...offlineConfig, zeusMode: 'online' });
    const zeus = presence.find(p => p.connector === 'zeus');
    expect(zeus?.ok).toBe(false);
    expect(zeus?.missing).toEqual([
      'GA_ZEUS_URL',
      'GA_ZEUS_TOKEN',
      'GA_ZEUS_WEBHOOK_SECRET(>=16)',
    ]);
  });

  it('requires GSC oauth client and a >=32 char master key', () => {
    const presence = checkCredentialPresence({ ...offlineConfig, gscMode: 'online' });
    const gsc = presence.find(p => p.connector === 'gsc');
    expect(gsc?.missing).toEqual([
      'GA_GSC_CLIENT_ID',
      'GA_GSC_CLIENT_SECRET',
      'GA_GROWTH_MASTER_KEY(>=32 chars)',
    ]);
  });

  it('requires SERP and GitHub credentials for their online modes', () => {
    const serp = checkCredentialPresence({ ...offlineConfig, serpMode: 'online' }).find(
      p => p.connector === 'serp',
    );
    expect(serp?.missing).toEqual([
      'GA_SERP_DATAFORSEO_LOGIN',
      'GA_SERP_DATAFORSEO_PASSWORD',
    ]);
    const github = checkCredentialPresence({ ...offlineConfig, githubMode: 'online' }).find(
      p => p.connector === 'github',
    );
    expect(github?.missing).toEqual([
      'GA_GITHUB_TOKEN',
      'GA_GITHUB_OWNER',
      'GA_GITHUB_REPO',
      'GA_GITHUB_WEBHOOK_SECRET(>=16)',
    ]);
    const loom = checkCredentialPresence({ ...offlineConfig, loomMode: 'online' }).find(
      p => p.connector === 'loom',
    );
    expect(loom?.missing).toEqual(['GA_LOOM_URL', 'GA_LOOM_TENANT_ID']);
  });

  it('passes online zeus when all credentials are present', () => {
    const presence = checkCredentialPresence({
      ...offlineConfig,
      zeusMode: 'online',
      zeusUrl: 'http://zeus:8787',
      zeusToken: 'tok',
      zeusWebhookSecret: '0123456789abcdef0123456789abcdef',
    });
    expect(presence.find(p => p.connector === 'zeus')?.ok).toBe(true);
  });

  it('assertCredentialPresence aggregates all missing vars in one error', () => {
    expect(() =>
      assertCredentialPresence({
        ...offlineConfig,
        zeusMode: 'online',
        serpMode: 'online',
      }),
    ).toThrowError(/GA_ZEUS_URL/);
  });

  it('fails closed on malformed GA_COST_RATES', () => {
    expect(() => assertCredentialPresence({ ...offlineConfig, costRates: 'not-json' })).toThrowError();
  });
});

describe('runStartupChecks', () => {
  const now = '2026-10-26T06:00:00.000Z';

  it('reports ready for the all-offline deployment and reconciles', async () => {
    const tasks = new GrowthTaskRepository(db);
    await tasks.create({ id: 'gt_boot', siteId: 's', type: 'write', status: 'deciding' }, now);
    await tasks.patch('gt_boot', { zeusDecisionId: 'dec_boot' }, now);
    const report = await runStartupChecks({
      config: offlineConfig,
      driver: db,
      zeus: new OfflineZeusClient(),
      tasks,
      failures: new ChannelFailureRepository(db),
      now: () => now,
    });
    expect(report.status).toBe('ready');
    expect(report.zeus).toMatchObject({ mode: 'off', ping: true });
    expect(report.reconcile.unchanged).toBe(1);
    expect(report.db.dialect).toBe('sqlite');
  });

  it('refuses to start online when zeus is unreachable', async () => {
    const unreachable: ZeusDecisionClient = {
      name: 'zeus-down',
      mode: 'online',
      submitDecision: async () => {
        throw new Error('x');
      },
      getDecisionAudit: async (id: string): Promise<ZeusDecisionReplay> => ({
        format: 'json',
        record: { id },
        events: [],
      }),
      getPolicies: async () => {
        throw new Error('x');
      },
      ping: async () => false,
      buildSubscriptionPayload: ({ callbackUrl, secret }) => ({ url: callbackUrl, secret, active: true }),
      startupSelfCheck: async (): Promise<ZeusSelfCheckResult> => ({
        ping: false,
        policyVersion: 0,
        policyDefaultGrade: '',
        resubscribed: false,
      }),
    };
    const config: AppConfig = {
      ...offlineConfig,
      zeusMode: 'online',
      zeusUrl: 'http://zeus:8787',
      zeusToken: 'tok',
      zeusWebhookSecret: '0123456789abcdef0123456789abcdef',
    };
    await expect(
      runStartupChecks({
        config,
        driver: db,
        zeus: unreachable,
        tasks: new GrowthTaskRepository(db),
        failures: new ChannelFailureRepository(db),
        now: () => now,
      }),
    ).rejects.toThrowError(/zeus ping failed/);
  });
});
