// Dedupe gate (T-E2, design §5.4 + §6.3.2). Rule-version URL/slug and title
// similarity:
//   - A query already served by a GSC top-10 page must NOT open a new page;
//     it becomes a fix candidate (§5.4, §10 "站内重复/互相竞争").
//   - An exact slug collision with an existing page / open PR is a duplicate
//     and is discarded.
//   - Open PRs and published content are always checked so two tasks never
//     race to create the same change.
//
// Pure functions over injected evidence: no I/O, deterministic, easy to test.
// Thresholds are rule-version constants (the docs specify the rule, not a
// number) and are calibrated during dogfood.

import type { ContentDraft, ExistingContent, GateVerdict, GscPageEvidence } from './types.js';

/** §6.3.2 scans the GSC top-20 page set. */
export const DEDUPE_SCAN_TOP_N = 20;
/** §5.4: a query already in top-10 is converted to a fix, not a new page. */
export const EXISTING_TOP_N_FIX = 10;
/** Slug Jaccard similarity at/above which two pages are considered the same. */
export const SLUG_SIMILARITY_THRESHOLD = 0.8;
/** Title token Jaccard similarity at/above which pages are near-duplicates. */
export const TITLE_SIMILARITY_THRESHOLD = 0.6;

/**
 * Extract the comparable path/slug from a URL or raw slug:
 * strips protocol/host/query/hash, lowercases, non-alphanumeric runs
 * (CJK characters are kept) collapse to hyphens.
 */
export function slugify(value: string): string {
  let path = value.trim().toLowerCase();
  // protocol + host
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slashAt = path.indexOf('/');
  if (slashAt >= 0) {
    path = path.slice(slashAt + 1);
  } else {
    path = ''; // bare host: no path segments
  }
  // query / hash
  path = path.split(/[?#]/)[0] ?? path;
  // strip file extension
  path = path.replace(/\.(html?|astro|md|mdx)$/i, '');
  const segments = path
    .split('/')
    .map((seg) => seg.replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter((seg) => seg !== '' && seg !== 'index');
  return segments.join('/');
}

/** Tokenize for set similarity: latin words + CJK bigrams. */
export function tokenize(value: string): Set<string> {
  const lower = value.toLowerCase();
  const tokens = new Set<string>();
  const latinWords = lower.match(/[a-z0-9]{2,}/g);
  for (const word of latinWords ?? []) {
    if (word !== undefined) tokens.add(word);
  }
  const cjk = lower.match(/[一-鿿]+/g);
  for (const run of cjk ?? []) {
    if (run === undefined) continue;
    // Single CJK characters are meaningful in queries; add them plus bigrams.
    for (const ch of run) tokens.add(ch);
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2);
      if (bigram.length === 2) tokens.add(bigram);
    }
  }
  return tokens;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function similarity(draft: ContentDraft, candidate: { url: string; title: string }): number {
  const slugSim = jaccard(
    new Set(slugify(draft.slug).split('/').filter((s) => s !== '')),
    new Set(slugify(candidate.url).split('/').filter((s) => s !== '')),
  );
  const titleSim = jaccard(tokenize(draft.title), tokenize(candidate.title));
  return Math.max(slugSim, titleSim);
}

export interface DedupeInput {
  draft: ContentDraft;
  gscPages: GscPageEvidence[];
  existingOpenChanges: ExistingContent[];
  publishedContent: ExistingContent[];
}

interface Match {
  kind: 'exact_slug' | 'open_change' | 'top10_page' | 'top20_near_match';
  url: string;
  title: string;
  score: number;
  position?: number;
}

/** Find the strongest blocking match, or undefined when the draft is unique. */
export function findDedupeMatch(input: DedupeInput): Match | undefined {
  const draftSlug = slugify(input.draft.slug);
  const matches: Match[] = [];

  // Open PRs / published content: never open a duplicate change (both write
  // and fix tasks — two open PRs for the same slug are always wrong).
  for (const item of [...input.existingOpenChanges, ...input.publishedContent]) {
    if (slugify(item.url) === draftSlug && draftSlug !== '') {
      matches.push({ kind: 'open_change', url: item.url, title: item.title, score: 1 });
    } else {
      const score = similarity(input.draft, item);
      if (score >= TITLE_SIMILARITY_THRESHOLD) {
        matches.push({ kind: 'open_change', url: item.url, title: item.title, score });
      }
    }
  }

  // Fix tasks target an existing page by definition: GSC near-matches are
  // expected, not collisions. Only the open-change check above applies.
  if (input.draft.taskType === 'fix') {
    return matches.sort((a, b) => b.score - a.score)[0];
  }

  const topPages = input.gscPages
    .filter((p) => p.position <= DEDUPE_SCAN_TOP_N)
    .sort((a, b) => a.position - b.position);
  for (const page of topPages) {
    if (slugify(page.url) === draftSlug && draftSlug !== '') {
      matches.push({ kind: 'exact_slug', url: page.url, title: page.title, score: 1, position: page.position });
      continue;
    }
    const score = similarity(input.draft, page);
    if (score >= SLUG_SIMILARITY_THRESHOLD || score >= TITLE_SIMILARITY_THRESHOLD) {
      const kind = page.position <= EXISTING_TOP_N_FIX ? 'top10_page' : 'top20_near_match';
      matches.push({ kind, url: page.url, title: page.title, score, position: page.position });
    }
  }

  return matches.sort((a, b) => b.score - a.score)[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function dedupeGate(input: DedupeInput): GateVerdict {
  const match = findDedupeMatch(input);
  if (match === undefined) {
    return {
      gate: 'dedupe',
      pass: true,
      score: 1,
      reasons: [
        `no duplicate within GSC top-${DEDUPE_SCAN_TOP_N}, open PRs or published content`,
      ],
    };
  }

  if (match.kind === 'exact_slug' || match.kind === 'open_change') {
    return {
      gate: 'dedupe',
      pass: false,
      score: round2(1 - match.score),
      action: 'discard',
      reasons: [
        `duplicate of ${match.kind === 'exact_slug' ? 'existing GSC page' : 'open PR/published page'} ${match.url} (${match.title})`,
      ],
    };
  }

  // Near-match in GSC: the query already has a ranking page — improve that
  // page (fix) instead of opening a competing new one.
  return {
    gate: 'dedupe',
    pass: false,
    score: round2(1 - match.score),
    action: 'convert_to_fix',
    reasons: [
      `query already covered by GSC position ${match.position?.toFixed(1) ?? '?'} page ${match.url} (${match.title}); convert to fix candidate`,
    ],
  };
}
