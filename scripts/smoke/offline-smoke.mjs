// End-to-end offline smoke (T-H2). Exercises the full dogfood pipeline in
// one real Node process against the built dist/ output, with zero external
// network: sqlite temp DB, offline connectors / fake publisher, signed
// inbound zeus and GitHub webhooks, verification, weekly report and the
// 30-day dogfood packet. Exits non-zero on any assertion failure.
//
// Run via scripts/dogfood-smoke.sh (builds first); do not run against a
// production data directory.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

import { SqliteDriver } from '../../dist/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../../dist/storage/migrate.js';
import { GrowthTaskRepository } from '../../dist/task/repository.js';
import { GscSnapshotRepository } from '../../dist/connector/gsc/snapshot-repository.js';
import { ApiCallRepository } from '../../dist/cost/api-call-repository.js';
import { Pricing } from '../../dist/cost/pricing.js';
import { CostRecorder } from '../../dist/cost/recorder.js';
import { OfflineZeusClient } from '../../dist/connector/zeus/offline.js';
import { FakeSitePublisher } from '../../dist/publisher/fake.js';
import { MockLoomClient } from '../../dist/connector/loom/mock.js';
import { DailyScriptRunner } from '../../dist/scheduler/daily.js';
import { runProductionBatch } from '../../dist/scheduler/production.js';
import { runVerificationBatch } from '../../dist/scheduler/verification.js';
import { buildWeeklyReport, writeWeeklyReport } from '../../dist/report/weekly.js';
import { buildDogfoodPacket, writeDogfoodPacket } from '../../dist/report/dogfood-packet.js';
import { createZeusWebhookApp } from '../../dist/api/webhooks/zeus.js';
import { signZeusBody } from '../../dist/connector/zeus/inbound.js';
import { createGithubWebhookApp } from '../../dist/api/webhooks/github.js';
import { signGithubBody } from '../../dist/publisher/github/inbound.js';
import {
  WebhookDeliveryRepository,
  ChannelFailureRepository,
} from '../../dist/connector/zeus/webhook-repository.js';
import { GithubWebhookRepository } from '../../dist/publisher/github/webhook-repository.js';
import { validateSiteConfig } from '../../dist/config/sites.js';

