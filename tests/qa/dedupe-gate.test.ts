import { describe, expect, it } from 'vitest';
import {
  dedupeGate,
  findDedupeMatch,
  jaccard,
  slugify,
  tokenize,
} from '../../src/qa/dedupe-gate.js';
import type { ContentDraft, ExistingContent, GscPageEvidence } from '../../src/qa/types.js';

const writeDraft: ContentDraft = {
  taskType: 'write',
  query: 'site audit checklist',
  slug: '/guides/site-audit-checklist',
  title: 'The Technical Site Audit Checklist',
  paragraphs: ['p1'],
};

const fixDraft: ContentDraft = {
  taskType: 'fix',
  query: 'site audit checklist',
  slug: '/guide/site-audit-checklist',
  title: 'The Technical Site Audit Checklist',
  paragraphs: ['p1'],
};

function page(
  position: number,
  url: string,
  title: string,
  impressions = 100,
): GscPageEvidence {
  return { url, title, position, impressions, clicks: 1 };
}

describe('dedupe helpers (T-E2)', () => {
  it('normalizes URLs to comparable slugs', () => {
    expect(slugify('https://bayjf.com/guides/site-audit-checklist?ref=x#top')).toBe(
      'guides/site-audit-checklist',
    );
    expect(slugify('/guides/site-audit-checklist/')).toBe('guides/site-audit-checklist');
    expect(slugify('https://bayjf.com/guide/index.html')).toBe('guide');
  });

  it('builds latin tokens and CJK bigrams', () => {
    expect(jaccard(tokenize('site audit checklist'), tokenize('site audit guide'))).toBeCloseTo(
      0.5,
      5,
    );
    expect(jaccard(tokenize('技术教程指南'), tokenize('技术教程'))).toBeGreaterThan(0.5);
  });
});

describe('dedupe gate (T-E2)', () => {
  it('passes a unique write draft with no GSC coverage and no open PRs', () => {
    const verdict = dedupeGate({
      draft: writeDraft,
      gscPages: [],
      existingOpenChanges: [],
      publishedContent: [],
    });
    expect(verdict.pass).toBe(true);
    expect(findDedupeMatch({
      draft: writeDraft,
      gscPages: [],
      existingOpenChanges: [],
      publishedContent: [],
    })).toBeUndefined();
  });

  it('converts a top-10 near-match into a fix candidate instead of a new page', () => {
    const verdict = dedupeGate({
      draft: writeDraft,
      gscPages: [
        page(4.2, 'https://bayjf.com/guide/site-audit-checklist', 'The Technical Site Audit Checklist'),
      ],
      existingOpenChanges: [],
      publishedContent: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.action).toBe('convert_to_fix');
    expect(verdict.reasons.join(' ')).toContain('position 4.2');
  });

  it('discards an exact slug collision with an existing GSC page', () => {
    const verdict = dedupeGate({
      draft: { ...writeDraft, slug: '/guide/site-audit-checklist' },
      gscPages: [
        page(12.8, 'https://bayjf.com/guide/site-audit-checklist', 'Some other title'),
      ],
      existingOpenChanges: [],
      publishedContent: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.action).toBe('discard');
  });

  it('converts a top-20 (but not top-10) near-match to a fix as well', () => {
    const verdict = dedupeGate({
      draft: writeDraft,
      gscPages: [
        page(17.4, 'https://bayjf.com/guide/site-audit-checklist', 'The Technical Site Audit Checklist'),
      ],
      existingOpenChanges: [],
      publishedContent: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.action).toBe('convert_to_fix');
  });

  it('ignores GSC pages beyond top-20', () => {
    const verdict = dedupeGate({
      draft: writeDraft,
      gscPages: [
        page(24.6, 'https://bayjf.com/guide/site-audit-checklist', 'The Technical Site Audit Checklist'),
      ],
      existingOpenChanges: [],
      publishedContent: [],
    });
    expect(verdict.pass).toBe(true);
  });

  it('discards a duplicate of an already-open PR', () => {
    const openChange: ExistingContent = {
      url: 'https://github.com/owner/bayjf/pull/12.patch',
      title: 'The Technical Site Audit Checklist',
    };
    const verdict = dedupeGate({
      draft: writeDraft,
      gscPages: [],
      existingOpenChanges: [openChange],
      publishedContent: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.action).toBe('discard');
  });

  it('fix tasks tolerate GSC near-matches (the page is their target)', () => {
    const verdict = dedupeGate({
      draft: fixDraft,
      gscPages: [
        page(4.2, 'https://bayjf.com/guide/site-audit-checklist', 'The Technical Site Audit Checklist'),
      ],
      existingOpenChanges: [],
      publishedContent: [],
    });
    expect(verdict.pass).toBe(true);
  });

  it('fix tasks still discard when an open PR already targets the same slug', () => {
    const openChange: ExistingContent = {
      url: 'https://bayjf.com/guide/site-audit-checklist',
      title: 'Fix the site audit checklist',
    };
    const verdict = dedupeGate({
      draft: fixDraft,
      gscPages: [
        page(4.2, 'https://bayjf.com/guide/site-audit-checklist', 'The Technical Site Audit Checklist'),
      ],
      existingOpenChanges: [openChange],
      publishedContent: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.action).toBe('discard');
  });
});
