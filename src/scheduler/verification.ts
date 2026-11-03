// Next-day verification batch (T-A4, design §5.D): merged tasks are
// rechecked at the 06:00 batch once 24h have elapsed. Gain is satisfied when
// the page moved up by >=3 positions OR a new page received its first
// natural impressions; two consecutive checks with no gain end the task as
// done/verified_no_gain (the task is never auto-reverted — the owner keeps
// the page; the outcome feeds the weekly report).

import type { GscReadonlyProvider } from '../connector/gsc/types.js';
import { GrowthTaskRepository } from '../task/repository.js';
import { assertTaskTransition } from '../task/state-machine.js';
import type { GrowthTask, VerifyCheck, VerifyResult } from '../task/types.js';
import { addDays, isoDate } from './dates.js';

export const VERIFY_GAIN_POSITION_MIN = 3;
export const VERIFY_NO_GAIN_CHECKS = 2;

export interface VerificationDeps {
  tasks: GrowthTaskRepository;
  gsc: GscReadonlyProvider;
  /** Resolve the GSC page URL for a merged task; undefined skips the task. */
  resolveTargetUrl: (task: GrowthTask) => string | undefined;
  now: () => Date;
}

export interface VerificationResult {
  checked: Array<{ taskId: string; outcome: 'verified' | 'verified_no_gain' | 'pending' }>;
  skipped: Array<{ taskId: string; reason: string }>;
  /** Per-task GSC/store failures (F-06): one task's error no longer kills the batch. */
  failed: Array<{ taskId: string; reason: string }>;
}

interface PageMetrics {
  position: number;
  impressions: number;
  clicks: number;
}

/**
 * Recheck every merged task whose 24h window has elapsed. One check per run
 * per task; a check recorded today is not re-added (safe re-run).
 */
export async function runVerificationBatch(
  deps: VerificationDeps,
  day: Date = deps.now(),
): Promise<VerificationResult> {
  const result: VerificationResult = { checked: [], skipped: [], failed: [] };
  const tasks = await deps.tasks.list('verifying');
  const dayIso = isoDate(day);
  const cutoff = new Date(day.getTime() - 24 * 60 * 60 * 1000).toISOString();

  for (const task of tasks) {
    // Per-task fault isolation (F-06): a GSC/store throw is recorded as a
    // failed item and the batch continues; previously one UPSTREAM_UNAVAILABLE
    // silently skipped every remaining verification of the day.
    try {
      const checks = task.verifyChecks ?? [];
      // Same-day re-run guard first (cheap and independent of the merge clock).
      if (checks.length > 0 && checks[checks.length - 1]?.at.startsWith(dayIso)) {
        result.skipped.push({ taskId: task.id, reason: 'already_checked_today' });
        continue;
      }
      // The 24h post-merge window is only relevant before the first check;
      // updated_at equals the merged -> verifying transition time until the
      // first check is written.
      if (checks.length === 0 && task.updatedAt > cutoff) {
        result.skipped.push({ taskId: task.id, reason: 'within_24h_window' });
        continue;
      }
      const targetUrl = deps.resolveTargetUrl(task);
      if (targetUrl === undefined || targetUrl === '') {
        result.skipped.push({ taskId: task.id, reason: 'target_url_unresolved' });
        continue;
      }

      const metrics = await readPageMetrics(deps, task.siteId, targetUrl, day);
      const baseline = checks[0];
      const check: VerifyCheck = baseline === undefined
        ? {
            at: dayIso,
            position: metrics.position,
            impressions: metrics.impressions,
            clicks: metrics.clicks,
            positionDelta: 0,
            impressionsDelta: 0,
            clicksDelta: 0,
          }
        : {
            at: dayIso,
            position: metrics.position,
            impressions: metrics.impressions,
            clicks: metrics.clicks,
            positionDelta: Math.round((metrics.position - baseline.position) * 100) / 100,
            impressionsDelta: metrics.impressions - baseline.impressions,
            clicksDelta: metrics.clicks - baseline.clicks,
          };

      const gained =
        (baseline !== undefined && check.positionDelta <= -VERIFY_GAIN_POSITION_MIN) ||
        (baseline !== undefined && baseline.impressions === 0 && check.impressions > 0);
      const nextChecks = [...checks, check];

      if (baseline === undefined) {
        // First check only establishes the baseline.
        await deps.tasks.patch(task.id, { verifyChecks: nextChecks }, day.toISOString());
        result.checked.push({ taskId: task.id, outcome: 'pending' });
        continue;
      }

      assertTaskTransition('verifying', 'done');
      const finalOutcome: VerifyResult['outcome'] = gained ? 'verified' : 'verified_no_gain';

      if (gained || nextChecks.length >= VERIFY_NO_GAIN_CHECKS) {
        const finalResult: VerifyResult = {
          positionDelta: check.positionDelta,
          impressionsDelta: check.impressionsDelta,
          clicksDelta: check.clicksDelta,
          outcome: finalOutcome,
        };
        await deps.tasks.patch(
          task.id,
          { verifyChecks: nextChecks, verifyResult: finalResult },
          day.toISOString(),
        );
        await deps.tasks.setStatus(task.id, 'done', day.toISOString());
        result.checked.push({
          taskId: task.id,
          outcome: finalOutcome === 'verified' ? 'verified' : 'verified_no_gain',
        });
      } else {
        // Second observation window is not complete yet; stay verifying.
        await deps.tasks.patch(task.id, { verifyChecks: nextChecks }, day.toISOString());
        result.checked.push({ taskId: task.id, outcome: 'pending' });
      }
    } catch (error) {
      result.failed.push({
        taskId: task.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
  }
  return result;
}

async function readPageMetrics(
  deps: VerificationDeps,
  siteId: string,
  targetUrl: string,
  day: Date,
): Promise<PageMetrics> {
  // GSC data lags ~3 days; read the 3-day window ending yesterday and match
  // the exact page URL.
  const end = isoDate(addDays(day, -1));
  const start = isoDate(addDays(day, -3));
  const rows = await deps.gsc.queryAnalytics({
    siteUrl: siteId,
    startDate: start,
    endDate: end,
    dimensions: ['page'],
  });
  const match = rows.find(r => r.keys[0] === targetUrl);
  if (match === undefined) {
    // No recorded exposure: zero impressions / no rank (design §5.D: 无曝光).
    return { position: 0, impressions: 0, clicks: 0 };
  }
  return { position: match.position, impressions: match.impressions, clicks: match.clicks };
}
