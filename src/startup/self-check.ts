// Startup self-check chain (T-F2, design §7 "升级流程"):
//
//   1. migrations applied (caller runs migrateUp before this).
//   2. credential presence for every connector selected online — fail
//      closed with the FULL list of missing env vars, never one at a time.
//   3. GA_COST_RATES parses (malformed JSON fails closed at boot).
//   4. zeus reachability (ping) + idempotent webhook re-subscription;
//      an online deployment that cannot reach zeus refuses to start.
//   5. reconciliation of deciding tasks against the zeus audit timeline.
//
// The resulting report is exposed on /healthz so the readiness probe sees
// the same gate the boot sequence ran.

import { parseCostRates } from '../cost/pricing.js';
import { reconcileDecisions, type ReconcileSummary } from '../reconcile/reconcile.js';
import type { ZeusDecisionClient, ZeusSelfCheckResult } from '../connector/zeus/types.js';
import { ChannelFailureRepository } from '../connector/zeus/webhook-repository.js';
import { GrowthTaskRepository } from '../task/repository.js';
import type { StorageDriver } from '../storage/driver.js';
import type { AppConfig } from '../config.js';
import { GrowthAgentErrors } from '../errors.js';

export type ConnectorName = 'zeus' | 'gsc' | 'serp' | 'loom' | 'github';

export interface CredentialPresence {
  connector: ConnectorName;
  /** Selected online; false for offline connectors (no presence check). */
  checked: boolean;
  ok: boolean;
  missing: string[];
}

/**
 * Presence matrix. Only online connectors are checked; each lists the
 * GA_* variables it requires (the runtime registries still fail closed
 * on their own — this is the boot-time fast path).
 */
export function checkCredentialPresence(config: AppConfig): CredentialPresence[] {
  const out: CredentialPresence[] = [];
  if (config.zeusMode === 'online') {
    const missing: string[] = [];
    if (!config.zeusUrl) missing.push('GA_ZEUS_URL');
    if (!config.zeusToken) missing.push('GA_ZEUS_TOKEN');
    if ((config.zeusWebhookSecret ?? '').length < 16) missing.push('GA_ZEUS_WEBHOOK_SECRET(>=16)');
    out.push({ connector: 'zeus', checked: true, ok: missing.length === 0, missing });
  } else {
    out.push({ connector: 'zeus', checked: false, ok: true, missing: [] });
  }

  if (config.gscMode === 'online') {
    const missing: string[] = [];
    if (!config.gscClientId) missing.push('GA_GSC_CLIENT_ID');
    if (!config.gscClientSecret) missing.push('GA_GSC_CLIENT_SECRET');
    if ((config.growthMasterKey ?? '').length < 32) missing.push('GA_GROWTH_MASTER_KEY(>=32 chars)');
    out.push({ connector: 'gsc', checked: true, ok: missing.length === 0, missing });
  } else {
    out.push({ connector: 'gsc', checked: false, ok: true, missing: [] });
  }

  if (config.serpMode === 'online') {
    const missing: string[] = [];
    if (!config.serpLogin) missing.push('GA_SERP_DATAFORSEO_LOGIN');
    if (!config.serpPassword) missing.push('GA_SERP_DATAFORSEO_PASSWORD');
    out.push({ connector: 'serp', checked: true, ok: missing.length === 0, missing });
  } else {
    out.push({ connector: 'serp', checked: false, ok: true, missing: [] });
  }

  if (config.loomMode === 'online') {
    const missing: string[] = [];
    if (!config.loomUrl) missing.push('GA_LOOM_URL');
    if (!config.loomTenantId) missing.push('GA_LOOM_TENANT_ID');
    out.push({ connector: 'loom', checked: true, ok: missing.length === 0, missing });
  } else {
    out.push({ connector: 'loom', checked: false, ok: true, missing: [] });
  }

  if (config.githubMode === 'online') {
    const missing: string[] = [];
    if (!config.githubToken) missing.push('GA_GITHUB_TOKEN');
    // F-05: owner/repo/base branch come from each site's config/sites/*.json,
    // so there is no deployment-wide repository to require here.
    if ((config.githubWebhookSecret ?? '').length < 16) missing.push('GA_GITHUB_WEBHOOK_SECRET(>=16)');
    out.push({ connector: 'github', checked: true, ok: missing.length === 0, missing });
  } else {
    out.push({ connector: 'github', checked: false, ok: true, missing: [] });
  }

  return out;
}

/** Throw one aggregated error listing every missing credential. */
export function assertCredentialPresence(config: AppConfig): CredentialPresence[] {
  const presence = checkCredentialPresence(config);
  const missing = presence.flatMap(p => p.missing.map(m => `${p.connector}: ${m}`));
  if (missing.length > 0) {
    throw GrowthAgentErrors.validation(
      `startup self-check: missing required credentials — ${missing.join('; ')}`,
    );
  }
  // Rates are parsed at boot so a malformed GA_COST_RATES fails fast.
  parseCostRates(config.costRates);
  return presence;
}

export interface ZeusStartupStatus {
  mode: 'off' | 'online';
  ping: boolean;
  selfCheck?: ZeusSelfCheckResult;
}

export interface StartupCheckReport {
  status: 'ready' | 'degraded';
  startedAt: string;
  db: { dialect: 'sqlite' | 'postgres' };
  credentials: CredentialPresence[];
  zeus: ZeusStartupStatus;
  reconcile: ReconcileSummary;
}

export interface StartupCheckDeps {
  config: AppConfig;
  driver: StorageDriver;
  zeus: ZeusDecisionClient;
  tasks: GrowthTaskRepository;
  failures: ChannelFailureRepository;
  now: () => string;
}

/**
 * Run the post-migration boot chain. Throws on a hard fail-closed
 * condition (zeus online but unreachable, missing credentials); returns
 * the readiness report for /healthz.
 */
export async function runStartupChecks(deps: StartupCheckDeps): Promise<StartupCheckReport> {
  const credentials = assertCredentialPresence(deps.config);

  const zeusStatus: ZeusStartupStatus = { mode: deps.config.zeusMode, ping: false };
  if (deps.config.zeusMode === 'online') {
    const ping = await deps.zeus.ping();
    if (!ping) {
      throw GrowthAgentErrors.upstreamUnavailable(
        'startup self-check: zeus ping failed; refusing to start online without decision kernel',
      );
    }
    zeusStatus.ping = true;
    zeusStatus.selfCheck = await deps.zeus.startupSelfCheck(
      deps.config.zeusCallbackUrl !== undefined && deps.config.zeusWebhookSecret !== undefined
        ? { callbackUrl: deps.config.zeusCallbackUrl, secret: deps.config.zeusWebhookSecret }
        : undefined,
    );
  } else {
    zeusStatus.ping = true;
  }

  // Reconciliation is resilient: unreachable zeus leaves tasks deciding,
  // so it never blocks boot (the upstream ping gate already failed closed).
  const reconcile = await reconcileDecisions({
    tasks: deps.tasks,
    zeus: deps.zeus,
    failures: deps.failures,
    now: deps.now,
  });

  const degraded = reconcile.drifted > 0 || reconcile.reconciled > 0;
  return {
    status: degraded ? 'degraded' : 'ready',
    startedAt: deps.now(),
    db: { dialect: deps.driver.dialect },
    credentials,
    zeus: zeusStatus,
    reconcile,
  };
}
