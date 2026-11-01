// Batch CLI — the trigger the orchestrator never had.
//
// serve.ts answers healthz and two inbound webhooks and nothing else; no code
// path in the repository ever invoked the morning batch, the production batch
// or the verification batch on a schedule. Their only callers were tests and
// the offline smoke script, so a deployed growth-agent could receive approvals
// but never act on them. This entry point makes the whole §5 loop drivable
// from cron or a compose scheduler:
//
//   node --experimental-sqlite dist/cli/batch.js daily      --site bayjf.com
//   node --experimental-sqlite dist/cli/batch.js production --site bayjf.com
//   node --experimental-sqlite dist/cli/batch.js verify     --site bayjf.com
//   node --experimental-sqlite dist/cli/batch.js report     --site bayjf.com
//   node --experimental-sqlite dist/cli/batch.js packet     --site bayjf.com
//
// The compliance floor is unchanged: `daily` caps at 1 write + 1 fix and
// submits every candidate to zeus for D2 human review; `production` only
// touches tasks a human already approved into `drafting`, runs the three QA
// gates, and opens a PR — it never merges. Exit codes: 0 ok, 1 runtime
// failure, 2 usage error.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import { loadSiteConfigs, type SiteConfig } from '../config/sites.js';
import { ApiCallRepository } from '../cost/api-call-repository.js';
import { parseCostRates, Pricing } from '../cost/pricing.js';
import { CostRecorder } from '../cost/recorder.js';
import { createGscReadonlyProvider } from '../connector/gsc/registry.js';
import { createAdsReadonlyProvider } from '../connector/ads/registry.js';
import { GscSnapshotRepository } from '../connector/gsc/snapshot-repository.js';
import { createSerpKeywordProvider } from '../connector/serp/registry.js';
import { createZeusDecisionClient } from '../connector/zeus/registry.js';
import {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
} from '../connector/zeus/webhook-repository.js';
import { createDraftProvider } from '../draft/registry.js';
import { createSitePublisher } from '../publisher/github/registry.js';
import { GithubWebhookRepository } from '../publisher/github/webhook-repository.js';
import { buildDogfoodPacket, writeDogfoodPacket } from '../report/dogfood-packet.js';
import { buildWeeklyReport, writeWeeklyReport } from '../report/weekly.js';
import { DailyScriptRunner } from '../scheduler/daily.js';
import { runProductionSweep } from '../scheduler/production-sweep.js';
import { runVerificationBatch } from '../scheduler/verification.js';
import { migrateUp } from '../storage/migrate.js';
import { openDriver } from '../storage/open.js';
import { GrowthTaskRepository } from '../task/repository.js';
import type { GrowthTask } from '../task/types.js';

const COMMANDS = ['daily', 'production', 'verify', 'report', 'packet'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `usage: batch <${COMMANDS.join('|')}> --site <siteId> [--day YYYY-MM-DD]

  daily       morning batch: GSC + SERP candidates -> zeus D2 human review
  production  approved (drafting) tasks -> QA gates -> open a PR (never merge)
  verify      next-day GSC recheck of merged tasks
  report      write the versioned weekly operating report
  packet      write the 30-day dogfood data packet

  --site      site config id from config/sites/*.json (or GA_SITE_ID)
  --day       UTC run date, YYYY-MM-DD (default: today)
`;

const here = dirname(fileURLToPath(import.meta.url));
// dist/cli/batch.js -> repo root is two levels up (see storage/migrate.ts).
const defaultRepoRoot = join(here, '..', '..');

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function parseDay(raw: string | undefined): Date {
  if (raw === undefined) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`--day must be YYYY-MM-DD, got "${raw}"`);
  }
  const day = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) {
    throw new Error(`--day is not a real calendar date: "${raw}"`);
  }
  return day;
}

function selectSite(sites: SiteConfig[], requested: string | undefined): SiteConfig {
  if (requested === undefined) {
    if (sites.length === 1) return sites[0] as SiteConfig;
    const ids = sites.map(site => site.id).join(', ');
    throw new Error(`--site is required when more than one site is configured (available: ${ids})`);
  }
  const site = sites.find(candidate => candidate.id === requested);
  if (site === undefined) {
    const ids = sites.map(candidate => candidate.id).join(', ');
    throw new Error(`unknown site "${requested}" (available: ${ids})`);
  }
  return site;
}

