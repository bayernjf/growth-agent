// Fail-closed client returned when GA_ZEUS_MODE=online is selected but
// GA_ZEUS_URL / GA_ZEUS_TOKEN are missing. The service can still boot and
// healthz passes; every decision call fails closed with CREDENTIAL_MISSING
// (422) instead of silently falling back to offline fixtures. Mirrors
// growth-os RejectingSearchProvider / RejectingDecisionPort.

import { GrowthAgentError, GrowthAgentErrors } from '../../errors.js';
import type {
  GrowthDecisionInput,
  ZeusDecisionReplay,
  ZeusDecisionResponse,
  ZeusDecisionClient,
  ZeusPolicy,
  ZeusSelfCheckResult,
  ZeusWebhookSubscriptionBody,
} from './types.js';

export class RejectingZeusClient implements ZeusDecisionClient {
  readonly name = 'zeus-rejecting';
  readonly mode = 'online' as const;

  constructor(private readonly message: string) {}

  private fail(): Promise<never> {
    return Promise.reject(this.error());
  }

  private error(): GrowthAgentError {
    return GrowthAgentErrors.credentialMissing(this.message);
  }

  submitDecision(_input: GrowthDecisionInput): Promise<ZeusDecisionResponse> {
    return this.fail();
  }

  getDecisionAudit(_decisionId: string): Promise<ZeusDecisionReplay> {
    return this.fail();
  }

  getPolicies(): Promise<ZeusPolicy> {
    return this.fail();
  }

  async ping(): Promise<boolean> {
    return false;
  }

  buildSubscriptionPayload(args: {
    callbackUrl: string;
    secret: string;
  }): ZeusWebhookSubscriptionBody {
    if (args.secret.length < 16) {
      throw GrowthAgentErrors.validation('zeus webhook secret must be at least 16 characters');
    }
    return { url: args.callbackUrl, secret: args.secret, active: true };
  }

  startupSelfCheck(): Promise<ZeusSelfCheckResult> {
    return this.fail();
  }
}
