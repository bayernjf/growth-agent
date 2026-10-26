import { describe, expect, it } from 'vitest';
import type { SerpResult } from '../../src/connector/serp/types.js';
import {
  DOMINANT_FORM_SHARE,
  INFORMATIONAL_ALIGNMENT_MIN,
  RuleBasedIntentClassifier,
  intentGate,
  labelSerpResult,
} from '../../src/qa/intent-gate.js';

function result(
  position: number,
  url: string,
  title: string,
  description = '',
): SerpResult {
  return { position, url, title, description };
}

function makeResults(builders: Array<[string, string]>): SerpResult[] {
  return builders.map(([url, title], i) => result(i + 1, url, title));
}

const transactionalResults = makeResults(
  Array.from({ length: 10 }, (_, i) => [
    `https://shop${i}.example.com/buy-seo-tool`,
    `Buy SEO tool #${i} — best price, discount and checkout deals`,
  ]),
);

const navigationalResults = makeResults(
  Array.from({ length: 10 }, (_, i) => [
    i === 0 ? 'https://facebook.com/login' : `https://account${i}.example.com/`,
    i === 0 ? 'Log in to Facebook' : 'Sign in to your account homepage',
  ]),
);

const encyclopedicResults = makeResults(
  Array.from({ length: 10 }, (_, i) => [
    `https://en.wikipedia.org/wiki/SEO_${i}`,
    `What is SEO #${i}: a complete how-to guide with examples and tips`,
  ]),
);

const newsResults = makeResults(
  Array.from({ length: 10 }, (_, i) => [
    `https://news${i}.example.com/2026/10/google-announces-update`,
    `Google announces search update #${i} — news report and latest analysis`,
  ]),
);

// 4 informational, 3 commercial, 3 unlabeled (generic) → mixed, no dominant
// morphology, informational share exactly at the 0.4 threshold.
const mixedInformationalResults = makeResults([
  ['https://en.wikipedia.org/wiki/SEO', 'What is SEO: guide and definition'],
  ['https://wiki.example.com/how-to-rank', 'How to rank: tutorial and tips'],
  ['https://news.example.com/google-update', 'Google announces a new update'],
  ['https://edu.example.com/introduction-seo', 'An introduction to SEO basics'],
  ['https://reviews.example.com/best-tools', 'Best SEO tools: review and comparison'],
  ['https://vendors.example.com/top-10', 'Top 10 software providers compared'],
  ['https://alternatives.example.com/vs', 'Tool A vs tool B: alternatives'],
  ['https://a.example.com/page', 'A page with generic content'],
  ['https://b.example.com/page', 'Another page with generic content'],
  ['https://c.example.com/page', 'Yet another generic page'],
]);

// 6 commercial, 4 generic → commercial-dominant, zero informational alignment.
const commercialDominantResults = makeResults([
  ['https://r1.example.com/best', 'Best tools reviewed'],
  ['https://r2.example.com/review', 'Software review: top vendors'],
  ['https://r3.example.com/vs', 'Provider A vs provider B'],
  ['https://r4.example.com/alternatives', 'Top 10 alternatives comparison'],
  ['https://r5.example.com/best-2', 'Best software picks'],
  ['https://r6.example.com/review-2', 'Provider reviews and pricing'],
  ['https://g1.example.com', 'Generic page'],
  ['https://g2.example.com', 'Generic page'],
  ['https://g3.example.com', 'Generic page'],
  ['https://g4.example.com', 'Generic page'],
]);

const classifier = new RuleBasedIntentClassifier();

describe('intent gate (T-E1)', () => {
  it('labels single SERP results by morphology', () => {
    expect(labelSerpResult(result(1, 'https://x.com/buy', 'Buy now at discount price'))).toBe(
      'transactional',
    );
    expect(labelSerpResult(result(1, 'https://facebook.com/login', 'Log in'))).toBe(
      'navigational',
    );
    expect(labelSerpResult(result(1, 'https://en.wikipedia.org/wiki/Seo', 'SEO'))).toBe(
      'encyclopedic',
    );
    expect(labelSerpResult(result(1, 'https://news.example.com/x', 'Google announces update'))).toBe(
      'news',
    );
    expect(labelSerpResult(result(1, 'https://x.com/best', 'Best tools review'))).toBe(
      'commercial',
    );
  });

  it('discards write tasks targeting a transactional SERP', async () => {
    const verdict = await intentGate(
      {
        query: 'buy seo tool',
        contentKind: 'informational_article',
        serp: transactionalResults,
      },
      classifier,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.action).toBe('discard');
    expect(verdict.reasons.join(' ')).toContain('transactional SERP dominant');
  });

  it('discards write tasks targeting a navigational SERP', async () => {
    const verdict = await intentGate(
      {
        query: 'facebook login',
        contentKind: 'informational_article',
        serp: navigationalResults,
      },
      classifier,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.action).toBe('discard');
    expect(verdict.reasons.join(' ')).toContain('navigational SERP dominant');
  });

  it('passes encyclopedic and news SERPs for informational articles', async () => {
    const wiki = await intentGate(
      { query: 'what is seo', contentKind: 'informational_article', serp: encyclopedicResults },
      classifier,
    );
    expect(wiki.pass).toBe(true);
    expect(wiki.score).toBeGreaterThanOrEqual(DOMINANT_FORM_SHARE);
    const news = await intentGate(
      { query: 'google update', contentKind: 'informational_article', serp: newsResults },
      classifier,
    );
    expect(news.pass).toBe(true);
  });

  it('passes a mixed SERP at exactly the informational alignment threshold', async () => {
    const verdict = await intentGate(
      {
        query: 'seo guide',
        contentKind: 'informational_article',
        serp: mixedInformationalResults,
      },
      classifier,
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.score).toBeGreaterThanOrEqual(INFORMATIONAL_ALIGNMENT_MIN);
  });

  it('discards a commercial-dominant SERP that lacks informational alignment', async () => {
    const verdict = await intentGate(
      {
        query: 'best seo software',
        contentKind: 'informational_article',
        serp: commercialDominantResults,
      },
      classifier,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.action).toBe('discard');
    expect(verdict.score).toBeLessThan(INFORMATIONAL_ALIGNMENT_MIN);
  });

  it('always passes fix tasks: intent is proven by existing GSC exposure', async () => {
    const verdict = await intentGate(
      { query: 'buy seo tool', contentKind: 'page_fix', serp: transactionalResults },
      classifier,
    );
    expect(verdict.pass).toBe(true);
  });
});
