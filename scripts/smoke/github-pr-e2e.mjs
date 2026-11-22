// Real-GitHub PR smoke for the production leg (T-D2/D3 closure evidence).
//
// The normal offline smoke proves the whole loop against FakeSitePublisher.
// This one keeps every other component offline/deterministic but swaps in the
// real GitHubPublisher, so the REST calls, branch creation, Contents API write,
// PR dedupe and task state write are exercised against a throwaway repository.
//
// Safety:
//   - refuses to run without GA_GITHUB_TOKEN;
//   - defaults to bayernjf/git-e2e-test and rejects any other repo unless
//     GA_E2E_ALLOW_ANY_REPO=1 is set;
//   - never merges; it closes the PR and deletes the task branch after the
//     assertions unless --keep is passed;
//   - writes only one Markdown file under growth-agent-e2e/.
//
// Usage:
//   node scripts/smoke/github-pr-e2e.mjs [--keep]
//
// Build first (npm run build); the script imports dist/.

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteDriver } from '../../dist/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../../dist/storage/migrate.js';
import { GrowthTaskRepository } from '../../dist/task/repository.js';
import { GscSnapshotRepository } from '../../dist/connector/gsc/snapshot-repository.js';
import { ApiCallRepository } from '../../dist/cost/api-call-repository.js';
import { Pricing } from '../../dist/cost/pricing.js';
import { CostRecorder } from '../../dist/cost/recorder.js';
import { OfflineZeusClient } from '../../dist/connector/zeus/offline.js';
import { DailyScriptRunner } from '../../dist/scheduler/daily.js';
import { runProductionSweep } from '../../dist/scheduler/production-sweep.js';
import { createDraftProvider } from '../../dist/draft/registry.js';
import { createSitePublisher } from '../../dist/publisher/github/registry.js';
import { branchForTask } from '../../dist/publisher/github/http.js';
import { createZeusWebhookApp } from '../../dist/api/webhooks/zeus.js';
import { signZeusBody } from '../../dist/connector/zeus/inbound.js';
import {
  WebhookDeliveryRepository,
  ChannelFailureRepository,
} from '../../dist/connector/zeus/webhook-repository.js';
import { validateSiteConfig } from '../../dist/config/sites.js';

const keep = process.argv.includes('--keep');
const token = process.env.GA_GITHUB_TOKEN;
if (!token) {
  console.error('FAIL: GA_GITHUB_TOKEN is required (load .env first)');
  process.exit(2);
}

const repoFullName = process.env.GA_E2E_GITHUB_REPO ?? 'bayernjf/git-e2e-test';
if (repoFullName !== 'bayernjf/git-e2e-test' && process.env.GA_E2E_ALLOW_ANY_REPO !== '1') {
  console.error(
    `FAIL: refusing to open a real PR in "${repoFullName}" without GA_E2E_ALLOW_ANY_REPO=1`,
  );
  process.exit(2);
}
const [owner, repo] = repoFullName.split('/');
if (!owner || !repo) {
  console.error(`FAIL: GA_E2E_GITHUB_REPO must be owner/repo, got "${repoFullName}"`);
  process.exit(2);
}

const failures = [];
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.error(`  FAIL ${name} ${detail}`);
    failures.push(name);
  }
}

