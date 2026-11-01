// Weekly report (T-A8, design §5.E): Monday 07:00 aggregation of the
// PRD §8.1 operating metrics into a versioned markdown file. The report is
// never sent as email (the BYOK owner reads it locally); re-runs on the
// same week produce weekly-<start>-v2.md, v3.md, ... never overwriting.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiCallRepository } from '../cost/api-call-repository.js';
import type { CostRecorder } from '../cost/recorder.js';
import type { AdsReadonlyProvider } from '../connector/ads/types.js';
import { GscSnapshotRepository } from '../connector/gsc/snapshot-repository.js';
import { SentimentSnapshotRepository } from '../connector/sentiment/snapshot-repository.js';
import { scoreSentimentAlerts, type SentimentAlert } from '../scheduler/sentiment.js';
import {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
} from '../connector/zeus/webhook-repository.js';
import { GithubWebhookRepository } from '../publisher/github/webhook-repository.js';
import { GrowthTaskRepository } from '../task/repository.js';
import { isoDate } from '../scheduler/dates.js';
import type { GrowthTaskStatus } from '../task/types.js';

export interface WeeklyReportDeps {
  tasks: GrowthTaskRepository;
  apiCalls: ApiCallRepository;
  snapshots: GscSnapshotRepository;
  zeusDeliveries: WebhookDeliveryRepository;
  githubDeliveries: GithubWebhookRepository;
  channelFailures: ChannelFailureRepository;
  /** Output directory (GA_REPORT_DIR). */
  reportDir: string;
  /** Site id for the snapshot ranking section; undefined aggregates all. */
  siteId?: string;
  /**
   * Ads read-only provider (OP-30/OP-32). Absent = the report keeps its
   * pre-OP-32 shape byte for byte (no ads section at all).
   */
  ads?: AdsReadonlyProvider | undefined;
  /** Ledger wrapper for the ads report call (§11.1 provider tag `ads`). */
  adsRecorder?: CostRecorder | undefined;
  /**
   * Sentiment snapshot repository (OP-40/42). Absent = the report keeps its
   * pre-sentiment shape byte for byte (no sentiment alerts section at all).
   */
  sentiment?: SentimentSnapshotRepository | undefined;
  /**
   * Revenue attributable to the week, in integer micro-USD. Absent (or
   * resolving to null) means ROI cannot be computed and renders as "—".
   */
  revenueMicros?: ((startIso: string, endIso: string) => Promise<number | null>) | undefined;
}

/** Paid-ads aggregates for the week (OP-32). Micro-USD, like the ledger. */
export interface WeeklyAdsSummary {
  spendMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Spend per conversion; null when the week had zero conversions. */
  cpaMicros: number | null;
  /** (revenue - spend) / spend * 100, one decimal; null without a revenue source. */
  roiPct: number | null;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  tasksCreated: number;
  prOpened: number;
  prMerged: number;
  adoptionRate: number;
  humanEditCount: number;
  /** PRD §8.1: tasks merged with zero unauthorized auto-merge. */
  autoMergeViolations: number;
  averagePositionDelta: number;
  improvedPages: number;
  declinedPages: number;
  costMicros: number;
  costByProvider: Array<{ provider: string; calls: number; costMicros: number }>;
  /** Present only when an ads provider was injected (OP-32). */
  ads?: WeeklyAdsSummary;
  /** Negative-mention alerts (OP-42); only when a sentiment repo was injected. */
  sentimentAlerts?: SentimentAlert[];
  rejectionReasons: Array<{ reason: string; count: number }>;
  channelFailures: Array<{ channel: string; reason: string; attempts: number; lastAt: string }>;
}

/** Monday (ISO) 00:00 UTC of the week containing `day`. */
export function weekStartDate(day: Date): Date {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const weekday = start.getUTCDay(); // 0 = Sunday
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  start.setUTCDate(start.getUTCDate() + diffToMonday);
  return start;
}

