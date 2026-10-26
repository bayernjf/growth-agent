import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { applyQaDecision, runQaGates } from '../../src/qa/orchestrator.js';
import type { ContentDraft, GscPageEvidence } from '../../src/qa/types.js';
import type { SerpResult } from '../../src/connector/serp/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

let db: SqliteDriver;
let repo: GrowthTaskRepository;
const now = '2026-10-26T06:00:00.000Z';

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
  repo = new GrowthTaskRepository(db);
});

afterAll(async () => {
  await db.close();
});

const wikiResults: SerpResult[] = Array.from({ length: 10 }, (_, i) => ({
  position: i + 1,
  url: `https://en.wikipedia.org/wiki/Site_audit_${i}`,
  title: `What is a site audit #${i}: how-to guide with examples`,
  description: '',
}));

const transactionalResults: SerpResult[] = Array.from({ length: 10 }, (_, i) => ({
  position: i + 1,
  url: `https://shop${i}.example.com/buy`,
  title: `Buy audit tools #${i} — discount price and checkout deals`,
  description: '',
}));

const goodDraft: ContentDraft = {
  taskType: 'write',
  query: 'site audit checklist',
  slug: '/guides/site-audit-checklist',
  title: 'The Technical Site Audit Checklist',
  paragraphs: [
    'In our 2026 tests of 14 Astro projects, production build times fell by 38 percent.',
    'We measured a local fixture pipeline across 12 repeated runs.',
    'For example, the site-audit checklist caught 9 broken internal anchors.',
    'Our Search Console data covers 28 days and 480 impressions for this query.',
    'According to our logs, manual chunking saved 42 KB on the first load.',
    'A concrete case from bayjf.com: 3 repaired pages moved up 5 positions.',
  ],
};

const boilerplateDraft: ContentDraft = {
  ...goodDraft,
  paragraphs: [
    'Welcome to our website where we offer tailored solutions.',
    'As a leading provider, our team of experts is at your service.',
    "In today's fast-paced world, contact us today for a one-stop solution.",
    'Look no further for the best service from committed professionals.',
  ],
};

const fixPage: GscPageEvidence = {
  url: 'https://bayjf.com/guide/site-audit-checklist',
  title: 'The Technical Site Audit Checklist',
  position: 4.2,
  impressions: 480,
  clicks: 12,
};

async function createDraftingTask(id: string, type: 'write' | 'fix' = 'write') {
  await repo.create({ id, siteId: 'bayjf.com', type, status: 'drafting' }, now);
}

describe('QA orchestrator (§6.3 lifecycle)', () => {
  it('opens the PR when all three gates pass', async () => {
    await createDraftingTask('gt_qa_pass');
    const decision = await runQaGates({
      draft: goodDraft,
      serp: wikiResults,
      gscPages: [],
      keywordVolume: 300,
      existingOpenChanges: [],
      publishedContent: [],
      qaRevisionCount: 0,
    });
    expect(decision.action).toBe('pr_opened');
    expect(decision.qaResult).toEqual({
      intent: true,
      dedupe: true,
      value: true,
      scores: [expect.any(Number), expect.any(Number), expect.any(Number)],
    });
    const changes = await applyQaDecision(repo, 'gt_qa_pass', decision, now);
    expect(changes).toBe(1);
    const stored = await repo.get('gt_qa_pass');
    expect(stored?.status).toBe('pr_opened');
    expect(stored?.qaResult?.intent).toBe(true);
    expect(stored?.qaRevisionCount).toBe(0);
  });

  it('routes the first failure to qa_revision and records the rework counter', async () => {
    await createDraftingTask('gt_qa_fail1');
    const decision = await runQaGates({
      draft: boilerplateDraft,
      serp: transactionalResults,
      gscPages: [],
      keywordVolume: 300,
      existingOpenChanges: [],
      publishedContent: [],
      qaRevisionCount: 0,
    });
    expect(decision.action).toBe('qa_revision');
    expect(decision.nextRevisionCount).toBe(1);
    expect(decision.qaResult.intent).toBe(false);
    expect(decision.qaResult.value).toBe(false);
    expect(decision.qaResult.dedupe).toBe(true);
    await applyQaDecision(repo, 'gt_qa_fail1', decision, now);
    const stored = await repo.get('gt_qa_fail1');
    expect(stored?.status).toBe('qa_revision');
    expect(stored?.qaRevisionCount).toBe(1);
  });

  it('lets a reworked draft pass after one revision (qa_revision to drafting to pr_opened)', async () => {
    const backToDrafting = await repo.setStatus('gt_qa_fail1', 'drafting', now);
    expect(backToDrafting).toBe(1);
    const decision = await runQaGates({
      draft: goodDraft,
      serp: wikiResults,
      gscPages: [],
      keywordVolume: 300,
      existingOpenChanges: [],
      publishedContent: [],
      qaRevisionCount: 1,
    });
    expect(decision.action).toBe('pr_opened');
    await applyQaDecision(repo, 'gt_qa_fail1', decision, now);
    expect((await repo.get('gt_qa_fail1'))?.status).toBe('pr_opened');
  });

  it('fails the task when the reworked draft fails QA a second time (no second revision)', async () => {
    await createDraftingTask('gt_qa_fail2');
    const first = await runQaGates({
      draft: boilerplateDraft,
      serp: transactionalResults,
      gscPages: [],
      keywordVolume: 300,
      existingOpenChanges: [],
      publishedContent: [],
      qaRevisionCount: 0,
    });
    expect(first.action).toBe('qa_revision');
    await applyQaDecision(repo, 'gt_qa_fail2', first, now);
    await repo.setStatus('gt_qa_fail2', 'drafting', now);

    const second = await runQaGates({
      draft: boilerplateDraft,
      serp: transactionalResults,
      gscPages: [],
      keywordVolume: 300,
      existingOpenChanges: [],
      publishedContent: [],
      qaRevisionCount: 1,
    });
    expect(second.action).toBe('failed');
    expect(second.nextRevisionCount).toBe(1);
    await applyQaDecision(repo, 'gt_qa_fail2', second, now);
    const stored = await repo.get('gt_qa_fail2');
    expect(stored?.status).toBe('failed');
    expect(stored?.prRef).toBeUndefined();
  });

  it('passes a fix task end-to-end when the target page has GSC exposure', async () => {
    await createDraftingTask('gt_qa_fix', 'fix');
    const fixDraft: ContentDraft = {
      ...goodDraft,
      taskType: 'fix',
      slug: '/guide/site-audit-checklist',
    };
    const decision = await runQaGates({
      draft: fixDraft,
      serp: transactionalResults,
      gscPages: [fixPage],
      existingOpenChanges: [],
      publishedContent: [],
      qaRevisionCount: 0,
    });
    expect(decision.action).toBe('pr_opened');
    expect(decision.qaResult.dedupe).toBe(true);
    expect(decision.qaResult.value).toBe(true);
  });
});