async function github(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text === '' ? undefined : JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

const root = mkdtempSync(join(tmpdir(), 'growth-agent-gh-e2e-'));
const inboxDir = join(root, 'drafts');
const dbPath = join(root, 'e2e.db');
mkdirSync(inboxDir, { recursive: true });

const fixed = new Date('2026-09-21T06:00:00.000Z');
const at = (days, hours = 0) =>
  new Date(fixed.getTime() + days * 86400_000 + hours * 3600_000);

const baseSite = validateSiteConfig(
  JSON.parse(
    readFileSync(new URL('../../config/sites/bayjf-com.json', import.meta.url), 'utf8'),
  ),
  'bayjf-com.json',
);
const site = {
  ...baseSite,
  github: { owner, repo, baseBranch: 'main' },
};

const driver = new SqliteDriver(dbPath);
await migrateUp(driver);
const tasks = new GrowthTaskRepository(driver);
const snapshots = new GscSnapshotRepository(driver);
const apiCalls = new ApiCallRepository(driver);
const zeusDeliveries = new WebhookDeliveryRepository(driver);
const channelFailures = new ChannelFailureRepository(driver);
const recorder = new CostRecorder(apiCalls, new Pricing({ microsPerUnit: {} }), () => at(0, 1).toISOString());
const zeus = new OfflineZeusClient();

const FIX_PAGE = 'https://bayjf.com/guides/legacy-guide';
const gsc = {
  name: 'stub',
  mode: 'off',
  async listSites() {
    return [{ siteUrl: site.gsc.siteUrl, permissionLevel: 'siteOwner' }];
  },
  async queryAnalytics({ endDate, dimensions }) {
    if (!dimensions.includes('page')) return [];
    if (endDate >= '2026-09-20') {
      return [{ keys: [FIX_PAGE], clicks: 30, impressions: 200, ctr: 0.15, position: 10 }];
    }
    return [{ keys: [FIX_PAGE], clicks: 40, impressions: 900, ctr: 0.04, position: 6 }];
  },
};
const serp = {
  name: 'stub',
  mode: 'off',
  async keywordIdeas(seed) {
    return [{ keyword: seed, volume: 120, competition: 0.3 }];
  },
  async serp() {
    return [
      { url: 'https://example.com/guide', title: 'What is a self-hosted growth agent? Complete guide', position: 1, description: 'A practical guide explaining the self-hosted growth agent approach.' },
      { url: 'https://news.example.org/agents', title: 'Self-hosted growth agents explained', position: 2, description: 'How BYOK growth agents work and why teams run them.' },
      { url: 'https://blog.example.net/byok', title: 'Guide to BYOK SEO automation', position: 3, description: 'Run your own SEO agent with your own API keys.' },
    ];
  },
  async rankTrack(domain, queries) {
    return queries.map(query => ({ query, position: null, url: null }));
  },
};

let taskId;
let prNumber;
let prUrl;
let cleanup = { prClosed: false, branchDeleted: false };

try {
  console.log(`1) daily batch against offline fixtures (repo target ${repoFullName})`);
  const daily = new DailyScriptRunner({
    siteId: site.id,
    domain: 'bayjf.com',
    gsc,
    snapshots,
    serp,
    zeus,
    tasks,
    recorder,
    watchQueries: site.watchQueries,
    keywordSeeds: site.keywordSeeds,
    now: () => fixed,
  });
  const run = await daily.run(fixed);
  check('daily ran', run.ran === true, JSON.stringify(run));
  check('daily produced 1 write + 1 fix', run.submitted.length === 2, JSON.stringify(run.submitted));

  const write = run.submitted.find(s => s.kind === 'write');
  const fix = run.submitted.find(s => s.kind === 'fix');
  if (!write || !fix) throw new Error('daily did not produce both candidate kinds');
  taskId = write.taskId;

  // Keep this smoke to a single real PR: the fix candidate is declined.
  await tasks.setStatus(fix.taskId, 'rejected', at(0, 1).toISOString());

  console.log('2) human approval through the signed zeus webhook');
  const body = JSON.stringify({
    type: 'approved',
    decisionId: write.decisionId,
    at: at(0, 1).toISOString(),
    domain: 'growth-agent',
    intent: 'growth',
    grade: 'D2',
    mode: 'human',
    status: 'decided',
    ruleId: 'd2-org',
    outcome: 'approved',
    slaHours: 24,
  });
  const app = createZeusWebhookApp({
    secret: 'github-e2e-secret-1234567890',
    driver,
    tasks,
    deliveries: zeusDeliveries,
    failures: channelFailures,
    now: () => at(0, 1).toISOString(),
  });
  const res = await app.request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zeus-delivery-id': `${write.decisionId}:approved:${at(0, 1).toISOString()}`,
      'x-zeus-signature': signZeusBody('github-e2e-secret-1234567890', body),
    },
    body,
  });
  check('approval webhook 200', res.status === 200, `status=${res.status}`);
  check('write task is drafting', (await tasks.get(taskId)).status === 'drafting');

  console.log('3) production sweep with the real GitHub publisher');
  const task = await tasks.get(taskId);
  const query = task.context?.query ?? 'self hosted growth agent';
  writeFileSync(
    join(inboxDir, `${taskId}.json`),
    JSON.stringify({
      slug: `growth-agent-e2e/${taskId}.md`,
      title: 'Self-hosted growth agent: real PR smoke',
      paragraphs: [
        `This file was written by growth-agent task ${taskId} during a real GitHub publisher smoke on ${new Date().toISOString().slice(0, 10)}.`,
        'The production leg runs three QA gates before any network write: intent, dedupe and value. Only a passing draft reaches the Contents API.',
        'The publisher creates a deterministic growth-agent/<taskId> branch, writes the file, and opens a pull request that a human must review and merge.',
        'A second call with the same task id reuses the branch and patches the existing pull request instead of opening a duplicate.',
        'The smoke closes the pull request and deletes the branch afterwards, so the throwaway repository is left clean.',
      ],
      changeSummary: 'Real GitHub PR smoke for the growth-agent production leg',
    }, null, 2),
  );

  const config = { githubMode: 'online', githubToken: token };
  const publisher = createSitePublisher(config, site);
  const drafts = createDraftProvider({ draftMode: 'inbox', draftInboxDir: inboxDir });
  const sweep = await runProductionSweep(
    {
      tasks,
      snapshots,
      serp,
      publisher,
      drafts,
      recorder,
      siteId: site.id,
      repoFullName,
      siteOrigin: 'https://bayjf.com',
      now: () => at(0, 2),
    },
    at(0, 2),
  );
  const item = sweep.items.find(i => i.taskId === taskId);
  check('production sweep opened a PR', item?.outcome === 'pr_opened', JSON.stringify(item));
  if (!item?.prRef) throw new Error('no prRef returned');
  prNumber = item.prRef.number;
  prUrl = item.prRef.url;
  check('task persisted UA snapshot + prRef', (await tasks.get(taskId)).status === 'pr_opened');

  console.log('4) real GitHub assertions');
  const pull = await github('GET', `/repos/${repoFullName}/pulls/${prNumber}`);
  check('PR is open', pull.state === 'open', pull.state);
  check('PR head branch matches task branch',
    pull.head?.ref === branchForTask(taskId), pull.head?.ref);
  check('PR body carries the task id', typeof pull.body === 'string' && pull.body.includes(taskId));

  const again = await publisher.openChange({
    taskId,
    title: 'growth-agent: Self-hosted growth agent: real PR smoke',
    body: 'idempotency probe',
    files: [{
      path: `growth-agent-e2e/${taskId}.md`,
      content: '# idempotency probe\n',
    }],
  });
  check('repeat openChange reuses the same PR', again.number === prNumber,
    `first=${prNumber} second=${again.number}`);

  check('getChangeStatus reports open', await publisher.getChangeStatus(String(prNumber)) === 'open');

  console.log(`   PR #${prNumber}: ${prUrl}`);
  console.log(`   task: ${taskId}`);

  const report = {
    generatedAt: new Date().toISOString(),
    repo: repoFullName,
    taskId,
    prNumber,
    prUrl,
    branch: branchForTask(taskId),
    stateAfterOpen: pull.state,
    idempotentRerun: again.number === prNumber,
    cleanup,
  };
  const outDir = process.env.GA_E2E_REPORT_DIR ?? join(process.cwd(), 'data', 'e2e');
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `github-pr-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  check('report written', true, reportPath);
  console.log(`   report: ${reportPath}`);
} finally {
  if (prNumber !== undefined && !keep) {
    try {
      await github('PATCH', `/repos/${repoFullName}/pulls/${prNumber}`, { state: 'closed' });
      cleanup.prClosed = true;
      console.log(`   cleanup: closed PR #${prNumber}`);
    } catch (err) {
      console.error(`   cleanup: failed to close PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await github('DELETE', `/repos/${repoFullName}/git/refs/heads/${branchForTask(taskId)}`);
      cleanup.branchDeleted = true;
      console.log('   cleanup: deleted task branch');
    } catch (err) {
      console.error(`   cleanup: failed to delete task branch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nOK: real GitHub PR smoke passed');