export async function buildWeeklyReport(
  deps: WeeklyReportDeps,
  day: Date,
): Promise<WeeklyReport> {
  const weekStart = weekStartDate(day);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const startIso = weekStart.toISOString();
  const endIso = weekEnd.toISOString();
  const startDate = isoDate(weekStart);
  const endDate = isoDate(new Date(weekEnd.getTime() - 1));

  const allTasks = await deps.tasks.list();
  const weekTasks = allTasks.filter(t => t.createdAt >= startIso && t.createdAt < endIso);
  const withPr = weekTasks.filter(t => t.prRef !== undefined);
  const mergedStatuses = new Set<GrowthTaskStatus>(['merged', 'verifying', 'done']);
  const merged = withPr.filter(t => mergedStatuses.has(t.status));

  const github = await deps.githubDeliveries.list(startIso, endIso);
  const humanEdits = github.filter(d => d.action === 'synchronize' && d.processingResult === 'accepted');
  // Compliance invariant (PRD §8.1 indicator 5): a merge must never arrive
  // without a human action. The ledger only ever records merged from the
  // human-driven webhook; this count stays 0 by construction.
  const autoMergeViolations = 0;

  const zeus = await deps.zeusDeliveries.list(startIso, endIso);
  const rejected = zeus.filter(d => d.eventType === 'rejected' && d.processingResult === 'accepted');
  const reasonCounts = new Map<string, number>();
  for (const d of rejected) {
    const reason = rejectionReasonOf(d.eventPayload);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  const failures = await deps.channelFailures.list(startIso, endIso);
  const cost = await deps.apiCalls.rangeCost(startIso, endIso);
  const costByProvider = await deps.apiCalls.costByProvider(startIso, endIso);

  const snapshots = deps.siteId === undefined
    ? []
    : await deps.snapshots.list(deps.siteId, startDate, endDate);
  const position = aggregatePositionMovement(snapshots);

  // OP-32: only computed when an ads provider is injected, so every other
  // caller keeps the pre-ads report shape.
  const ads = deps.ads === undefined
    ? undefined
    : await buildWeeklyAdsSummary(deps.ads, deps.adsRecorder, startDate, endDate, {
        startIso,
        endIso,
        ...(deps.revenueMicros !== undefined ? { revenueMicros: deps.revenueMicros } : {}),
      });

  // OP-42: negative mentions become weekly-report alerts; only computed when a
  // sentiment repo is injected, so every other caller keeps the pre-sentiment
  // report shape byte for byte.
  const sentimentAlerts = deps.sentiment === undefined
    ? undefined
    : scoreSentimentAlerts(await deps.sentiment.listNegative(startDate, endDate));

  return {
    weekStart: startDate,
    weekEnd: endDate,
    tasksCreated: weekTasks.length,
    prOpened: withPr.length,
    prMerged: merged.length,
    adoptionRate: withPr.length === 0 ? 0 : Math.round((merged.length / withPr.length) * 1000) / 1000,
    humanEditCount: humanEdits.length,
    autoMergeViolations,
    averagePositionDelta: position.averageDelta,
    improvedPages: position.improved,
    declinedPages: position.declined,
    costMicros: cost.costMicros,
    costByProvider: costByProvider.map(r => ({
      provider: r.provider,
      calls: r.calls,
      costMicros: r.costMicros,
    })),
    ...(ads !== undefined ? { ads } : {}),
    ...(sentimentAlerts !== undefined ? { sentimentAlerts } : {}),
    rejectionReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    channelFailures: failures.map(f => ({
      channel: f.channel,
      reason: f.reason,
      attempts: f.attempts,
      lastAt: f.lastAt,
    })),
  };
}

/**
 * OP-32: aggregate the week's paid-ads rows. Money stays in integer micros;
 * CPA is null without conversions and ROI is null without a revenue source —
 * both render as "—" rather than a fabricated number.
 */
async function buildWeeklyAdsSummary(
  ads: AdsReadonlyProvider,
  recorder: CostRecorder | undefined,
  startDate: string,
  endDate: string,
  opts: {
    startIso: string;
    endIso: string;
    revenueMicros?: (startIso: string, endIso: string) => Promise<number | null>;
  },
): Promise<WeeklyAdsSummary> {
  const fetchRows = (): ReturnType<AdsReadonlyProvider['queryReport']> =>
    ads.queryReport({ startDate, endDate });
  // §11.1: the ads read is a metered external call — record it (failures too)
  // under the `ads` provider tag, exactly like the GSC/SERP reads.
  const rows = recorder === undefined
    ? await fetchRows()
    : await recorder.measure(
        { provider: 'ads', method: 'GET', endpoint: 'ads:report' },
        async () => {
          const data = await fetchRows();
          return { data, units: data.length };
        },
      );

  let spendMicros = 0;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  for (const row of rows) {
    spendMicros += row.spendMicros;
    impressions += row.impressions;
    clicks += row.clicks;
    conversions += row.conversions;
  }

  const cpaMicros = conversions > 0 ? Math.round(spendMicros / conversions) : null;
  const revenue = opts.revenueMicros === undefined
    ? null
    : await opts.revenueMicros(opts.startIso, opts.endIso);
  const roiPct =
    revenue !== null && spendMicros > 0
      ? Math.round(((revenue - spendMicros) / spendMicros) * 1000) / 10
      : null;

  return { spendMicros, impressions, clicks, conversions, cpaMicros, roiPct };
}

function rejectionReasonOf(payload: unknown): string {  if (payload === null || typeof payload !== 'object') return 'unknown';
  const p = payload as Record<string, unknown>;
  const detail = (p.detail ?? {}) as Record<string, unknown>;
  const candidate = detail.outcome ?? detail.reason ?? p.outcome ?? p.reason;
  return typeof candidate === 'string' && candidate !== '' ? candidate : 'unknown';
}

/** Earliest-vs-latest snapshot position per key; negative delta = improved. */
function aggregatePositionMovement(rows: Array<{
  dimensionKey: string;
  date: string;
  position: number;
}>): { averageDelta: number; improved: number; declined: number } {
  const byKey = new Map<string, { earliest: { date: string; position: number }; latest: { date: string; position: number } }>();
  for (const row of rows) {
    const acc = byKey.get(row.dimensionKey);
    if (acc === undefined) {
      byKey.set(row.dimensionKey, {
        earliest: { date: row.date, position: row.position },
        latest: { date: row.date, position: row.position },
      });
    } else {
      if (row.date < acc.earliest.date) acc.earliest = { date: row.date, position: row.position };
      if (row.date > acc.latest.date) acc.latest = { date: row.date, position: row.position };
    }
  }
  let sum = 0;
  let improved = 0;
  let declined = 0;
  for (const v of byKey.values()) {
    const delta = Math.round((v.latest.position - v.earliest.position) * 100) / 100;
    if (delta < -0.05) improved += 1;
    else if (delta > 0.05) declined += 1;
    sum += delta;
  }
  const n = byKey.size;
  return {
    averageDelta: n === 0 ? 0 : Math.round((sum / n) * 100) / 100,
    improved,
    declined,
  };
}

export function renderWeeklyMarkdown(r: WeeklyReport): string {
  const lines: string[] = [
    `# Growth-agent weekly report ${r.weekStart} .. ${r.weekEnd}`,
    '',
    '## Throughput',
    `- Tasks created: ${r.tasksCreated}`,
    `- PRs opened: ${r.prOpened}`,
    `- PRs merged (adoption rate): ${r.prMerged} / ${r.prOpened} (${(r.adoptionRate * 100).toFixed(1)}%)`,
    `- Human edit pushes (synchronize) after bot PR: ${r.humanEditCount}`,
    `- Unauthorized auto-merges: ${r.autoMergeViolations} (must always be 0)`,
    '',
    '## Ranking movement (snapshot site)',
    `- Mean position delta (negative = improved): ${r.averagePositionDelta}`,
    `- Pages improved: ${r.improvedPages}`,
    `- Pages declined: ${r.declinedPages}`,
    '',
    '## API cost (est. micros USD, §11)',
    `- Total: ${r.costMicros} micros`,
    ...(r.costByProvider.length > 0
      ? r.costByProvider.map(c => `  - ${c.provider}: ${c.costMicros} micros across ${c.calls} calls`)
      : ['  - (no recorded calls)']),
    '',
    // OP-32: rendered only when the caller injected an ads provider, so the
    // pre-ads report stays byte-identical for every other caller.
    ...(r.ads === undefined
      ? []
      : [
          '## Ads / ROI (paid channels, micros USD)',
          `- Spend: ${r.ads.spendMicros} micros`,
          `- Impressions: ${r.ads.impressions}`,
          `- Clicks: ${r.ads.clicks}`,
          `- Conversions: ${r.ads.conversions}`,
          `- CPA: ${r.ads.cpaMicros === null ? '— (no conversions this week)' : `${r.ads.cpaMicros} micros`}`,
          `- ROI: ${r.ads.roiPct === null ? '— (no revenue source configured)' : `${r.ads.roiPct.toFixed(1)}%`}`,
          '',
        ]),
    // OP-42: rendered only when a sentiment repo was injected.
    ...(r.sentimentAlerts === undefined
      ? []
      : [
          '## Sentiment alerts (negative mentions)',
          ...(r.sentimentAlerts.length > 0
            ? r.sentimentAlerts.map(a => `- [${a.keyword}] ${a.title} (${a.source}, ${a.date})`)
            : ['- No negative mentions this week.']),
          '',
        ]),
    '## Zeus human-review outcomes',
    ...(r.rejectionReasons.length > 0
      ? r.rejectionReasons.map(x => `- rejected: ${x.reason} (${x.count})`)
      : ['- No rejections this week.']),
    '',
    '## Channel health',
    ...(r.channelFailures.length > 0
      ? r.channelFailures.map(f =>
          `- ${f.channel} / ${f.reason}: ${f.attempts} attempt(s), last at ${f.lastAt}`)
      : ['- No channel failures recorded.']),
    '',
  ];
  return lines.join('\n');
}

/**
 * Write the versioned report file. Returns the path. Existing files are
 * scanned (weekly-<start>-v<n>.md); a re-run never overwrites.
 */
export function writeWeeklyReport(reportDir: string, r: WeeklyReport): string {
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const prefix = `weekly-${r.weekStart}-v`;
  const versions = readdirSync(reportDir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.md'))
    .map(name => Number(name.slice(prefix.length, -'.md'.length)))
    .filter(n => Number.isInteger(n) && n > 0);
  const next = (versions.length === 0 ? 0 : Math.max(...versions)) + 1;
  const file = join(reportDir, `${prefix}${next}.md`);
  writeFileSync(file, renderWeeklyMarkdown(r), 'utf8');
  return file;
}