/** GSC property origin, used to turn a draft slug into an absolute page URL. */
function siteOrigin(site: SiteConfig): string {
  return new URL(site.gsc.siteUrl).origin;
}

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const argv = process.argv.slice(2);
  const command = argv[0] as Command | undefined;
  if (command === undefined || !COMMANDS.includes(command)) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const repoRoot = process.env.GA_REPO_ROOT ?? defaultRepoRoot;
  const sites = loadSiteConfigs(join(repoRoot, 'config', 'sites'));
  const site = selectSite(sites, flag(argv, '--site') ?? process.env.GA_SITE_ID);
  const day = parseDay(flag(argv, '--day'));

  const config = loadConfig();
  const driver = await openDriver(config);
  try {
    // Idempotent, same as the HTTP server boot.
    await migrateUp(driver);

    const tasks = new GrowthTaskRepository(driver);
    const snapshots = new GscSnapshotRepository(driver);
    const apiCalls = new ApiCallRepository(driver);
    const zeusDeliveries = new WebhookDeliveryRepository(driver);
    const githubDeliveries = new GithubWebhookRepository(driver);
    const failures = new ChannelFailureRepository(driver);
    const recorder = new CostRecorder(
      apiCalls,
      new Pricing(parseCostRates(config.costRates)),
      () => day.toISOString(),
    );

    const gsc = createGscReadonlyProvider(config);
    const ads = createAdsReadonlyProvider(config);
    const serp = createSerpKeywordProvider(config);
    const zeus = createZeusDecisionClient(config);
    const publisher = createSitePublisher(config);
    const drafts = createDraftProvider(config, recorder);
    const origin = siteOrigin(site);

    switch (command) {
      case 'daily': {
        const runner = new DailyScriptRunner({
          siteId: site.id,
          domain: new URL(site.gsc.siteUrl).hostname,
          gsc,
          snapshots,
          serp,
          zeus,
          tasks,
          recorder,
          watchQueries: site.watchQueries,
          keywordSeeds: site.keywordSeeds,
          now: () => day,
        });
        const run = await runner.run(day);
        if (!run.ran) {
          console.log(`daily: skipped (${run.reason ?? 'unknown'})`);
          break;
        }
        for (const item of run.submitted) {
          console.log(`daily: submitted ${item.kind} ${item.taskId} decision=${item.decisionId} query="${item.query}"`);
        }
        console.log(
          `daily: deferred ${run.deferredWrites.length} write / ${run.deferredFixes.length} fix candidate(s)`,
        );
        break;
      }

      case 'production': {
        const sweep = await runProductionSweep({
          tasks,
          snapshots,
          serp,
          publisher,
          drafts,
          recorder,
          siteId: site.id,
          repoFullName: `${site.github.owner}/${site.github.repo}`,
          siteOrigin: origin,
          now: () => day,
        });
        for (const item of sweep.items) {
          const detail =
            item.outcome === 'pr_opened' && item.prRef !== undefined
              ? `pr=${item.prRef.url}`
              : (item.reason ?? '');
          console.log(`production: ${item.taskId} ${item.outcome} ${detail}`.trimEnd());
        }
        if (sweep.items.length === 0) {
          console.log('production: no task is awaiting a draft');
        }
        break;
      }

      case 'verify': {
        const result = await runVerificationBatch(
          {
            tasks,
            gsc,
            // Fix tasks recheck the page they repaired; write tasks recheck the
            // page the PR published. Both come from the migration-007 context.
            resolveTargetUrl: (task: GrowthTask) => task.context?.targetUrl ?? task.context?.publishedUrl,
            now: () => day,
          },
          day,
        );
        for (const item of result.checked) {
          console.log(`verify: ${item.taskId} ${item.outcome}`);
        }
        for (const item of result.skipped) {
          console.log(`verify: ${item.taskId} skipped (${item.reason})`);
        }
        break;
      }

      case 'report': {
        const weekly = await buildWeeklyReport(
          {
            tasks,
            apiCalls,
            snapshots,
            zeusDeliveries,
            githubDeliveries,
            channelFailures: failures,
            reportDir: config.reportDir,
            siteId: site.id,
            ads,
            adsRecorder: recorder,
          },
          day,
        );
        console.log(`report: ${writeWeeklyReport(config.reportDir, weekly)}`);
        break;
      }

      case 'packet': {
        const packet = await buildDogfoodPacket(
          {
            tasks,
            apiCalls,
            zeusDeliveries,
            githubDeliveries,
            channelFailures: failures,
            reportDir: config.reportDir,
          },
          day,
          30,
        );
        console.log(`packet: ${writeDogfoodPacket({ reportDir: config.reportDir }, packet)}`);
        break;
      }
    }
  } finally {
    await driver.close();
  }
}

main().catch((err: unknown) => {
  console.error(`batch: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
