// Fail-closed SERP provider: GA_SERP_MODE=online selected without
// GA_SERP_DATAFORSEO_LOGIN/PASSWORD. Every call rejects 422 CREDENTIAL_MISSING
// instead of silently returning offline fixture data (§4.2).

import { GrowthAgentErrors } from '../../errors.js';
import type {
  KeywordIdea,
  KeywordIdeasOpts,
  RankTrackItem,
  SerpKeywordProvider,
  SerpOpts,
  SerpResult,
} from './types.js';

export class RejectingSerpProvider implements SerpKeywordProvider {
  readonly name = 'serp-rejecting';
  readonly online = true as const;

  constructor(private readonly message: string) {}

  private fail(): Promise<never> {
    return Promise.reject(GrowthAgentErrors.credentialMissing(this.message));
  }

  keywordIdeas(_seed: string, _opts?: KeywordIdeasOpts): Promise<KeywordIdea[]> {
    return this.fail();
  }

  serp(_query: string, _opts?: SerpOpts): Promise<SerpResult[]> {
    return this.fail();
  }

  rankTrack(_domain: string, _queries: string[]): Promise<RankTrackItem[]> {
    return this.fail();
  }
}
