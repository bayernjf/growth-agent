// Production sweep (§5.C driver). runProductionBatch executes one task's QA
// gates and PR open, but takes an assembled draft plus its evidence as
// arguments — and nothing ever supplied them, so the batch had no caller
// outside tests. This sweep is that caller: it walks every task a human
// approved into `drafting`, sources a draft through the DraftProvider port,
// derives GSC / SERP / dedupe evidence from data the orchestrator actually
// holds, and hands the lot to runProductionBatch.
//
// Evidence rules that keep the QA gates meaningful:
//   - a fix task passes ONLY its target page's GSC rows, because the value gate
//     sums impressions across gscPages; passing the whole site would let any
//     fix clear the demand floor for free.
//   - a write task passes the site's published pages, which is what the dedupe
//     gate needs in order to detect existing coverage.
//   - a task whose required input data is absent is skipped BEFORE the gates
//     rather than failed by them: §3.2 allows exactly one qa_revision rework,
//     and a missing SERP volume or an unrun daily batch must not consume it.

import type { CostRecorder } from '../cost/recorder.js';
import type {
  GscSnapshotRepository,
  GscSnapshotRow,
} from '../connector/gsc/snapshot-repository.js';
import type { SerpKeywordProvider } from '../connector/serp/types.js';
import type { DraftProvider } from '../draft/types.js';
import type { SitePublisher } from '../publisher/types.js';
import type { ExistingContent, GscPageEvidence } from '../qa/types.js';
import type { GrowthTaskRepository } from '../task/repository.js';
import { assertTaskTransition } from '../task/state-machine.js';
import type { PrRef } from '../task/types.js';
import { addDays, isoDate } from './dates.js';
import { runProductionBatch } from './production.js';

/** How far back to look for the most recent persisted GSC snapshot. */
export const SNAPSHOT_LOOKBACK_DAYS = 35;

export interface ProductionSweepDeps {
  tasks: GrowthTaskRepository;
  snapshots: GscSnapshotRepository;
  serp: SerpKeywordProvider;
  publisher: SitePublisher;
  drafts: DraftProvider;
  recorder: CostRecorder;
  /** Site id whose GSC snapshots supply the evidence. */
  siteId: string;
  /** owner/repo the PR is opened against (site config). */
  repoFullName: string;
  /** Site origin (e.g. https://bayjf.com); a write task's page URL is derived from it. */
  siteOrigin: string;
  now: () => Date;
}

export interface ProductionSweepItem {
  taskId: string;
  outcome: 'pr_opened' | 'qa_revision' | 'failed' | 'skipped';
  /** Present for skipped items and for loom-sourced drafts. */
  reason?: string | undefined;
  prRef?: PrRef | undefined;
}

export interface ProductionSweepResult {
  items: ProductionSweepItem[];
}

/**
 * GSC searchanalytics returns no page title, so the URL stands in for one. The
 * dedupe gate tokenizes url and title; feeding it the URL twice is the honest
 * limit of the data held locally, not a fabricated title.
 */
function toEvidence(rows: GscSnapshotRow[]): GscPageEvidence[] {
  return rows.map(row => ({
    url: row.dimensionKey,
    title: row.dimensionKey,
    position: row.position,
    impressions: row.impressions,
    clicks: row.clicks,
  }));
}

async function latestSnapshotRows(
  deps: ProductionSweepDeps,
  day: Date,
): Promise<GscSnapshotRow[]> {
  const rows = await deps.snapshots.list(
    deps.siteId,
    isoDate(addDays(day, -SNAPSHOT_LOOKBACK_DAYS)),
    isoDate(day),
  );
  if (rows.length === 0) return [];
  const latest = rows.reduce((max, row) => (row.date > max ? row.date : max), rows[0]?.date ?? '');
  return rows.filter(row => row.date === latest);
}

/** Our own not-yet-merged PRs, so the dedupe gate never opens a second one. */
async function collectOpenChanges(
  tasks: GrowthTaskRepository,
  excludeTaskId: string,
): Promise<ExistingContent[]> {
  const open: ExistingContent[] = [];
  for (const status of ['pr_opened', 'awaiting_merge'] as const) {
    for (const task of await tasks.list(status)) {
      if (task.id === excludeTaskId || task.prRef === undefined) continue;
      open.push({ url: task.prRef.url, title: task.context?.query ?? task.prRef.url });
    }
  }
  return open;
}

