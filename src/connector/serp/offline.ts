// Deterministic offline SERP provider (GA_SERP_MODE=off, the default).
// Replays tests/fixtures/serp-fixture.json; zero network, zero BYOK spend.
// Explicit offline mode — online without login/password gets the rejecting
// provider instead, never a silent fixture fallback.
//
// The tape records one SERP result set per query, mirroring the real
// DataForSEO endpoint: asking for query A never returns query B's results.
// Queries the tape did not record replay as an empty result set (no recorded
// SERP = no SERP evidence), rather than somebody else's results.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrowthAgentErrors } from '../../errors.js';
import type {
  KeywordIdea,
  KeywordIdeasOpts,
  RankTrackItem,
  SerpKeywordProvider,
  SerpOpts,
  SerpResult,
} from './types.js';

interface RecordedSerp {
  query: string;
  results: SerpResult[];
}

interface SerpFixture {
  keywordIdeas: KeywordIdea[];
  serp: RecordedSerp[];
  rankTrack: RankTrackItem[];
}

const here = dirname(fileURLToPath(import.meta.url));
// src/connector/serp/offline.(js|ts) -> repo root is three levels up.
const repoRoot = process.env.GA_REPO_ROOT ?? join(here, '..', '..', '..');
const DEFAULT_FIXTURE_PATH = join(repoRoot, 'tests', 'fixtures', 'serp-fixture.json');

function loadFixture(path: string): SerpFixture {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SerpFixture>;
  if (!Array.isArray(parsed.keywordIdeas) || !Array.isArray(parsed.serp) || !Array.isArray(parsed.rankTrack)) {
    throw GrowthAgentErrors.validation('serp fixture must contain keywordIdeas[], serp[], rankTrack[]');
  }
  for (const entry of parsed.serp) {
    if (typeof entry?.query !== 'string' || !Array.isArray(entry.results)) {
      throw GrowthAgentErrors.validation('serp fixture entries must be { query, results[] }');
    }
  }
  return parsed as SerpFixture;
}

export class OfflineSerpProvider implements SerpKeywordProvider {
  readonly name = 'serp-offline';
  readonly online = false as const;
  private readonly fixture: SerpFixture;

  constructor(fixture?: SerpFixture, fixturePath: string = DEFAULT_FIXTURE_PATH) {
    this.fixture = fixture ?? loadFixture(fixturePath);
  }

  async keywordIdeas(seed: string, _opts?: KeywordIdeasOpts): Promise<KeywordIdea[]> {
    if (seed === '') {
      throw GrowthAgentErrors.validation('keywordIdeas: seed is required');
    }
    const needle = seed.toLowerCase();
    const hits = this.fixture.keywordIdeas.filter(k => k.keyword.includes(needle));
    return (hits.length > 0 ? hits : this.fixture.keywordIdeas).map(k => ({ ...k }));
  }

  async serp(query: string, opts?: SerpOpts): Promise<SerpResult[]> {
    const depth = opts?.depth;
    const recorded = this.fixture.serp.find(entry => entry.query === query);
    if (recorded === undefined) return [];
    const limit = depth ?? recorded.results.length;
    return recorded.results.slice(0, limit).map(r => ({ ...r }));
  }

  async rankTrack(domain: string, queries: string[]): Promise<RankTrackItem[]> {
    if (queries.length === 0) return [];
    const needle = domain.replace(/^https?:\/\//, '');
    return queries.map(query => {
      const hit = this.fixture.rankTrack.find(r => r.query === query);
      if (hit === undefined) {
        return { query, position: null, url: null };
      }
      // Fixture honesty: only claim the rank when the recorded url belongs to
      // the asked domain.
      if (hit.url !== null && !hit.url.includes(needle)) {
        return { query, position: null, url: null };
      }
      return { ...hit };
    });
  }
}
