// Loom client registry (SERP/zeus discipline):
//   off (default)  -> deterministic MockLoomClient, zero network.
//   online + url + tenant -> HttpLoomClient speaking the reconciled loom
//     FastAPI wire contract (tests run it against an injected fake fetch).
//   online without url/tenant -> RejectingLoomClient (422 on every call);
//     never silently downgraded to the offline mock.

import type { AppConfig } from '../../config.js';
import { HttpLoomClient } from './http.js';
import { MockLoomClient } from './mock.js';
import { RejectingLoomClient } from './rejecting.js';
import type { LoomClient } from './types.js';

export function createLoomClient(config: AppConfig): LoomClient {
  if (config.loomMode === 'online') {
    if (!config.loomUrl || !config.loomTenantId) {
      return new RejectingLoomClient(
        'GA_LOOM_MODE=online requires GA_LOOM_URL and GA_LOOM_TENANT_ID (fail-closed; never offline mock)',
      );
    }
    return new HttpLoomClient({
      baseUrl: config.loomUrl,
      tenantId: config.loomTenantId,
      token: config.loomToken,
      language: config.loomLanguage,
    });
  }
  return new MockLoomClient();
}
