import { describe, it, expect } from 'vitest';
import {
  aggregateByKey,
  scoreFixCandidates,
  scoreWriteCandidates,
  selectDailyCandidates,
  FIX_POSITION_DROP_MIN,
  DAILY_WRITE_CAP,
  DAILY_FIX_CAP,
} from '../../src/scheduler/candidates.js';
import type { GscSnapshotRow } from '../../src/connector/gsc/snapshot-repository.js';
import type { KeywordIdea, RankTrackItem, SerpResult } from '../../src/connector/serp/types.js';

function pageRow(key: string, position: number, impressions: number, clicks = 0): GscSnapshotRow {
  return { siteUrl: 'https://example.com', date: '2026-10-25', dimensionKey: key, clicks, impressions, position };
}

function encyclopedicSerp(title: string): SerpResult {
  return { url: `https://en.wikipedia.org/wiki/${title}`, title, position: 1, description: 'x' };
}

describe('aggregateByKey', () => {
  it('averages position and sums impressions per key', () => {
    const agg = aggregateByKey([pageRow('/a', 4, 100), pageRow('/a', 8, 200)]);
    expect(agg.get('/a')?.position).toBe(6);
    expect(agg.get('/a')?.impressions).toBe(300);
  });
});

describe('scoreFixCandidates (§5.A.3)', () => {
  it('flags a page whose position dropped >=3', () => {
    const current = [pageRow('/drop', 12, 500)];
    const previous = [pageRow('/drop', 8, 500)];
    const out = scoreFixCandidates(current, previous);
    expect(out).toHaveLength(1);
    expect(out[0]?.positionDelta).toBe(4);
    expect(out[0]?.signalId).toBe('fix:/drop');
  });

  it('flags >=10% impressions loss with natural exposure', () => {
    const current = [pageRow('/drop', 10, 800)];
    const previous = [pageRow('/drop', 10, 1000)];
    const out = scoreFixCandidates(current, previous);
    expect(out[0]?.impressionsLossRatio).toBe(0.2);
  });

  it('does not flag pages without current exposure', () => {
    const current = [pageRow('/drop', 12, 0)];
    const previous = [pageRow('/drop', 8, 500)];
    expect(scoreFixCandidates(current, previous)).toHaveLength(0);
  });

  it('does not flag pages with no prior window row', () => {
    expect(scoreFixCandidates([pageRow('/new', 12, 10)], [])).toHaveLength(0);
  });

  it('orders the worst regression first', () => {
    const current = [pageRow('/a', 20, 100), pageRow('/b', 10, 100)];
    const previous = [pageRow('/a', 10, 100), pageRow('/b', 8, 100)];
    const out = scoreFixCandidates(current, previous);
    expect(out[0]?.pageUrl).toBe('/a');
  });

  it('threshold constant is the documented 3 positions', () => {
    expect(FIX_POSITION_DROP_MIN).toBe(3);
  });
});

describe('scoreWriteCandidates (§5.A.3)', () => {
  const ideas: KeywordIdea[] = [
    { keyword: 'how to bake bread', volume: 800, competition: 0.6 },
    { keyword: 'buy bread maker', volume: 600, competition: 0.8 },
    { keyword: 'tiny', volume: 10, competition: 0.2 },
    { keyword: 'ranked already', volume: 900, competition: 0.4 },
  ];
  const rankTrack: RankTrackItem[] = [
    { query: 'how to bake bread', position: null, url: null },
    { query: 'buy bread maker', position: null, url: null },
    { query: 'ranked already', position: 3, url: 'https://example.com/r' },
  ];
  const serpByQuery = new Map<string, SerpResult[]>([
    ['how to bake bread', [encyclopedicSerp('Bread'), encyclopedicSerp('Sourdough'), encyclopedicSerp('Kneading')]],
    ['buy bread maker', [{ url: 'https://shop.test/p', title: 'Buy now', position: 1, description: 'x' }]],
    ['ranked already', [encyclopedicSerp('Bread')]],
  ]);

  it('keeps high-volume informational queries with no top-10 own result', () => {
    const out = scoreWriteCandidates({ ideas, rankTrack, serpByQuery });
    expect(out.map(w => w.query)).toEqual(['how to bake bread']);
  });

  it('excludes low-volume, covered, and commercial-intent queries', () => {
    const out = scoreWriteCandidates({ ideas, rankTrack, serpByQuery });
    expect(out.find(w => w.query === 'tiny')).toBeUndefined();
    expect(out.find(w => w.query === 'ranked already')).toBeUndefined();
    expect(out.find(w => w.query === 'buy bread maker')).toBeUndefined();
  });
});

describe('selectDailyCandidates hard cap (1 write + 1 fix)', () => {
  it('defers everything beyond the single cap', () => {
    const writes = [
      { kind: 'write' as const, query: 'a', volume: 100, ownPosition: null, form: 'encyclopedic' as const, alignmentScore: 1, signalId: 'w:a' },
      { kind: 'write' as const, query: 'b', volume: 90, ownPosition: null, form: 'encyclopedic' as const, alignmentScore: 1, signalId: 'w:b' },
    ];
    const fixes = [
      { kind: 'fix' as const, pageUrl: '/a', positionDelta: 5, impressionsLossRatio: 0, currentPosition: 10, currentImpressions: 1, previousImpressions: 10, signalId: 'f:a' },
      { kind: 'fix' as const, pageUrl: '/b', positionDelta: 4, impressionsLossRatio: 0, currentPosition: 10, currentImpressions: 1, previousImpressions: 10, signalId: 'f:b' },
    ];
    const sel = selectDailyCandidates(writes, fixes);
    expect(sel.selectedWrites).toHaveLength(DAILY_WRITE_CAP);
    expect(sel.selectedFixes).toHaveLength(DAILY_FIX_CAP);
    expect(sel.deferredWrites).toHaveLength(1);
    expect(sel.deferredFixes).toHaveLength(1);
    expect(sel.selectedWrites[0]?.query).toBe('a');
    expect(sel.selectedFixes[0]?.pageUrl).toBe('/a');
  });
});
