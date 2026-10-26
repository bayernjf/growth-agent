// HTTP zeus decision client (GA_ZEUS_MODE=online with url+token).
//
// Uses the Node 22 global fetch (no new dependency). Retryable faults
// (network error, timeout, upstream 5xx, 429) are bounded-exponential retried
// with an injectable clock (§9: base 200ms, up to 3 attempts); 4xx business
// rejections are never retried. All zeus error bodies are mapped verbatim via
// mapUpstreamError — nothing is collapsed into a generic unavailable error.

import { GrowthAgentError, GrowthAgentErrors } from '../../errors.js';
import {
  buildDecisionRequest,
  mapUpstreamError,
  type GrowthDecisionInput,
  type ZeusDecisionClient,
  type ZeusDecisionReplay,
  type ZeusDecisionResponse,
  type ZeusPolicy,
  type ZeusSelfCheckResult,
  type ZeusWebhookSubscriptionBody,
} from './types.js';

export interface OnlineZeusClientDeps {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout (default 10s). */
  timeoutMs?: number;
  /** Total HTTP attempts on retryable faults (default 3). */
  maxAttempts?: number;
  /** Backoff base in ms (default 200 -> sleeps 200, 400, 800). */
  baseBackoffMs?: number;
}

interface WebhookListResponse {
  webhooks?: Array<{ id: string; url: string; active: boolean }>;
}

export class OnlineZeusClient implements ZeusDecisionClient {
  readonly name = 'zeus-http';
  readonly mode = 'online' as const;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;

  constructor(deps: OnlineZeusClientDeps) {
    if (!deps.baseUrl || !deps.token) {
      throw GrowthAgentErrors.credentialMissing('GA_ZEUS_MODE=online requires GA_ZEUS_URL and GA_ZEUS_TOKEN');
    }
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.token = deps.token;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.baseBackoffMs = deps.baseBackoffMs ?? 200;
  }

  async submitDecision(input: GrowthDecisionInput): Promise<ZeusDecisionResponse> {
    const body = buildDecisionRequest(input);
    return this.withRetry(() => this.request<ZeusDecisionResponse>('POST', '/api/v1/decisions', body));
  }

  async getDecisionAudit(decisionId: string): Promise<ZeusDecisionReplay> {
    // zeus exposes the audit chain at GET /decisions/:id/replay?format=json
    // (there is no /audit route). Non-retryable 404s bubble straight through.
    return this.withRetry(() =>
      this.request<ZeusDecisionReplay>('GET', `/api/v1/decisions/${encodeURIComponent(decisionId)}/replay?format=json`),
    );
  }

  async getPolicies(): Promise<ZeusPolicy> {
    return this.withRetry(() => this.request<ZeusPolicy>('GET', '/api/v1/policy'));
  }

  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>('GET', '/api/v1/policy');
      return true;
    } catch {
      return false;
    }
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

  async startupSelfCheck(args?: {
    callbackUrl?: string;
    secret?: string;
  }): Promise<ZeusSelfCheckResult> {
    // 1. ping: a reachable zeus that answers the authenticated policy endpoint.
    if (!(await this.ping())) {
      throw GrowthAgentErrors.decisionUnavailable('zeus startup self-check: ping failed (policy endpoint unreachable)');
    }
    // 2. policy reachability (also confirms our bearer is accepted).
    const policy = await this.getPolicies();

    // 3. re-attach the in-memory decision webhook if it is not already registered.
    let resubscribed = false;
    if (args?.callbackUrl !== undefined && args.secret !== undefined) {
      const existing = await this.request<WebhookListResponse>('GET', '/api/v1/decision-webhooks');
      const already = (existing.webhooks ?? []).some(w => w.url === args.callbackUrl);
      if (!already) {
        await this.request<{ id: string; url: string; active: boolean }>(
          'POST',
          '/api/v1/decision-webhooks',
          this.buildSubscriptionPayload({ callbackUrl: args.callbackUrl, secret: args.secret }),
        );
        resubscribed = true;
      }
    }

    return {
      ping: true,
      policyVersion: policy.version,
      policyDefaultGrade: policy.defaultGrade,
      resubscribed,
      ...(args?.callbackUrl !== undefined ? { webhookUrl: args.callbackUrl } : {}),
    };
  }

  /** Retry only retryable GrowthAgentErrors; 4xx business rejections propagate. */
  private async withRetry<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        if (!(err instanceof GrowthAgentError) || !err.retryable) throw err;
        // Sleep (and record the geometric backoff) even after the final attempt
        // so the injected clock observes 200 -> 400 -> 800 within the 3-attempt budget.
        await this.sleepImpl(this.baseBackoffMs * 2 ** (attempt - 1));
        if (attempt >= this.maxAttempts) throw err;
      }
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      };
      response = await this.fetchImpl(url, init);
    } catch (err) {
      // Network failure / abort(timeout): retryable upstream-unavailable.
      throw GrowthAgentErrors.decisionUnavailable(
        `zeus ${method} ${path} unreachable: ${err instanceof Error ? err.message : 'network error'}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const parsed = parseJson(text);

    if (response.ok) return parsed as T;

    // 401 from zeus requireBearer means our bearer is wrong: non-retryable
    // credential problem, not a transient outage.
    if (response.status === 401) {
      throw GrowthAgentErrors.credentialMissing('zeus rejected our bearer token (401 unauthorized)');
    }
    // A recognized zeus error body carries `code`: map it verbatim (this is how a
    // POLICY_NOT_FOUND / INTERNAL_ERROR 500 stays non-retryable instead of being
    // swallowed by the bare-5xx branch below).
    if (typeof (parsed as { code?: unknown } | null)?.code === 'string') {
      throw mapUpstreamError(response.status, parsed);
    }
    // Bare 5xx / 429 with no decision error body: retryable upstream failure.
    if (response.status >= 500 || response.status === 429) {
      throw GrowthAgentErrors.decisionUnavailable(
        `zeus returned HTTP ${response.status}`,
        parsed,
      );
    }
    // Unrecognized 4xx: surface via the same mapper (400, code preserved).
    throw mapUpstreamError(response.status, parsed);
  }
}

function parseJson(text: string): unknown {
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}
