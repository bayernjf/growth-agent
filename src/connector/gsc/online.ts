// Online GSC transport — WAVE-W4 PLACEHOLDER ONLY.
//
// Scope of this wave: the constructor validates that all OAuth configuration
// (client id/secret, token dir, master key) is present, so the registry can
// distinguish "online selected but half-configured" (-> rejecting provider,
// 422) from "online fully configured" (-> this class, constructable).
//
// The actual searchanalytics HTTP transport against
// https://www.googleapis.com/webmasters/v3/sites[...] +
// /searchAnalytics/{site}/query — with token refresh before each call and
// the §4.1 error table mapping via mapGscHttpError — lands in T-B4 and is
// NOT exercised here. Do not call this class's methods expecting live data;
// they deliberately reject with a not-implemented error so a misconfigured
// online deployment fails loudly instead of silently reading fixtures.

import { GrowthAgentError, GrowthAgentErrors } from '../../errors.js';
import type { GscTokenStore } from './token-store.js';
import type { GscAnalyticsInput, GscReadonlyProvider, GscRow, GscSite } from './types.js';

export interface OnlineGscClientDeps {
  clientId: string;
  clientSecret: string;
  tokenStore: GscTokenStore;
}

export class OnlineGscClient implements GscReadonlyProvider {
  readonly name = 'gsc-http';
  readonly mode = 'online' as const;
  private readonly tokenStore: GscTokenStore;

  constructor(deps: OnlineGscClientDeps) {
    if (deps.clientId === '' || deps.clientSecret === '') {
      throw GrowthAgentErrors.gscCredentialMissing(
        'GA_GSC_MODE=online requires GA_GSC_CLIENT_ID and GA_GSC_CLIENT_SECRET',
      );
    }
    // The sealed-token store is wired at construction; whether a refresh token
    // exists yet is checked at call time (first OAuth run has no sealed file).
    this.tokenStore = deps.tokenStore;
  }

  private notImplemented(): GrowthAgentError {
    // The token store state is reported (never its contents) so an online
    // operator can tell "no OAuth handshake yet" from a transport gap.
    return GrowthAgentErrors.upstreamUnavailable(
      `online GSC searchanalytics transport is not implemented in this wave (lands in T-B4); token store: ${this.tokenStore.describe()}`,
    );
  }

  listSites(): Promise<GscSite[]> {
    return Promise.reject(this.notImplemented());
  }

  queryAnalytics(_input: GscAnalyticsInput): Promise<GscRow[]> {
    return Promise.reject(this.notImplemented());
  }
}
