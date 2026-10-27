// Draft-source registry. Same discipline as the connector registries: the
// default needs no credentials, and a mode selected without its backing
// service fails closed instead of quietly degrading.
//
// The one difference is that this registry THROWS rather than returning a
// rejecting provider: GA_DRAFT_MODE=loom with GA_LOOM_MODE=off would otherwise
// hand the production batch a MockLoomClient article, and a mock article that
// passes QA becomes a real pull request on a real repository.

import type { AppConfig } from '../config.js';
import type { CostRecorder } from '../cost/recorder.js';
import { createLoomClient } from '../connector/loom/registry.js';
import { GrowthAgentErrors } from '../errors.js';
import { InboxDraftProvider } from './inbox.js';
import { LoomDraftProvider } from './loom.js';
import type { DraftProvider } from './types.js';

export function createDraftProvider(
  config: AppConfig,
  recorder?: CostRecorder,
): DraftProvider {
  if (config.draftMode === 'loom') {
    if (config.loomMode !== 'online') {
      throw GrowthAgentErrors.validation(
        'GA_DRAFT_MODE=loom requires GA_LOOM_MODE=online (fail-closed: a mock loom article must never reach a real PR)',
      );
    }
    return new LoomDraftProvider({
      loom: createLoomClient(config),
      inboxDir: config.draftInboxDir,
      ...(recorder !== undefined ? { recorder } : {}),
    });
  }
  return new InboxDraftProvider(config.draftInboxDir);
}
