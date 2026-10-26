// Loom client registry (T-E4). Only the mock exists this wave: there is no
// HTTP adapter until the openapi shapes are reconciled (paths/fields marked
// 待 openapi 对照 in types.ts). Selecting an online mode therefore fails
// closed rather than silently returning mock content.

import { GrowthAgentErrors } from '../../errors.js';
import { MockLoomClient, type MockLoomState } from './mock.js';
import type { LoomClient } from './types.js';

export function createLoomClient(mode: 'mock' | 'online' = 'mock', state?: MockLoomState): LoomClient {
  if (mode === 'online') {
    // Real adapter is explicitly out of scope until openapi reconciliation.
    throw GrowthAgentErrors.credentialMissing(
      'loom online adapter is not implemented (T-E4 mock only; openapi reconciliation pending)',
    );
  }
  return new MockLoomClient(state);
}
