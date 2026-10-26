import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_PARAGRAPH_RATIO_MAX,
  UNIQUE_INFO_RATIO_MIN,
  WRITE_VOLUME_MIN,
  evaluateValue,
  hasUniqueInfo,
  isTemplateParagraph,
  valueGate,
} from '../../src/qa/value-gate.js';
import type { ContentDraft } from '../../src/qa/types.js';

const richParagraphs = [
  'In our 2026 tests of 14 Astro projects, production build times fell by 38 percent.',
  'We measured a local fixture pipeline across 12 repeated runs.',
  'For example, the site-audit checklist caught 9 broken internal anchors.',
  'Our Search Console data covers 28 days and 480 impressions for this query.',
  'According to our logs, manual chunking saved 42 KB on the first load.',
  'A concrete case from bayjf.com: 3 repaired pages moved up 5 positions.',
];

const writeDraft: ContentDraft = {
  taskType: 'write',
  query: 'site audit checklist',
  slug: '/guides/site-audit-checklist',
  title: 'The Technical Site Audit Checklist',
  paragraphs: richParagraphs,
};

const fixDraft: ContentDraft = {
  taskType: 'fix',
  query: 'site audit checklist',
  slug: '/guide/site-audit-checklist',
  title: 'The Technical Site Audit Checklist',
  paragraphs: richParagraphs,
};

describe('value gate paragraph classification', () => {
  it('flags boilerplate phrases as template paragraphs', () => {
    expect(isTemplateParagraph('Welcome to our website and contact us today.')).toBe(true);
    expect(
      isTemplateParagraph('In today\'s fast-paced world, our team of experts delivers.'),
    ).toBe(true);
    expect(isTemplateParagraph('致力于为客户提供一流的服务。')).toBe(true);
  });

  it('flags short generic paragraphs without unique info as template', () => {
    expect(isTemplateParagraph('We provide great service.')).toBe(true);
  });

  it('recognizes data, cases and local specifics as unique info', () => {
    expect(hasUniqueInfo('We found a 38 percent improvement across 14 projects.')).toBe(true);
    expect(hasUniqueInfo('例如本地构建耗时减少 12 秒。')).toBe(true);
    expect(hasUniqueInfo('This paragraph is generic marketing prose.')).toBe(false);
  });
});

describe('value gate (T-E3)', () => {
  it('passes a high-volume, non-commodity write draft', () => {
    const breakdown = evaluateValue({
      draft: writeDraft,
      keywordVolume: 300,
      gscPages: [],
    });
    expect(breakdown.demandPass).toBe(true);
    expect(breakdown.qualityPass).toBe(true);
    expect(breakdown.templateRatio).toBeLessThanOrEqual(TEMPLATE_PARAGRAPH_RATIO_MAX);
    expect(breakdown.uniqueInfoRatio).toBeGreaterThanOrEqual(UNIQUE_INFO_RATIO_MIN);
    const verdict = valueGate({ draft: writeDraft, keywordVolume: 300, gscPages: [] });
    expect(verdict.pass).toBe(true);
  });

  it('fails write candidates whose volume is below the baseline', () => {
    const verdict = valueGate({
      draft: writeDraft,
      keywordVolume: WRITE_VOLUME_MIN - 1,
      gscPages: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('below baseline');
  });

  it('treats missing volume as zero demand', () => {
    const verdict = valueGate({ draft: writeDraft, gscPages: [] });
    expect(verdict.pass).toBe(false);
  });

  it('passes fix candidates with GSC impressions', () => {
    const verdict = valueGate({
      draft: fixDraft,
      gscPages: [
        { url: 'https://bayjf.com/guide/site-audit-checklist', title: 'T', position: 4, impressions: 480, clicks: 12 },
      ],
    });
    expect(verdict.pass).toBe(true);
  });

  it('fails fix candidates with zero GSC impressions', () => {
    const verdict = valueGate({
      draft: fixDraft,
      gscPages: [
        { url: 'https://bayjf.com/guide/site-audit-checklist', title: 'T', position: 40, impressions: 0, clicks: 0 },
      ],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('0 GSC impressions');
  });

  it('fails template-heavy drafts regardless of demand', () => {
    const boilerplate: ContentDraft = {
      ...writeDraft,
      paragraphs: [
        'Welcome to our website where we offer tailored solutions.',
        'As a leading provider, our team of experts is at your service.',
        'In today\'s fast-paced world, contact us today for a one-stop solution.',
        'Look no further for the best service from committed professionals.',
      ],
    };
    const verdict = valueGate({ draft: boilerplate, keywordVolume: 300, gscPages: [] });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('template paragraph ratio');
  });

  it('fails drafts shorter than the minimum paragraph count', () => {
    const thin: ContentDraft = {
      ...writeDraft,
      paragraphs: ['We measured a 38 percent improvement in our 2026 tests.'],
    };
    const verdict = valueGate({ draft: thin, keywordVolume: 300, gscPages: [] });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('below minimum');
  });
});
