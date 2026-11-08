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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import { loadSiteConfigs, type SiteConfig } from '../config/sites.js';
import { ApiCallRepository } from '../cost/api-call-repository.js';
import { parseCostRates, Pricing } from '../cost/pricing.js';
import { CostRecorder } from '../cost/recorder.js';
import { createGscReadonlyProvider } from '../connector/gsc/registry.js';
import { OfflineGscProvider } from '../connector/gsc/offline.js';
import type { GscRow } from '../connector/gsc/types.js';
import type { GscSnapshotRow } from '../connector/gsc/snapshot-repository.js';
import { createAdsReadonlyProvider } from '../connector/ads/registry.js';
import { GscSnapshotRepository } from '../connector/gsc/snapshot-repository.js';
import { createSentimentProvider } from '../connector/sentiment/registry.js';
import { SentimentSnapshotRepository } from '../connector/sentiment/snapshot-repository.js';
import { createSerpKeywordProvider } from '../connector/serp/registry.js';
import { OfflineSerpProvider } from '../connector/serp/offline.js';
import { createZeusDecisionClient } from '../connector/zeus/registry.js';
import {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
} from '../connector/zeus/webhook-repository.js';
import { createDraftProvider } from '../draft/registry.js';
import { createSitePublisher } from '../publisher/github/registry.js';
import { GithubWebhookRepository } from '../publisher/github/webhook-repository.js';
import { buildDogfoodPacket, writeDogfoodPacket } from '../report/dogfood-packet.js';
import { alertStatePath, notifyAlert, type NotifyOptions } from '../report/alert.js';
import {
  appendRunRecord,
  assessCoverage,
  formatCoverage,
  formatHistory,
  readRunLedger,
  runLedgerPath,
  utcDayKey,
  type RunStatus,
} from '../report/run-ledger.js';
import { buildWeeklyReport, writeWeeklyReport } from '../report/weekly.js';
import { DailyScriptRunner } from '../scheduler/daily.js';
import { scoreFixCandidates, scoreWriteCandidates, selectDailyCandidates } from '../scheduler/candidates.js';
import { trailingInclusive } from '../scheduler/dates.js';
import { formatDemoSelection, formatNoCandidates } from '../scheduler/diagnose.js';
import { runProductionSweep } from '../scheduler/production-sweep.js';
import { runVerificationBatch } from '../scheduler/verification.js';
import { migrateUp } from '../storage/migrate.js';
import { openDriver } from '../storage/open.js';
import { GrowthTaskRepository } from '../task/repository.js';
import type { GrowthTask } from '../task/types.js';

const COMMANDS = ['daily', 'production', 'verify', 'report', 'packet', 'demo', 'health', 'history'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `usage: batch <${COMMANDS.join('|')}> --site <siteId> [--day YYYY-MM-DD]

  daily       morning batch: GSC + SERP candidates -> zeus D2 human review
  production  approved (drafting) tasks -> QA gates -> open a PR (never merge)
  verify      next-day GSC recheck of merged tasks
  report      write the versioned weekly operating report
  packet      write the 30-day dogfood data packet
  demo        print fixture candidates for a demo site (no DB writes)
  health      last N complete days must each have a successful daily run
              (--days, default 30; exit 1 when any day is missing)
  history     print the run ledger for the last N calendar days
              (--days, default 7; inspection only, exit 0)

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

function parseDays(raw: string | undefined): number {
  if (raw === undefined) return 30;
  const days = Number.parseInt(raw, 10);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days must be a positive integer, got "${raw}"`);
  }
  return days;
}

