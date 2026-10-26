// Deterministic offline zeus client (GA_ZEUS_MODE=off, the default).
//
// Mirrors growth-os OfflineSearchProvider: fully deterministic, makes ZERO
// network calls, and lets the daily script run end-to-end without a zeus box.
// It is an explicit offline mode — it is never silently substituted when
// GA_ZEUS_MODE=online is selected without credentials (that path returns the
// rejecting client instead).

import { GrowthAgentErrors } from '../../errors.js';
import type {
  GrowthDecisionInput,
  ZeusDecisionReplay,
  ZeusDecisionResponse,
  ZeusDecisionClient,
  ZeusPolicy,
  ZeusSelfCheckResult,
  ZeusWebhookSubscriptionBody,
} from './types.js';

const OFFLINE_POLICY: ZeusPolicy = {
  version: 1,
  defaultGrade: 'D2',
  rules: [{ id: 'd2-org', grade: 'D2', slaHours: 24 }],
};

export class OfflineZeusClient implements ZeusDecisionClient {
  readonly name = 'zeus-offline';
  readonly mode = 'offline' as const;

  async submitDecision(input: GrowthDecisionInput): Promise<ZeusDecisionResponse> {
    return {
      decisionId: `dec_offline_${input.taskId}`,
      grade: 'D2',
      mode: 'approve-sync',
      status: 'awaiting_approval',
      ruleId: 'd2-org',
      proposal: input,
      auditSeq: 0,
    };
  }

  async getDecisionAudit(decisionId: string): Promise<ZeusDecisionReplay> {
    return {
      format: 'json',
      record: { id: decisionId },
      events: [],
    };
  }

  async getPolicies(): Promise<ZeusPolicy> {
    return { ...OFFLINE_POLICY, rules: OFFLINE_POLICY.rules.map(r => ({ ...r })) };
  }

  async ping(): Promise<boolean> {
    return true;
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

  async startupSelfCheck(): Promise<ZeusSelfCheckResult> {
    // Nothing external to reach and no in-memory subscription to re-attach.
    return {
      ping: true,
      policyVersion: OFFLINE_POLICY.version,
      policyDefaultGrade: OFFLINE_POLICY.defaultGrade,
      resubscribed: false,
    };
  }
}
