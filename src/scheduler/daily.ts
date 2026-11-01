// Daily script runner (T-A4, design §5.A "morning batch"). The runner owns
// the full candidate-to-decision pipeline but ONLY the morning batch:
//
//   GSC 28d snapshot -> rankTrack -> keyword ideas -> candidate scoring
//   -> compliance pre-filter gates (already inside scoring) -> hard cap
//   1 write + 1 fix -> create signaled tasks -> submit zeus (D2 human
//   review) -> deciding.
//
// It never drafts content, never opens a PR and never merges: the production
// batch is runProductionBatch (production.ts) and only after a human
// approval moves the task to drafting. All external calls are cost-metered
// (§11.1); same-day re-runs and overlapping ticks are guarded.

import { GscSnapshotRepository } from '../connector/gsc/snapshot-repository.js';
import type { GscReadonlyProvider, GscRow } from '../connector/gsc/types.js';
import { SentimentSnapshotRepository } from '../connector/sentiment/snapshot-repository.js';
import type { SentimentProvider } from '../connector/sentiment/types.js';
import { scoreSentimentAlerts, type SentimentAlert } from './sentiment.js';
import type { SerpKeywordProvider } from '../connector/serp/types.js';
import type { GscSnapshotRow } from '../connector/gsc/snapshot-repository.js';
import type { ZeusDecisionClient } from '../connector/zeus/types.js';
import { GrowthTaskRepository } from '../task/repository.js';
import type { GrowthTaskType } from '../task/types.js';
import { assertTaskTransition } from '../task/state-machine.js';
import { CostRecorder } from '../cost/recorder.js';
import { compactDate, isoDate, trailingInclusive } from './dates.js';
import {
  scoreFixCandidates,
  scoreWriteCandidates,
  selectDailyCandidates,
  type FixCandidate,
  type WriteCandidate,
} from './candidates.js';

export interface DailyDeps {
  siteId: string;
  /** Own domain for rankTrack (e.g. bayjf.com). */
  domain: string;
  gsc: GscReadonlyProvider;
  snapshots: GscSnapshotRepository;
  /** Sentiment provider (W6 / OP-40). Absent = no sentiment snapshot/alert. */
  sentiment?: SentimentProvider | undefined;
  sentimentSnapshots?: SentimentSnapshotRepository | undefined;
  serp: SerpKeywordProvider;
  zeus: ZeusDecisionClient;
  tasks: GrowthTaskRepository;
  recorder: CostRecorder;
  /** Queries to rankTrack daily (site config supplies these in W9). */
  watchQueries: string[];
  /** Seed keywords for write-candidate expansion. */
  keywordSeeds: string[];
  now: () => Date;
  /** Deterministic task id factory; defaults to a date/kind form. */
  idFactory?: (day: Date, kind: GrowthTaskType, index: number) => string;
}

export interface DailyRunResult {
  /** False when a same-day run already happened or a tick is in flight. */
  ran: boolean;
  reason?: string;
  submitted: Array<{ taskId: string; kind: GrowthTaskType; query: string; decisionId: string }>;
  deferredWrites: WriteCandidate[];
  deferredFixes: FixCandidate[];
  /** Negative-mention alerts (OP-41); only when a sentiment provider is wired. */
  sentimentAlerts?: SentimentAlert[];
}

function defaultIdFactory(day: Date, kind: GrowthTaskType, index: number): string {
  return `gt_${compactDate(day)}_${kind}_${index + 1}`;
}

function toSnapshotRows(
  siteId: string,
  date: string,
  rows: GscRow[],
): GscSnapshotRow[] {
  return rows.map(row => ({
    siteUrl: siteId,
    date,
    dimensionKey: row.keys[0] ?? '',
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position,
  }));
}

export class DailyScriptRunner {
  private tickInFlight = false;

  constructor(private readonly deps: DailyDeps) {}