/** History defaults to a week: enough to see the cadence, small enough to read. */
function parseHistoryDays(raw: string | undefined): number {
  return raw === undefined ? 7 : parseDays(raw);
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

function snapshotRows(siteId: string, date: string, rows: readonly GscRow[]): GscSnapshotRow[] {
  return rows.map(row => ({
    siteUrl: siteId,
    date,
    dimensionKey: row.keys[0] ?? '',
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position,
  }));
}

/**
 * `batch demo`: run the same scoring functions against the bundled fixture so
 * a zero-credential operator can see what the loop produces. It deliberately
 * bypasses the database, zeus and the site's real connectors — no task is
 * created and nothing is submitted.
 */
async function runDemo(site: SiteConfig, day: Date): Promise<void> {
  const gsc = new OfflineGscProvider();
  const serp = new OfflineSerpProvider();
  const recent = trailingInclusive(day, 28, 1);
  const prior = trailingInclusive(day, 28, 29);
  const recentRows = await gsc.queryAnalytics({
    siteUrl: site.id,
    startDate: recent.start,
    endDate: recent.end,
    dimensions: ['page'],
  });
  const priorRows = await gsc.queryAnalytics({
    siteUrl: site.id,
    startDate: prior.start,
    endDate: prior.end,
    dimensions: ['page'],
  });
  const fixes = scoreFixCandidates(
    snapshotRows(site.id, recent.end, recentRows),
    snapshotRows(site.id, prior.end, priorRows),
  );
  const ideas = (await Promise.all(site.keywordSeeds.map(seed => serp.keywordIdeas(seed)))).flat();
  const serpByQuery = new Map<string, Awaited<ReturnType<typeof serp.serp>>>();
  for (const idea of ideas) {
    serpByQuery.set(idea.keyword, await serp.serp(idea.keyword));
  }
  const rankTrack = await serp.rankTrack(new URL(site.gsc.siteUrl).hostname, site.watchQueries);
  const writes = scoreWriteCandidates({ ideas, rankTrack, serpByQuery });
  const selection = selectDailyCandidates(writes, fixes);
  for (const line of formatDemoSelection(site.id, selection)) {
    console.log(line);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const command = argv[0] as Command | undefined;
  if (command === undefined || !COMMANDS.includes(command)) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const repoRoot = process.env.GA_REPO_ROOT ?? defaultRepoRoot;
  const config = loadConfig();

  // One outbound channel shared by both alarms (2026-11-08 handoff P0).
  // No URL means inert: the exit code stays the only alarm, exactly as before.
  const alertOptions: NotifyOptions = {
    ...(config.alertWebhookUrl === undefined ? {} : { webhookUrl: config.alertWebhookUrl }),
    ...(config.alertWebhookToken === undefined ? {} : { token: config.alertWebhookToken }),
    format: config.alertWebhookFormat ?? 'generic',
    statePath: alertStatePath(config.reportDir),
    cooldownMs: (config.alertCooldownMinutes ?? 360) * 60_000,
  };

  /** Shared logging: a delivery failure is reported, never escalated. */
  const reportAlert = (outcome: Awaited<ReturnType<typeof notifyAlert>>): void => {
    if (outcome.status === 'sent') {
      process.stderr.write(`batch: alert sent (${outcome.attempts} attempt(s))\n`);
    } else if (outcome.status === 'failed') {
      process.stderr.write(
        `batch: alert failed after ${outcome.attempts} attempt(s): ${outcome.error}\n`,
      );
    }
  };

  // health is a pure ledger reader: no DB, no site config required, so a
  // missing site file can never mask a coverage gap. Exit 1 on any gap so
  // cron surfaces a missed day the next morning.
  if (command === 'health') {
    const ledgerPath = runLedgerPath(config.reportDir);
    const siteFilter = flag(argv, '--site') ?? process.env.GA_SITE_ID;
    const report = assessCoverage(readRunLedger(ledgerPath), {
      days: parseDays(flag(argv, '--days')),
      // The morning batch is the heartbeat: production/verify only derive from
      // tasks it created, so they must not mask a day `daily` never completed.
      command: 'daily',
      ...(siteFilter === undefined ? {} : { site: siteFilter }),
    });
    console.log(formatCoverage(report));
    if (!report.healthy) {
      process.exitCode = 1;
      const kind = report.totalRecords === 0 ? 'coverage_empty' : 'coverage_gap';
      // Day-scoped dedupe key: one missing day sends one message, not one per tick.
      reportAlert(
        await notifyAlert(
          {
            kind,
            title: `growth-agent health ${kind === 'coverage_empty' ? 'EMPTY' : 'GAP'}`,
            detail: formatCoverage(report),
            dedupeKey: `${kind}:${report.checkedTo}`,
          },
          alertOptions,
        ),
      );
    }
    return;
  }

  // history is also a pure ledger reader: it replays what ran so an operator
  // can see the actual cadence instead of trusting the cron config.
  if (command === 'history') {
    const ledgerPath = runLedgerPath(config.reportDir);
    console.log(
      formatHistory(readRunLedger(ledgerPath), {
        days: parseHistoryDays(flag(argv, '--days')),
      }),
    );
    return;
  }

  const sites = loadSiteConfigs(join(repoRoot, 'config', 'sites'));
  const site = selectSite(sites, flag(argv, '--site') ?? process.env.GA_SITE_ID);
  const day = parseDay(flag(argv, '--day'));

  // demo is the zero-credential preview: fixtures only, no DB, no zeus.
  if (command === 'demo') {
    await runDemo(site, day);
    return;
  }

  // Run ledger (#10): every invocation appends one line so `health` can prove
  // the loop actually ran. A ledger write failure is a warning, never a
  // business failure.
  const startedAt = new Date();
  const ledgerPath = runLedgerPath(config.reportDir);
  let runStatus: RunStatus = 'ok';
  let runReason: string | undefined;
  let runSummary: string | undefined;

  try {
    const driver = await openDriver(config);
    try {
      // Idempotent, same as the HTTP server boot.
      await migrateUp(driver);

    const tasks = new GrowthTaskRepository(driver);
    const snapshots = new GscSnapshotRepository(driver);
    const sentimentSnapshots = new SentimentSnapshotRepository(driver);
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
    // F-05: the publisher is bound to the selected site's repository; there is
    // no deployment-wide owner/repo default any more.
    const publisher = createSitePublisher(config, site);
    const drafts = createDraftProvider(config, recorder);
    // Sentiment was merged library-only (OP-40/41/42) and never wired into the
    // deploy loop (2026-11-02 review F-04); daily snapshots/alerts and the
    // weekly section only exist once the provider and its repo are injected.
    const sentiment = createSentimentProvider(config);
    const origin = siteOrigin(site);

    switch (command) {
      case 'daily': {
        const runner = new DailyScriptRunner({
          siteId: site.id,
          domain: new URL(site.gsc.siteUrl).hostname,
          gsc,
          snapshots,
          sentiment,
          sentimentSnapshots,
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
          runStatus = 'skipped';
          runReason = run.reason ?? 'unknown';
          console.log(`daily: skipped (${run.reason ?? 'unknown'})`);
          break;
        }
        for (const item of run.submitted) {
          console.log(`daily: submitted ${item.kind} ${item.taskId} decision=${item.decisionId} query="${item.query}"`);
        }
        console.log(
          `daily: deferred ${run.deferredWrites.length} write / ${run.deferredFixes.length} fix candidate(s)`,
        );
        if (
          run.submitted.length === 0
          && run.submitFailures.length === 0
          && run.deferredWrites.length === 0
          && run.deferredFixes.length === 0
        ) {
          for (const line of formatNoCandidates(config, site.id)) {
            console.log(line);
          }
        }
        runSummary = `submitted=${run.submitted.length} deferredWrites=${run.deferredWrites.length} deferredFixes=${run.deferredFixes.length} submitFailures=${run.submitFailures.length}`;
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
        const prs = sweep.items.filter(item => item.outcome === 'pr_opened').length;
        runSummary = `items=${sweep.items.length} prOpened=${prs}`;
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
        runSummary = `checked=${result.checked.length} skipped=${result.skipped.length}`;
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
            sentiment: sentimentSnapshots,
          },
          day,
        );
        const reportPath = writeWeeklyReport(config.reportDir, weekly);
        console.log(`report: ${reportPath}`);
        runSummary = `report=${basename(reportPath)}`;
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
        const packetPath = writeDogfoodPacket({ reportDir: config.reportDir }, packet);
        console.log(`packet: ${packetPath}`);
        runSummary = `packet=${basename(packetPath)}`;
        break;
      }
    }
    } finally {
      await driver.close();
    }
  } catch (err) {
    runStatus = 'failed';
    runReason = err instanceof Error ? err.message : String(err);
    // Alert, log, then rethrow: the exit code remains the alarm of record and
    // a failed webhook must not replace the original error.
    reportAlert(
      await notifyAlert(
        {
          kind: 'run_failed',
          title: `growth-agent ${command} failed`,
          detail: `${runReason}\n(site ${site.id}, day ${utcDayKey(day)})`,
          dedupeKey: `run_failed:${site.id}:${command}:${utcDayKey(day)}`,
        },
        alertOptions,
      ),
    );
    throw err;
  } finally {
    try {
      appendRunRecord(ledgerPath, {
        ts: startedAt.toISOString(),
        day: utcDayKey(day),
        command,
        site: site.id,
        status: runStatus,
        durationMs: Date.now() - startedAt.getTime(),
        ...(runReason === undefined ? {} : { reason: runReason }),
        ...(runSummary === undefined ? {} : { summary: runSummary }),
      });
    } catch (err) {
      process.stderr.write(
        `batch: run ledger not written (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }
}

/**
 * Exported for wiring tests (2026-11-02 review F-04): the CLI entry auto-runs
 * only when executed as a script; importing this module in tests must be inert.
 */
export { main as runBatch };

const invokedAsScript =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`batch: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
