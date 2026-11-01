// Fail-closed sentiment provider returned when GA_SENTIMENT_MODE=online is
// selected. The real public-source transports (GitHub API, HN Algolia, Reddit
// API, search brand-mention queries) land in a later OP and need per-source
// keys; until then every read fails 422 SENTIMENT_CREDENTIAL_MISSING instead
// of silently substituting the offline fixture.

import { GrowthAgentErrors } from '../../errors.js';
import type { SentimentProvider, SentimentInput, SentimentRow } from './types.js';

export class RejectingSentimentProvider implements SentimentProvider {
  readonly name = 'sentiment-rejecting';
  readonly mode = 'online' as const;

  constructor(private readonly message: string) {}

  private fail(): Promise<never> {
    return Promise.reject(GrowthAgentErrors.sentimentCredentialMissing(this.message));
  }

  querySentiment(_input: SentimentInput): Promise<SentimentRow[]> {
    return this.fail();
  }
}
