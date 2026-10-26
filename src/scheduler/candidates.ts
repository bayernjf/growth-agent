// Daily candidate selection (design §5.A steps 3-6). Pure functions, no I/O
// and no clock — the daily runner supplies the two GSC windows and the SERP
// signals. Scoring thresholds are documented constants; the daily hard cap
// (one write + one fix) is enforced here so a re-run can never exceed it.

import { WRITE_VOLUME_MIN } from '../qa/value-gate.js';
import {
  DOMINANT_FORM_SHARE,
  INFORMATIONAL_ALIGNMENT_MIN,
  labelSerpResult,
} from '../qa/intent-gate.js';
import type { SerpForm } from '../qa/types.js';
import type { GscSnapshotRow } from '../connector/gsc/snapshot-repository.js';
import type { KeywordIdea, RankTrackItem, SerpResult } from '../connector/serp/types.js';

/** Fix candidate: position dropped >=3 or impressions dropped >=10% (§5.A.3). */
export const FIX_POSITION_DROP_MIN = 3;
export const FIX_IMPRESSIONS_DROP_RATIO_MIN = 0.1;
/** Own-domain results beyond this rank count as "no top-10 coverage". */
export const OWN_TOP_RANK = 10;
/** Daily hard cap (§5.A.6, §10: 1 write + 1 fix, no parallel PRs). */
export const DAILY_WRITE_CAP = 1;
export const DAILY_FIX_CAP = 1;

export interface PageAggregate {
  key: string;
  position: number;
  impressions: number;
  clicks: number;
}

export interface FixCandidate {
  kind: 'fix';
  /** GSC page dimension key (URL). */
  pageUrl: string;
  /** Positive number = rank got worse (current - previous). */
  positionDelta: number;
  /** 0..1 impressions loss ratio (previous - current) / previous. */
  impressionsLossRatio: number;
  currentPosition: number;
  currentImpressions: number;
  previousImpressions: number;
  /** Deterministic signal id (§9 growth-os fingerprint convention). */
  signalId: string;
}

export interface WriteCandidate {
  kind: 'write';
  query: string;
  volume: number;
  /** Best (lowest) own-domain position, or null when absent from the SERP. */
  ownPosition: number | null;
  /** Dominant SERP morphology observed for the query. */
  form: SerpForm;
  /** 0..1 informational alignment share; must reach the intent gate floor. */
  alignmentScore: number;
  signalId: string;
}

export interface SelectionResult {
  selectedWrites: WriteCandidate[];
  selectedFixes: FixCandidate[];
  deferredWrites: WriteCandidate[];
  deferredFixes: FixCandidate[];
}

/** Average the 28-day window rows per dimension key (position mean, totals). */
export function aggregateByKey(rows: GscSnapshotRow[]): Map<string, PageAggregate> {
  const sums = new Map<string, { positionSum: number; count: number; impressions: number; clicks: number }>();
  for (const row of rows) {
    const acc = sums.get(row.dimensionKey) ?? { positionSum: 0, count: 0, impressions: 0, clicks: 0 };
    acc.positionSum += row.position;
    acc.count += 1;
    acc.impressions += row.impressions;
    acc.clicks += row.clicks;
    sums.set(row.dimensionKey, acc);
  }
  const out = new Map<string, PageAggregate>();
  for (const [key, acc] of sums) {
    out.set(key, {
      key,
      position: Math.round((acc.positionSum / acc.count) * 100) / 100,
      impressions: acc.impressions,
      clicks: acc.clicks,
    });
  }
  return out;
}

/**
 * Fix candidates: pages with natural exposure (impressions > 0 in the
 * current window) whose rank dropped by >=3 positions OR whose impressions
 * fell by >=10% week-over-window (§5.A.3).
 */