export async function runProductionSweep(
  deps: ProductionSweepDeps,
  day: Date = deps.now(),
): Promise<ProductionSweepResult> {
  const items: ProductionSweepItem[] = [];
  const nowIso = () => day.toISOString();

  // A task the operator re-drafted after a QA failure takes its one allowed
  // rework here: qa_revision -> drafting, then the normal path below.
  for (const task of await deps.tasks.list('qa_revision')) {
    if (task.siteId !== deps.siteId) continue;
    assertTaskTransition('qa_revision', 'drafting');
    await deps.tasks.setStatus(task.id, 'drafting', nowIso());
  }

  const drafting = (await deps.tasks.list('drafting')).filter(t => t.siteId === deps.siteId);
  if (drafting.length === 0) return { items };

  const siteRows = await latestSnapshotRows(deps, day);

  for (const task of drafting) {
    const context = task.context;
    if (context === undefined) {
      items.push({
        taskId: task.id,
        outcome: 'skipped',
        reason: 'no persisted candidate context (created before migration 007)',
      });
      continue;
    }

    const obtained = await deps.drafts.obtain({
      taskId: task.id,
      taskType: task.type,
      siteId: task.siteId,
      query: context.query,
      ...(context.targetUrl !== undefined ? { targetUrl: context.targetUrl } : {}),
      angle: context.angle,
      ...(task.loomContentId !== undefined ? { loomContentId: task.loomContentId } : {}),
    });

    if (obtained.status === 'unavailable') {
      // Persist the content id even though no draft arrived, so the next sweep
      // polls loom instead of starting a second chain.
      if (obtained.loomContentId !== undefined && task.loomContentId === undefined) {
        await deps.tasks.patch(task.id, { loomContentId: obtained.loomContentId }, nowIso());
      }
      items.push({ taskId: task.id, outcome: 'skipped', reason: obtained.reason });
      continue;
    }
    if (obtained.loomContentId !== undefined && task.loomContentId === undefined) {
      await deps.tasks.patch(task.id, { loomContentId: obtained.loomContentId }, nowIso());
    }

    const isFix = task.type === 'fix';
    const targetUrl = context.targetUrl ?? context.query;
    const gscPages = toEvidence(
      isFix ? siteRows.filter(row => row.dimensionKey === targetUrl) : siteRows,
    );
    // A fix task repairs a page that is by definition already published, so
    // that page must not reach the dedupe gate as a collision. The gate's own
    // early return for fix tasks skips GSC near-matches but still runs the
    // open-change / published check, which would otherwise block every repair.
    const publishedContent = toEvidence(
      isFix ? siteRows.filter(row => row.dimensionKey !== targetUrl) : siteRows,
    ).map(page => ({ url: page.url, title: page.title }));

    let keywordVolume: number | undefined;
    if (isFix) {
      if (gscPages.length === 0) {
        items.push({
          taskId: task.id,
          outcome: 'skipped',
          reason: `no GSC snapshot row for ${targetUrl}; the daily batch has not persisted one yet`,
        });
        continue;
      }
    } else {
      const ideas = await deps.recorder.measure(
        { provider: 'serp:dataforseo', method: 'GET', endpoint: 'keywordIdeas', taskId: task.id },
        async () => {
          const rows = await deps.serp.keywordIdeas(context.query);
          return { data: rows, units: rows.length, httpStatus: 200 };
        },
      );
      keywordVolume = ideas.find(
        idea => idea.keyword.toLowerCase() === context.query.toLowerCase(),
      )?.volume;
      if (keywordVolume === undefined) {
        items.push({
          taskId: task.id,
          outcome: 'skipped',
          reason: `SERP provider returned no volume for "${context.query}"; the value gate demand floor needs it`,
        });
        continue;
      }
    }

    const serp = await deps.recorder.measure(
      { provider: 'serp:dataforseo', method: 'GET', endpoint: 'serp', taskId: task.id },
      async () => {
        const rows = await deps.serp.serp(context.query);
        return { data: rows, units: rows.length, httpStatus: 200 };
      },
    );

    const result = await runProductionBatch(
      {
        tasks: deps.tasks,
        publisher: deps.publisher,
        recorder: deps.recorder,
        now: nowIso,
      },
      {
        taskId: task.id,
        draft: obtained.draft,
        serp,
        gscPages,
        existingOpenChanges: await collectOpenChanges(deps.tasks, task.id),
        publishedContent,
        ...(keywordVolume !== undefined ? { keywordVolume } : {}),
        changeSummary: obtained.changeSummary,
        repoFullName: deps.repoFullName,
      },
    );

    items.push({
      taskId: task.id,
      outcome: result.action,
      ...(result.prRef !== undefined ? { prRef: result.prRef } : {}),
    });

    // A write task's verification target only exists once the PR names a path,
    // so it is recorded here rather than at candidate time.
    if (result.action === 'pr_opened' && !isFix && context.publishedUrl === undefined) {
      const publishedUrl = new URL(
        obtained.draft.slug.replace(/^\/+/, ''),
        `${deps.siteOrigin}/`,
      ).href;
      await deps.tasks.patch(
        task.id,
        { context: { ...context, publishedUrl } },
        nowIso(),
      );
    }
  }

  return { items };
}
