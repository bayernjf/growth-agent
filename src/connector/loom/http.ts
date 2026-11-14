// Online loom adapter (openapi-reconciled). Speaks the real loom FastAPI
// wire contract:
//   POST /api/content/generate   body { final_id, kind, language, actor{id, roles['operations']} }
//   GET  /api/content/{content_id}?tenant_id=<required>
// Both are exercised offline against an injected fake fetch returning recorded
// ContentProductView payloads; no loom runtime, no real network.
//
// Error semantics (router.py exception mapping, preserved verbatim):
//   404                -> NOT_FOUND (final_id/content not found; tenant mismatch too)
//   401                -> CREDENTIAL_MISSING (staff gate on, token invalid/missing)
//   403                -> CREDENTIAL_MISSING (self-declared actor rejected:
//                         operations role / staff gate — operator config problem)
//   409                -> INVALID_TRANSITION (FCW revoked / duplicate / wrong state)
//   422                -> VALIDATION_FAILED (unknown kind / language not eligible)
//   429 / 500+ / 502 / network -> UPSTREAM_UNAVAILABLE, bounded-exponential retry
//                         (3 attempts, 200ms base — same rhythm as SERP/zeus).

import { GrowthAgentError, GrowthAgentErrors } from '../../errors.js';
import type {
  LoomClient,
  LoomContent,
  LoomContentStatus,
  LoomFinalIssueInput,
  LoomTopicDraftInput,
  LoomTopicDraftRef,
} from './types.js';

const LOOM_STATUSES: readonly LoomContentStatus[] = [
  'draft',
  'generating',
  'review',
  'ready_for_publish',
  'rejected',
  'revising',
  'discarded',
];

/** Loose wire view; every field arrives optional/unknown from the upstream. */
interface WireContentProduct {
  content_id?: unknown;
  final_id?: unknown;
  goal?: unknown;
  platform?: unknown;
  body?: unknown;
  status?: unknown;
  published_url?: unknown;
  quality_score?: unknown;
}

/** Loose view of the POST /api/fcw/assemble response (fcw_view). */
interface WireFinalWhitelist {
  final_id?: unknown;
}

export interface HttpLoomClientDeps {
  /** Self-hosted loom base URL, no trailing slash (e.g. http://127.0.0.1:8000). */
  baseUrl: string;
  /** Required by the GET wire contract (tenant_id query, min_length=1). */
  tenantId: string;
  /** Optional Bearer token; only required when loom staff_auth gate is enabled. */
  token?: string | undefined;
  /** Wire language sent on generate; default 'en'. */
  language?: string | undefined;
  /** Audit actor id fallback; default 'growth-agent'. */
  actorId?: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

export class HttpLoomClient implements LoomClient {
  readonly name = 'loom-http';
  readonly mode = 'online' as const;

  private readonly baseUrl: string;
  private readonly tenantId: string;
  private readonly token?: string | undefined;
  private readonly language: string;
  private readonly actorId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;

  constructor(deps: HttpLoomClientDeps) {
    if (deps.baseUrl === '' || deps.tenantId === '') {
      throw GrowthAgentErrors.credentialMissing(
        'GA_LOOM_MODE=online requires GA_LOOM_URL and GA_LOOM_TENANT_ID',
      );
    }
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.tenantId = deps.tenantId;
    this.token = deps.token || undefined;
    this.language = deps.language ?? 'en';
    this.actorId = deps.actorId ?? 'growth-agent';
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.baseBackoffMs = deps.baseBackoffMs ?? 200;
  }

  async issueFinal(input: LoomFinalIssueInput): Promise<string> {
    if (input.productSpaceId === '' || input.platform === '' || input.slotId === '' || input.goal === '') {
      throw GrowthAgentErrors.validation(
        'issueFinal: productSpaceId, platform, slotId and goal are required',
      );
    }
    const body: Record<string, unknown> = {
      product_space_id: input.productSpaceId,
      platform: input.platform,
      slot_id: input.slotId,
      goal: input.goal,
      actor: { id: this.actorId, roles: ['operations'] },
    };
    if (input.country !== undefined && input.country !== '') body.country = input.country;
    if (input.pwsId !== undefined && input.pwsId !== '') body.pws_id = input.pwsId;

    try {
      const view = await this.withRetry(() =>
        this.request<WireFinalWhitelist>('POST', '/api/fcw/assemble', body),
      );
      const finalId = String(view.final_id ?? '');
      if (finalId === '') {
        throw GrowthAgentErrors.validation('loom assemble returned no final_id');
      }
      return finalId;
    } catch (err) {
      // 409 DuplicateIssuance (same pws+pwc+platform+slot+country) is idempotent:
      // reuse the already-issued final_id instead of failing the draft.
      const reused = reuseIssuedFinalId(err);
      if (reused !== null) return reused;
      throw err;
    }
  }

