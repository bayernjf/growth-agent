// Deterministic offline SERP provider (GA_SERP_MODE=off, the default).
// Replays tests/fixtures/serp-fixture.json; zero network, zero BYOK spend.
// Explicit offline mode — online without login/password gets the rejecting
// provider instead, never a silent fixture fallback.
//
// Replay honours the input dimensions: keywordIdeas filters by the asked
// seed, serp() returns the snapshot recorded for the asked query and
// rankTrack matches the asked query/domain. A miss yields an empty result —
// never another query's data and never the whole fixture dumped back.

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

interface SerpFixture {
  keywordIdeas: KeywordIdea[];
  /** Recorded SERP snapshots indexed by the exact query string. */
  serp: Record<string, SerpResult[]>;
  rankTrack: RankTrackItem[];
}

const here = dirname(fileURLToPath(import.meta.url));
// src/connector/serp/offline.(js|ts) -> repo root is three levels up.
const repoRoot = process.env.GA_REPO_ROOT ?? join(here, '..', '..', '..');
const DEFAULT_FIXTURE_PATH = join(repoRoot, 'tests', 'fixtures', 'serp-fixture.json');

function loadFixture(path: string): SerpFixture {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as SerpFixture;
  if (!Array.isArray(parsed.keywordIdeas) || !Array.isArray(parsed.rankTrack)) {
    throw GrowthAgentErrors.validation('serp fixture must contain keywordIdeas[] and rankTrack[]');
  }
  const serpIsIndexed = parsed.serp !== null
    && typeof parsed.serp === 'object'
    && Object.values(parsed.serp).every(rows => Array.isArray(rows));
  if (!serpIsIndexed) {
    throw GrowthAgentErrors.validation(
      'serp fixture must index serp snapshots by query (Record<string, SerpResult[]>)',
    );
  }
  return parsed;
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
    // Input-dimension replay: only ideas related to the asked seed. A seed
    // the fixture has no data for yields an empty set, never unrelated ideas.
    const needle = seed.toLowerCase();
    return this.fixture.keywordIdeas
      .filter(k => k.keyword.includes(needle))
      .map(k => ({ ...k }));
  }

  async serp(query: string, opts?: SerpOpts): Promise<SerpResult[]> {
    if (query === '') {
      throw GrowthAgentErrors.validation('serp: query is required');
    }
    // Input-dimension replay: the snapshot recorded for THIS query. An
    // unrecorded query yields [] instead of another query's morphology.
    const rows = this.fixture.serp[query] ?? [];
    const depth = opts?.depth ?? rows.length;
    return rows.slice(0, depth).map(r => ({ ...r }));
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
