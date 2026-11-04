// GitHub publisher over the REST API (T-D2, design §4.3).
//
// Zero new dependencies: Node 22 global fetch (no octokit). The bot never
// merges: it only creates a task-scoped branch, writes files and opens a PR
// for a human. `taskId` is the idempotency key — re-running openChange for
// the same task reuses the branch, updates files and patches the existing PR
// instead of opening a second one (dedupe via open-PR lookup by head branch).
//
// Error semantics (§4.3):
//   401                         -> PUBLISH_AUTH (non-retryable)
//   403 (not rate limit)        -> PUBLISH_FORBIDDEN (non-retryable)
//   403 with x-ratelimit-remaining=0, 429, 5xx, network/timeout
//                               -> UPSTREAM_UNAVAILABLE 503 (bounded retry,
//                                  §9: 3 attempts, 200/400/800ms, injectable)
//   404 where an object may be absent -> handled as control flow
//   422 on ref creation         -> re-fetched as a create race
//
// Retry safety: every retried write is content-idempotent (same task branch,
// same file bytes, PR dedupe by head branch), so a dropped response cannot
// materialize a second PR. The token is never logged; only the GitHub API
// shape is used here, verified against the public REST docs and contract
// tests only — no real GitHub call is made in this wave (T-D4 deferred).

import { GrowthAgentError, GrowthAgentErrors } from '../../errors.js';
import { assertSafePublishPath } from './paths.js';
import type {
  ChangeRef,
  ChangeStatus,
  OpenChangeInput,
  PublisherFile,
  SitePublisher,
} from '../types.js';

export interface GitHubPublisherConfig {
  owner: string;
  repo: string;
  /** Personal access token with repo write scope (server-side only). */
  token: string;
  /** Base branch the PR targets (default main). */
  baseBranch?: string;
  /** API root (defaults to https://api.github.com; overridden in tests). */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

interface GitRefResponse {
  ref: string;
  object: { sha: string; type: string };
}

interface ContentsResponse {
  sha: string;
}

interface PullResponse {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  head: { ref: string };
}

const GITHUB_API_VERSION = '2022-11-28';

/** Derive the deterministic branch name for a task (idempotency key). */
export function branchForTask(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `growth-agent/${safe}`;
}

export class GitHubPublisher implements SitePublisher {
  readonly platform = 'github' as const;

  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly baseBranch: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;