  async submitTopicDraft(input: LoomTopicDraftInput): Promise<LoomTopicDraftRef> {
    if (input.finalId === '') {
      throw GrowthAgentErrors.validation('submitTopicDraft: finalId is required');
    }
    const view = await this.withRetry(() =>
      this.request<WireContentProduct>('POST', '/api/content/generate', {
        final_id: input.finalId,
        kind: 'article',
        language: input.language ?? this.language,
        actor: { id: input.taskId || this.actorId, roles: ['operations'] },
      }),
    );
    return {
      contentId: String(view.content_id ?? ''),
      finalId: String(view.final_id ?? input.finalId),
      status: toStatus(view.status),
    };
  }

  async getContent(contentId: string): Promise<LoomContent> {
    const view = await this.withRetry(() =>
      this.request<WireContentProduct>(
        'GET',
        `/api/content/${encodeURIComponent(contentId)}?tenant_id=${encodeURIComponent(this.tenantId)}`,
      ),
    );
    return {
      contentId: String(view.content_id ?? contentId),
      finalId: String(view.final_id ?? ''),
      status: toStatus(view.status),
      goal: String(view.goal ?? ''),
      platform: String(view.platform ?? ''),
      body: typeof view.body === 'string' ? view.body : null,
      publishedUrl: typeof view.published_url === 'string' ? view.published_url : null,
      qualityScore: typeof view.quality_score === 'number' ? view.quality_score : null,
    };
  }

  async getReviewStatus(contentId: string): Promise<LoomContentStatus> {
    return (await this.getContent(contentId)).status;
  }

  /** Retry only retryable GrowthAgentErrors (429/5xx/502/network); 4xx fail. */
  private async withRetry<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        if (!(err instanceof GrowthAgentError) || !err.retryable) throw err;
        await this.sleepImpl(this.baseBackoffMs * 2 ** (attempt - 1));
        if (attempt >= this.maxAttempts) throw err;
      }
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: ctrl.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw GrowthAgentErrors.upstreamUnavailable(
        `loom ${method} ${path} unreachable: ${err instanceof Error ? err.message : 'network error'}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (response.ok) return parsed as T;
    // FastAPI error envelope: {"detail": "..."} (422 detail is a list).
    const detail = parsed.detail;
    const where = `loom ${method} ${path} returned HTTP ${response.status}`;

    if (response.status === 404) {
      throw GrowthAgentErrors.notFound(typeof detail === 'string' ? detail : `loom content (${where})`);
    }
    if (response.status === 401 || response.status === 403) {
      throw GrowthAgentErrors.credentialMissing(
        typeof detail === 'string' ? `loom rejected our credentials: ${detail}` : where,
      );
    }
    if (response.status === 409) {
      throw GrowthAgentErrors.invalidTransition(
        typeof detail === 'string' ? `loom state conflict: ${detail}` : where,
      );
    }
    if (response.status === 422) {
      throw GrowthAgentErrors.validation(where, parsed);
    }
    if (response.status === 429 || response.status >= 500) {
      throw GrowthAgentErrors.upstreamUnavailable(where, parsed);
    }
    throw GrowthAgentErrors.validation(where, parsed);
  }
}

function toStatus(raw: unknown): LoomContentStatus {
  if (typeof raw === 'string' && (LOOM_STATUSES as readonly string[]).includes(raw)) {
    return raw as LoomContentStatus;
  }
  throw GrowthAgentErrors.validation(`loom returned unknown content status: ${String(raw)}`);
}

/**
 * Recover the already-issued final_id from a 409 DuplicateIssuance. loom's router
 * maps it to `detail: "FCW already issued: <final_id>"`, which the request() 409
 * branch turns into an INVALID_TRANSITION error message `loom state conflict: ...`.
 * Returns null for any other error (guards-failed 409, 4xx/5xx, network).
 */
function reuseIssuedFinalId(err: unknown): string | null {
  if (!(err instanceof GrowthAgentError)) return null;
  if (err.code !== 'INVALID_TRANSITION') return null;
  const match = /FCW already issued:\s*(\S+)/.exec(err.message);
  return match?.[1] ?? null;
}