export function scoreFixCandidates(
  current: GscSnapshotRow[],
  previous: GscSnapshotRow[],
): FixCandidate[] {
  const cur = aggregateByKey(current);
  const prev = aggregateByKey(previous);
  const out: FixCandidate[] = [];
  for (const [pageUrl, c] of cur) {
    const p = prev.get(pageUrl);
    if (p === undefined) continue;
    if (c.impressions <= 0) continue;
    const positionDelta = Math.round((c.position - p.position) * 100) / 100;
    const impressionsLossRatio =
      p.impressions > 0 ? Math.max(0, (p.impressions - c.impressions) / p.impressions) : 0;
    const positionDropped = positionDelta >= FIX_POSITION_DROP_MIN;
    const impressionsDropped = impressionsLossRatio >= FIX_IMPRESSIONS_DROP_RATIO_MIN;
    if (!positionDropped && !impressionsDropped) continue;
    out.push({
      kind: 'fix',
      pageUrl,
      positionDelta,
      impressionsLossRatio: Math.round(impressionsLossRatio * 1000) / 1000,
      currentPosition: c.position,
      currentImpressions: c.impressions,
      previousImpressions: p.impressions,
      signalId: `fix:${pageUrl}`,
    });
  }
  // Worst regression first: largest rank drop, then largest impression loss.
  out.sort((a, b) => b.positionDelta - a.positionDelta
    || b.impressionsLossRatio - a.impressionsLossRatio);
  return out;
}

function morphologyOf(results: SerpResult[]): { form: SerpForm; alignmentScore: number } {
  const labels = results.map(labelSerpResult);
  const counts = new Map<SerpForm, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let dominant: SerpForm = 'mixed';
  let dominantCount = 0;
  for (const [form, count] of counts) {
    if (count > dominantCount) {
      dominant = form;
      dominantCount = count;
    }
  }
  if (dominantCount / Math.max(1, labels.length) < DOMINANT_FORM_SHARE) {
    dominant = 'mixed';
  }
  // Informational alignment = encyclopedic + news shares (the article forms).
  const informational = (counts.get('encyclopedic') ?? 0) + (counts.get('news') ?? 0);
  const alignmentScore = Math.round((informational / Math.max(1, labels.length)) * 100) / 100;
  return { form: dominant, alignmentScore };
}

/**
 * Write candidates: enough demand (volume >= WRITE_VOLUME_MIN), no own-domain
 * top-10 result, and an informational SERP (§5.A.3/§5.4).
 */
export function scoreWriteCandidates(args: {
  ideas: KeywordIdea[];
  rankTrack: RankTrackItem[];
  serpByQuery: Map<string, SerpResult[]>;
}): WriteCandidate[] {
  const ownPositions = new Map<string, number | null>();
  for (const item of args.rankTrack) {
    ownPositions.set(item.query, item.position);
  }
  const out: WriteCandidate[] = [];
  for (const idea of args.ideas) {
    if (idea.volume < WRITE_VOLUME_MIN) continue;
    const own = ownPositions.get(idea.keyword) ?? null;
    if (own !== null && own <= OWN_TOP_RANK) continue;
    const serp = args.serpByQuery.get(idea.keyword) ?? [];
    const { form, alignmentScore } = morphologyOf(serp);
    if (alignmentScore < INFORMATIONAL_ALIGNMENT_MIN) continue;
    out.push({
      kind: 'write',
      query: idea.keyword,
      volume: idea.volume,
      ownPosition: own,
      form,
      alignmentScore,
      signalId: `write:${idea.keyword}`,
    });
  }
  out.sort((a, b) => b.volume - a.volume);
  return out;
}

/** Apply the daily 1+1 hard cap; everything else is explicitly deferred. */
export function selectDailyCandidates(
  writes: WriteCandidate[],
  fixes: FixCandidate[],
): SelectionResult {
  return {
    selectedWrites: writes.slice(0, DAILY_WRITE_CAP),
    selectedFixes: fixes.slice(0, DAILY_FIX_CAP),
    deferredWrites: writes.slice(DAILY_WRITE_CAP),
    deferredFixes: fixes.slice(DAILY_FIX_CAP),
  };
}