  async run(day: Date = this.deps.now()): Promise<DailyRunResult> {
    // §9 re-entry guard: a tick that has not finished skips the next tick.
    if (this.tickInFlight) {
      return { ran: false, reason: 'tick_in_flight', submitted: [], deferredWrites: [], deferredFixes: [] };
    }

    // Same-day idempotency: a run already created tasks for this site/date.
    // growth_tasks.created_at is an ISO timestamp; compare the date prefix.
    const dayPrefix = isoDate(day);
    const existing = await this.deps.tasks.list();
    const alreadyRan = existing.some(
      t => t.siteId === this.deps.siteId && t.createdAt.startsWith(dayPrefix),
    );
    if (alreadyRan) {
      return { ran: false, reason: 'already_ran_today', submitted: [], deferredWrites: [], deferredFixes: [] };
    }

    this.tickInFlight = true;
    try {
      return await this.runGuarded(day);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async runGuarded(day: Date): Promise<DailyRunResult> {
    const d = this.deps;
    const recent = trailingInclusive(day, 28, 1);
    const prior = trailingInclusive(day, 28, 29);
    const at = d.now;
    const nowIso = () => at().toISOString();

    // 1. GSC window snapshot (page dimension). The 28-day aggregates are
    // persisted keyed by the run date (the schema has no window column);
    // the prior window is used for scoring and not persisted.
    const recentRows = await d.recorder.measure(
      { provider: 'gsc', method: 'GET', endpoint: 'searchanalytics:page' },
      async () => {
        const rows = await d.gsc.queryAnalytics({
          siteUrl: d.siteId,
          startDate: recent.start,
          endDate: recent.end,
          dimensions: ['page'],
        });
        return { data: rows, units: rows.length, httpStatus: 200 };
      },
    );
    const priorRows = await d.recorder.measure(
      { provider: 'gsc', method: 'GET', endpoint: 'searchanalytics:page:prior' },
      async () => {
        const rows = await d.gsc.queryAnalytics({
          siteUrl: d.siteId,
          startDate: prior.start,
          endDate: prior.end,
          dimensions: ['page'],
        });
        return { data: rows, units: rows.length, httpStatus: 200 };
      },
    );
    await d.snapshots.upsert(toSnapshotRows(d.siteId, recent.end, recentRows));

    // 1b. Sentiment snapshot + negative alert scoring (W6 / OP-40/41): pull the
    // day's public mentions, persist them, then score alerts. Optional — no
    // provider leaves the section empty.
    let sentimentAlerts: SentimentAlert[] = [];
    if (d.sentiment !== undefined && d.sentimentSnapshots !== undefined) {
      const today = isoDate(day);
      const mentions = await d.recorder.measure(
        { provider: 'sentiment', method: 'GET', endpoint: 'sentiment:mentions' },
        async () => {
          const rows = await d.sentiment!.querySentiment({ startDate: today, endDate: today });
          return { data: rows, units: rows.length, httpStatus: 200 };
        },
      );
      await d.sentimentSnapshots.upsert(mentions.map((m) => ({
        keyword: m.keyword,
        source: m.source,
        date: m.date,
        title: m.title,
        url: m.url,
        sentiment: m.sentiment,
        metricValue: m.metricValue,
      })));
      sentimentAlerts = scoreSentimentAlerts(await d.sentimentSnapshots.list(today, today));
    }

    // 2. rankTrack for watch queries.
    const rankTrack = await d.recorder.measure(
      { provider: 'serp:dataforseo', method: 'GET', endpoint: 'rankTrack' },
      async () => {
        const rows = await d.serp.rankTrack(d.domain, d.watchQueries);
        return { data: rows, units: rows.length, httpStatus: 200 };
      },
    );

    // 3. Keyword idea expansion + per-query SERP morphology.
    const ideas = [];
    for (const seed of d.keywordSeeds) {
      const batch = await d.recorder.measure(
        { provider: 'serp:dataforseo', method: 'GET', endpoint: 'keywordIdeas' },
        async () => {
          const rows = await d.serp.keywordIdeas(seed);
          return { data: rows, units: rows.length, httpStatus: 200 };
        },
      );
      ideas.push(...batch);
    }
    const serpByQuery = new Map<string, Awaited<ReturnType<typeof d.serp.serp>>>();
    for (const idea of ideas) {
      const results = await d.recorder.measure(
        { provider: 'serp:dataforseo', method: 'GET', endpoint: 'serp' },
        async () => {
          const rows = await d.serp.serp(idea.keyword);
          return { data: rows, units: rows.length, httpStatus: 200 };
        },
      );
      serpByQuery.set(idea.keyword, results);
    }

    // 4-5. Scoring + hard cap.
    const fixes = scoreFixCandidates(
      toSnapshotRows(d.siteId, recent.end, recentRows),
      toSnapshotRows(d.siteId, prior.end, priorRows),
    );
    const writes = scoreWriteCandidates({ ideas, rankTrack, serpByQuery });
    const selection = selectDailyCandidates(writes, fixes);

    // 6. One zeus decision per selected task, signaled -> deciding.
    const submitted: DailyRunResult['submitted'] = [];
    const idFactory = d.idFactory ?? defaultIdFactory;
    const selected: Array<{
      kind: 'write' | 'fix';
      query: string;
      targetUrl?: string;
      signalId: string;
      angle: string;
    }> = [
      ...selection.selectedWrites.map(w => ({
        kind: 'write' as const,
        query: w.query,
        signalId: w.signalId,
        angle: 'daily write candidate: informational demand with no top-10 coverage',
      })),
      ...selection.selectedFixes.map(f => ({
        kind: 'fix' as const,
        query: f.pageUrl,
        targetUrl: f.pageUrl,
        signalId: f.signalId,
        angle: 'daily fix candidate: declining page with natural exposure',
      })),
    ];
    for (const [index, candidate] of selected.entries()) {
      const taskId = idFactory(day, candidate.kind, index);
      await d.tasks.create(
        {
          id: taskId,
          siteId: d.siteId,
          type: candidate.kind,
          signalId: candidate.signalId,
          status: 'signaled',
          // Persisted so the production and verification batches can run in a
          // later process against the stored task alone (migration 007).
          context: {
            query: candidate.query,
            angle: candidate.angle,
            ...(candidate.targetUrl !== undefined ? { targetUrl: candidate.targetUrl } : {}),
          },
        },
        nowIso(),
      );
      const response = await d.recorder.measure(
        { provider: 'zeus', method: 'POST', endpoint: 'decisions', taskId },
        async () => {
          const res = await d.zeus.submitDecision({
            taskId,
            kind: candidate.kind,
            query: candidate.query,
            angle: candidate.angle,
            ...(candidate.targetUrl !== undefined ? { targetUrl: candidate.targetUrl } : {}),
            evidenceSignalIds: [candidate.signalId],
          });
          return { data: res, units: 1, httpStatus: 201 };
        },
      );
      await d.tasks.patch(taskId, { zeusDecisionId: response.decisionId }, nowIso());
      assertTaskTransition('signaled', 'deciding');
      await d.tasks.setStatus(taskId, 'deciding', nowIso());
      submitted.push({ taskId, kind: candidate.kind, query: candidate.query, decisionId: response.decisionId });
    }

    return {
      ran: true,
      submitted,
      deferredWrites: selection.deferredWrites,
      deferredFixes: selection.deferredFixes,
      ...(d.sentiment !== undefined ? { sentimentAlerts } : {}),
    };
  }
}
