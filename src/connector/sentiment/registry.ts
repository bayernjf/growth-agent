// Sentiment provider registry (OP-40). Mirrors the ads registry discipline:
//   - off (default) -> deterministic OfflineSentimentProvider (zero network).
//   - online        -> RejectingSentimentProvider (422 on every call).
//
// The online branch is deliberately not implemented yet: the real public-source
// transports land in a later OP and require per-source API keys. Selecting
// online therefore fails closed rather than silently falling back to offline.

import type { AppConfig } from '../../config.js';
import { OfflineSentimentProvider } from './offline.js';
import { RejectingSentimentProvider } from './rejecting.js';
import type { SentimentProvider } from './types.js';

export function createSentimentProvider(config: AppConfig): SentimentProvider {
  if (config.sentimentMode === 'online') {
    return new RejectingSentimentProvider(
      'GA_SENTIMENT_MODE=online requires per-source public API keys (GitHub/HN/Reddit/search) that land in a later OP; no sentiment credentials are configured',
    );
  }
  return new OfflineSentimentProvider();
}