const failures_ = [];
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name} ${detail}`);
    failures_.push(name);
  }
}

const root = mkdtempSync(join(tmpdir(), 'growth-agent-smoke-'));
const reportDir = join(root, 'reports');
const tokenDir = join(root, 'tokens');
const dbPath = join(root, 'smoke.db');

const fixed = new Date('2026-09-21T06:00:00.000Z'); // Monday
const clock = { now: () => new Date(fixed) };
const at = (days, hours = 0) => new Date(fixed.getTime() + days * 86400_000 + hours * 3600_000);

const site = validateSiteConfig(
  JSON.parse(readFileSync(join(process.cwd(), 'config/sites/bayjf-com.json'), 'utf8')),
  'bayjf-com.json',
);

const driver = new SqliteDriver(dbPath);
await migrateUp(driver);
const tasks = new GrowthTaskRepository(driver);
const snapshots = new GscSnapshotRepository(driver);
const apiCalls = new ApiCallRepository(driver);
const zeusDeliveries = new WebhookDeliveryRepository(driver);
const githubDeliveries = new GithubWebhookRepository(driver);
const channelFailures = new ChannelFailureRepository(driver);
const recorder = new CostRecorder(apiCalls, new Pricing({ microsPerUnit: {} }), () => at(0, 1).toISOString());
const zeus = new OfflineZeusClient();
const publisher = new FakeSitePublisher('github');
const loom = new MockLoomClient();

const SECRET = 'smoke-secret-1234567890';

// --- stub GSC: fix page deteriorates daily, then recovers after the PR ---
const FIX_PAGE = 'https://bayjf.com/guides/legacy-guide';
const gsc = {
  name: 'stub',
  mode: 'off',
  async listSites() {
    return [{ siteUrl: site.gsc.siteUrl, permissionLevel: 'siteOwner' }];
  },
  async queryAnalytics({ endDate, dimensions }) {
    if (!dimensions.includes('page')) return [];
    if (endDate >= '2026-09-23') return [{ keys: [FIX_PAGE], clicks: 30, impressions: 200, ctr: 0.15, position: 10 }];
    if (endDate >= '2026-09-22') return [{ keys: [FIX_PAGE], clicks: 5, impressions: 120, ctr: 0.04, position: 19 }];
    if (endDate === '2026-09-20') return [{ keys: [FIX_PAGE], clicks: 4, impressions: 80, ctr: 0.05, position: 20 }];
    return [{ keys: [FIX_PAGE], clicks: 40, impressions: 100, ctr: 0.4, position: 12 }];
  },
};

// --- stub SERP: one clear informational write seed, no own top-10 result ---
const WRITE_QUERY = 'self hosted growth agent';
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
    return queries.map(query => ({
      query,
      position: null,
      url: null,
    }));
  },
};

// --- 1. daily script: candidates + zeus submission (signaled -> deciding) ---
console.log('1) daily batch');
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
  now: clock.now,
});
const run = await daily.run(fixed);
check('daily ran', run.ran === true, JSON.stringify(run));
check('submitted 1 write + 1 fix (daily cap)', run.submitted.length === 2, JSON.stringify(run.submitted));
const writeTask = run.submitted.find(s => s.kind === 'write');
const fixTask = run.submitted.find(s => s.kind === 'fix');
check('one write and one fix', writeTask !== undefined && fixTask !== undefined);

// --- 2. zeus human approval via signed inbound webhook -> drafting ---
console.log('2) zeus approval webhooks');
async function postZeusEvent(decisionId, type, when) {
  const body = JSON.stringify({
    type, decisionId, at: when.toISOString(), domain: 'growth-agent', intent: 'growth',
    grade: 'D2', mode: 'human', status: 'decided', ruleId: 'd2-org', outcome: 'approved',
    // Contract fix: inbound.ts requires a positive slaHours on approved events
    // (mirrors the offline D2 rule in connector/zeus/offline.ts).
    slaHours: 24,
  });
  const app = createZeusWebhookApp({
    secret: SECRET,
    // H4 made the transition + delivery ledger one atomic transaction, so the
    // handler hard-requires a StorageDriver — without it every approved event 500s.
    driver,
    tasks, deliveries: zeusDeliveries, failures: channelFailures,
    now: () => when.toISOString(),
  });
  const res = await app.request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zeus-delivery-id': `${decisionId}:${type}:${when.toISOString()}`,
      'x-zeus-signature': signZeusBody(SECRET, body),
    },
    body,
  });
  return res;
}
for (const s of [writeTask, fixTask]) {
  const res = await postZeusEvent(s.decisionId, 'approved', at(0, 1));
  check(`approved webhook 200 (${s.kind})`, res.status === 200, `status=${res.status}`);
  const dup = await postZeusEvent(s.decisionId, 'approved', at(0, 1));
  const dupBody = await dup.json();
  check(`duplicate delivery idempotent (${s.kind})`, dup.status === 200 && dupBody.duplicate === true);
}
check('both tasks drafting', (await tasks.get(writeTask.taskId)).status === 'drafting'
  && (await tasks.get(fixTask.taskId)).status === 'drafting');

// --- 3. production: loom draft for write, fix draft for fix -> pr_opened ---
console.log('3) production batches (QA gates + open PR, never merge)');
const writeRef = await loom.submitTopicDraft({
  taskId: writeTask.taskId, finalId: 'fcw_smoke_write', query: WRITE_QUERY,
  angle: 'guide', siteId: site.id, evidenceSignalIds: [],
});
const writeContent = await loom.getContent(writeRef.contentId);
check('loom mock returned reviewable content',
  writeContent.status === 'review' && typeof writeContent.body === 'string' && writeContent.body.length > 0);
const drafts = {
  write: {
    taskType: 'write',
    query: WRITE_QUERY,
    slug: 'guides/self-hosted-growth-agent',
    title: 'Self-hosted growth agent: a complete guide',
    paragraphs: [
      'A self-hosted growth agent runs the daily keyword research, drafting and pull-request pipeline on your own infrastructure, using API keys you control.',
      'The first section explains why bring-your-own-key deployment matters for cost: every Search Console, SERP and language model call is billed to your own accounts and recorded in a local cost ledger.',
      'Next, the daily cadence is fixed: one new-content task and one repair task are selected each morning, each submitted to a human approval decision before any draft is written.',
      'The approval gate keeps the human reviewer in control: rejected decisions never become pull requests, and the bot can open requests but never merge them.',
      'Finally, the operating runbook covers sealed OAuth credentials, offline fixture modes for testing, and the 30-day dogfood packet used to measure whether the pipeline earned its keep.',
    ],
  },
  fix: {
    taskType: 'fix',
    query: 'legacy guide',
    slug: 'guides/legacy-guide',
    title: 'Legacy guide (refreshed)',
    paragraphs: [
      'The refreshed legacy guide replaces the outdated setup steps with the current command sequence and verified configuration values.',
      'In our recheck the repaired page moved from position 20 to position 10 and impressions recovered from 80 to 200 over the verification window, so the concrete before-and-after metrics are documented here.',
      'Broken links were removed, and the troubleshooting section now covers the credential presence and webhook signature failures observed during the repair review.',
      'Two new worked examples show how the daily quota of one write and one repair is enforced, and how deferred candidates roll forward to the next run.',
    ],
  },
};
const prRefs = {};
for (const [kind, t] of [['write', writeTask], ['fix', fixTask]]) {
  const out = await runProductionBatch(
    { tasks, publisher, recorder, now: () => at(0, 2).toISOString() },
    {
      taskId: t.taskId,
      draft: drafts[kind],
      serp: await serp.serp(t.query),
      gscPages: [{ url: FIX_PAGE, title: 'Legacy guide', position: 20, impressions: 80, clicks: 4 }],
      existingOpenChanges: [],
      publishedContent: [],
      keywordVolume: kind === 'write' ? 120 : undefined,
      changeSummary: kind === 'write' ? 'New guide' : 'Refresh deteriorated page',
      repoFullName: `${site.github.owner}/${site.github.repo}`,
    },
  );
  check(`QA passed and PR opened (${kind})`, out.action === 'pr_opened' && out.prRef !== undefined, out.action);
  prRefs[kind] = out.prRef;
}

// --- 4. GitHub merged webhook (signed) -> merged -> verifying ---
console.log('4) github merge webhooks');
async function postGithub(pr, action, merged, when, sha) {
  const body = JSON.stringify({
    action,
    pull_request: {
      number: pr.number,
      html_url: pr.url,
      state: action === 'closed' ? 'closed' : 'open',
      merged,
      head: { ref: pr.branch, sha },
      base: { ref: site.github.baseBranch },
    },
    repository: { full_name: `${site.github.owner}/${site.github.repo}` },
  });
  const app = createGithubWebhookApp({
    secret: SECRET,
    tasks, deliveries: githubDeliveries, failures: channelFailures,
    now: () => when.toISOString(),
  });
  const res = await app.request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': `gh-${pr.number}-${action}-${merged ? 'm' : 'u'}`,
      'x-hub-signature-256': signGithubBody(SECRET, body),
    },
    body,
  });
  return res;
}
// GitHub delivers 'opened' first -> pr_opened moves to awaiting_merge.
for (const [kind, t] of [['write', writeTask], ['fix', fixTask]]) {
  const opened = await postGithub(prRefs[kind], 'opened', false, at(1, 7), `sha-${kind}-open`);
  check(`opened webhook -> awaiting_merge (${kind})`,
    opened.status === 200 && (await tasks.get(t.taskId)).status === 'awaiting_merge', `status=${opened.status}`);
}
// Write PR is closed without merge -> cancelled.
const r1 = await postGithub(prRefs.write, 'closed', false, at(1, 8), 'sha-write-close');
check('write PR closed unmerged -> cancelled',
  r1.status === 200 && (await tasks.get(writeTask.taskId)).status === 'cancelled', `status=${r1.status}`);
// Fix PR merges -> merged -> verifying.
const r2 = await postGithub(prRefs.fix, 'closed', true, at(1, 8), 'sha-fix-merge');
check('fix PR merged -> verifying',
  r2.status === 200 && (await tasks.get(fixTask.taskId)).status === 'verifying', `status=${r2.status}`);

// --- 5. verification: baseline then improved position -> done/verified ---
console.log('5) verification batches');
const verifyDeps = {
  tasks,
  gsc,
  resolveTargetUrl: (t) => (t.id === fixTask.taskId ? FIX_PAGE : undefined),
  now: () => new Date(),
};
const first = await runVerificationBatch(verifyDeps, at(2, 8));
check('first check establishes baseline (pending)',
  first.checked[0]?.outcome === 'pending', JSON.stringify(first));
const second = await runVerificationBatch(verifyDeps, at(3, 8));
check('second check gains >=3 positions -> done/verified',
  second.checked[0]?.outcome === 'verified', JSON.stringify(second));
const fixedTask = await tasks.get(fixTask.taskId);
check('fix task done/verified',
  fixedTask.status === 'done' && fixedTask.verifyResult?.outcome === 'verified',
  fixedTask.status);

// --- 6. weekly report + 30-day dogfood packet ---
console.log('6) reports');
const weekly = await buildWeeklyReport({
  tasks, apiCalls, snapshots,
  zeusDeliveries, githubDeliveries, channelFailures,
  reportDir, siteId: site.id,
}, at(6));
const weeklyPath = writeWeeklyReport(reportDir, weekly);
check('weekly report written', weeklyPath.endsWith('.md'), weeklyPath);

const packet = await buildDogfoodPacket(
  { tasks, apiCalls, zeusDeliveries, githubDeliveries, channelFailures, reportDir },
  at(3, 8), 30,
);
const packetPath = writeDogfoodPacket({ reportDir }, packet);
check('dogfood packet written', packetPath.endsWith('.md'), packetPath);
check('api costs recorded', (await apiCalls.list(at(-30).toISOString(), at(4).toISOString())).length > 0);
check('no unauthorized merges / GSC writes', packet.indicators[4].met === true);

// --- 7. bad signature rejected ---
const bad = await createZeusWebhookApp({
  secret: SECRET, tasks, deliveries: zeusDeliveries, failures: channelFailures, now: () => new Date().toISOString(),
}).request('/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-zeus-delivery-id': 'bad', 'x-zeus-signature': 'sha256=deadbeef' },
  body: JSON.stringify({ type: 'approved', decisionId: 'x', at: new Date().toISOString() }),
});
check('bad signature -> 401', bad.status === 401, `status=${bad.status}`);

await driver.close();
rmSync(root, { recursive: true, force: true });

if (failures_.length > 0) {
  console.error(`\nSMOKE FAILED: ${failures_.length} assertion(s): ${failures_.join(', ')}`);
  process.exit(1);
}
console.log('\nSMOKE OK: full offline pipeline (daily -> human review -> QA -> PR -> merge -> verify -> reports) passed');