  constructor(config: GitHubPublisherConfig) {
    if (!config.token || !config.owner || !config.repo) {
      throw GrowthAgentErrors.credentialMissing(
        'GitHub publisher requires a token and a target owner/repo (per-site config)',
      );
    }
    this.owner = config.owner;
    this.repo = config.repo;
    this.token = config.token;
    this.baseBranch = config.baseBranch ?? 'main';
    this.apiBaseUrl = (config.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = config.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.baseBackoffMs = config.baseBackoffMs ?? 200;
  }

  async openChange(input: OpenChangeInput): Promise<ChangeRef> {
    // F-09: validate every target path BEFORE any network call — a poisoned
    // draft slug must never reach the Contents API with the bot PAT.
    for (const file of input.files) {
      assertSafePublishPath(file.path);
    }

    const branch = branchForTask(input.taskId);
    const base = await this.getRef(`heads/${this.baseBranch}`);
    if (base === undefined) {
      throw GrowthAgentErrors.publishForbidden(
        `base branch ${this.baseBranch} not found in ${this.owner}/${this.repo}`,
      );
    }

    const existingBranch = await this.getRef(`heads/${branch}`);
    if (existingBranch === undefined) {
      await this.createBranch(branch, base.object.sha);
    }

    for (const file of input.files) {
      await this.putFile(branch, file);
    }

    const pull = await this.upsertPullRequest(branch, input.title, input.body);
    return { ref: String(pull.number), url: pull.html_url, number: pull.number };
  }

  async getChangeStatus(ref: string): Promise<ChangeStatus> {
    const pull = await this.request<PullResponse>('GET', `/repos/${this.repoPath}/pulls/${encodeURIComponent(ref)}`);
    if (pull.merged === true) return 'merged';
    return pull.state === 'closed' ? 'closed' : 'open';
  }

  private get repoPath(): string {
    return `${this.owner}/${this.repo}`;
  }

  /** Returns the ref object or undefined on 404 (branch/sha absent). */
  private async getRef(ref: string): Promise<GitRefResponse | undefined> {
    return this.requestOptional<GitRefResponse>(
      'GET',
      `/repos/${this.repoPath}/git/ref/${ref}`,
    );
  }

  private async createBranch(branch: string, sha: string): Promise<void> {
    try {
      await this.request<GitRefResponse>('POST', `/repos/${this.repoPath}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      });
    } catch (err) {
      // A concurrent openChange for the same taskId may have just created it:
      // 422 "reference already exists" -> re-fetch and treat as reuse, never
      // open a duplicate PR.
      if (err instanceof GrowthAgentError && err.status === 422) {
        const racy = await this.getRef(`heads/${branch}`);
        if (racy === undefined) throw err;
        return;
      }
      throw err;
    }
  }

  private async putFile(branch: string, file: PublisherFile): Promise<void> {
    const path = encodeURIComponent(file.path);
    const current = await this.requestOptional<ContentsResponse>(
      'GET',
      `/repos/${this.repoPath}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    );
    await this.request('PUT', `/repos/${this.repoPath}/contents/${path}`, {
      message: `growth-agent: ${file.path}`,
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      branch,
      ...(current !== undefined ? { sha: current.sha } : {}),
    });
  }

  private async upsertPullRequest(
    branch: string,
    title: string,
    body: string,
  ): Promise<PullResponse> {
    const head = `${this.owner}:${branch}`;
    const open = await this.request<PullResponse[]>(
      'GET',
      `/repos/${this.repoPath}/pulls?state=open&head=${encodeURIComponent(head)}`,
    );
    if (open.length > 0) {
      const existing = open[0];
      if (existing === undefined) throw new Error('open PR list returned an undefined row');
      return this.request<PullResponse>(
        'PATCH',
        `/repos/${this.repoPath}/pulls/${existing.number}`,
        { title, body },
      );
    }
    return this.request<PullResponse>('POST', `/repos/${this.repoPath}/pulls`, {
      title,
      head: branch,
      base: this.baseBranch,
      body,
    });
  }

  /** Retry only retryable GrowthAgentErrors; 4xx business rejections propagate. */
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

  /** GET variant that maps a 404 to undefined (ref/object may be absent). */
  private async requestOptional<T>(method: string, path: string): Promise<T | undefined> {
    try {
      return await this.withRetry(() => this.requestRaw<T>(method, path, undefined, true));
    } catch (err) {
      if (err instanceof GrowthAgentError && err.status === 404) return undefined;
      throw err;
    }
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.withRetry(() => this.requestRaw<T>(method, path, body, false));
  }

  private async requestRaw<T>(
    method: string,
    path: string,
    body: unknown,
    allow404: boolean,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent': 'growth-agent',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
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
      throw GrowthAgentErrors.upstreamUnavailable(
        `github ${method} ${path} unreachable: ${err instanceof Error ? err.message : 'network error'}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const parsed = parseJson(text);

    if (response.ok) return parsed as T;
    if (allow404 && response.status === 404) {
      throw GrowthAgentErrors.notFound('github object not found');
    }
    // Rate-limited 403 / 429 / 5xx: bounded retry.
    if (
      response.status === 429 ||
      response.status >= 500 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    ) {
      throw GrowthAgentErrors.upstreamUnavailable(`github returned HTTP ${response.status}`, parsed);
    }
    if (response.status === 401) {
      throw GrowthAgentErrors.publishAuth(
        'github rejected the publisher token (401 unauthorized)',
      );
    }
    if (response.status === 403) {
      throw GrowthAgentErrors.publishForbidden(
        'github token lacks write scope or repository access (403 forbidden)',
      );
    }
    if (response.status === 422) {
      throw new GrowthAgentError('VALIDATION_FAILED', githubErrorMessage(parsed, 'validation rejected'), 422, false, parsed);
    }
    throw new GrowthAgentError(
      'UPSTREAM_HTTP_ERROR',
      githubErrorMessage(parsed, `github returned HTTP ${response.status}`),
      response.status,
      false,
      parsed,
    );
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

function githubErrorMessage(parsed: unknown, fallback: string): string {
  if (parsed !== null && typeof parsed === 'object' && 'message' in parsed) {
    const message = (parsed as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return fallback;
}
