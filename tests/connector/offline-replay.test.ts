// Zero-credential default mode end-to-end (Tier0 ⑤ regression): with
// GA_GSC_MODE / GA_SERP_MODE unset the registries select the offline fixture
// providers, and the replay must honour the input dimensions (seed, query,
// site, date window) so the daily pipeline actually produces candidates.
// Before the fix the replay ignored the inputs: every query shared one SERP
// morphology (intent gate discarded all writes) and both GSC windows
// returned identical rows (no fix deltas) — zero candidates every day.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createGscReadonlyProvider } from '../../src/connector/gsc/registry.js';
import { createSerpKeywordProvider } from '../../src/connector/serp/registry.js';
import { GscSnapshotRepository } from '../../src/connector/gsc/snapshot-repository.js';
import { OfflineZeusClient } from '../../src/connector/zeus/offline.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { Pricing } from '../../src/cost/pricing.js';
import { CostRecorder } from '../../src/cost/recorder.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../../src/storage/migrate.js';
import { DailyScriptRunner } from '../../src/scheduler/daily.js';
import { scoreWriteCandidates } from '../../src/scheduler/candidates.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { validateSiteConfig } from '../../src/config/sites.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

// Windows for this day (trailingInclusive): recent 2026-09-28..2026-10-25,
// prior 2026-08-31..2026-09-27 — both covered by gsc-fixture.json dates.
const DAY = new Date('2026-10-26T06:00:00.000Z');

const site = validateSiteConfig(
  JSON.parse(readFileSync(join(repoRoot, 'config/sites/bayjf-com.json'), 'utf8')),
  'bayjf-com.json',
);

let db: SqliteDriver;

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  // Zero-credential default: no GA_GSC_MODE / GA_SERP_MODE overrides.
  delete process.env.GA_GSC_MODE;
  delete process.env.GA_SERP_MODE;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
});

afterAll(async () => {
  delete process.env.GA_REPO_ROOT;
  await db.close();
});

describe('zero-credential default mode replays by input dimensions', () => {
  it('registries select the offline fixture providers by default', () => {
    expect(createGscReadonlyProvider(loadConfig()).name).toBe('gsc-offline');
    expect(createSerpKeywordProvider(loadConfig()).name).toBe('serp-offline');
  });

  it('gsc replay returns window-specific page rows for the configured site', async () => {
    const gsc = createGscReadonlyProvider(loadConfig());
    const recent = await gsc.queryAnalytics({
      siteUrl: site.id,
      startDate: '2026-09-28',
      endDate: '2026-10-25',
      dimensions: ['page'],
    });
    const prior = await gsc.queryAnalytics({
      siteUrl: site.id,
      startDate: '2026-08-31',
      endDate: '2026-09-27',
      dimensions: ['page'],
    });
    expect(recent).not.toEqual(prior);
    expect(recent.map(r => r.keys[0])).toContain('https://bayjf.com/guides/legacy-guide');
    expect(prior.map(r => r.keys[0])).toContain('https://bayjf.com/guides/legacy-guide');
    // Foreign sites and other dimension sets replay nothing (no misaligned
    // rows), and rowLimit applies to the filtered set.
    await expect(
      gsc.queryAnalytics({ siteUrl: 'https://other.example/', startDate: '2026-09-01', endDate: '2026-10-31', dimensions: ['page'] }),
    ).resolves.toEqual([]);
  });

  it('different seeds produce different write candidates from the replay', async () => {
    const serp = createSerpKeywordProvider(loadConfig());
    const ideas = [];
    for (const seed of site.keywordSeeds) {
      ideas.push(...(await serp.keywordIdeas(seed)));
    }
    expect(ideas.length).toBeGreaterThan(0);
    const rankTrack = await serp.rankTrack('bayjf.com', site.watchQueries);
    const serpByQuery = new Map<string, Awaited<ReturnType<typeof serp.serp>>>();
    for (const idea of ideas) {
      serpByQuery.set(idea.keyword, await serp.serp(idea.keyword));
    }
    const writes = scoreWriteCandidates({ ideas, rankTrack, serpByQuery });
    // The informational SERPs pass the intent gate; the commercial
    // ("byok seo automation checklist") and navigational
    // ("astral developer portfolio") morphologies are discarded per query.
    expect(writes.map(w => w.query)).toEqual([
      'byok seo automation',
      'self hosted growth agent',
      'self hosted growth agent setup',
    ]);
  });

  it('daily run submits 1 write + 1 fix from fixture replay alone', async () => {
    const tasks = new GrowthTaskRepository(db);
    const snapshots = new GscSnapshotRepository(db);
    const recorder = new CostRecorder(
      new ApiCallRepository(db),
      new Pricing(),
      () => DAY.toISOString(),
    );
    const runner = new DailyScriptRunner({
      siteId: site.id,
      domain: 'bayjf.com',
      gsc: createGscReadonlyProvider(loadConfig()),
      snapshots,
      serp: createSerpKeywordProvider(loadConfig()),
      zeus: new OfflineZeusClient(),
      tasks,
      recorder,
      watchQueries: site.watchQueries,
      keywordSeeds: site.keywordSeeds,
      now: () => DAY,
    });
    const result = await runner.run(DAY);
    expect(result.ran).toBe(true);
    expect(result.submitted).toHaveLength(2);
    expect(result.submitted.map(s => s.kind).sort()).toEqual(['fix', 'write']);
    expect(result.submitted.find(s => s.kind === 'write')?.query).toBe('byok seo automation');
    expect(result.submitted.find(s => s.kind === 'fix')?.query).toBe(
      'https://bayjf.com/guides/legacy-guide',
    );
    expect(result.deferredWrites.map(w => w.query)).toEqual([
      'self hosted growth agent',
      'self hosted growth agent setup',
    ]);
  });
});
