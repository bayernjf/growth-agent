// Outbound alerts for the continuity loop (2026-11-08 handoff, P0).
//
// `batch health` already exits 1 on a gap and a failed batch run already exits
// 1, but both alarms only reach `docker compose logs` or whoever is staring at
// `docker compose ps`. If nobody looks, a broken loop stays invisible — which
// defeats the point of the 30-day continuity claim.
//
// This module adds one outbound channel and nothing else:
//   - a webhook POST (generic JSON, or Feishu's text shape);
//   - deduplication: the same key inside a cooldown window is dropped, so an
//     hourly tick cannot turn one gap into twenty-four messages;
//   - bounded retries with backoff, and never throw — an alert failure must
//     not turn a green run red or mask the original error;
//   - it never changes the process exit code. The exit code stays the source
//     of truth; the webhook is a courtesy delivery channel.
//
// Config is optional: with no `GA_ALERT_WEBHOOK_URL` the module is inert.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type AlertKind = 'run_failed' | 'coverage_gap' | 'coverage_empty';

export interface AlertEvent {
  kind: AlertKind;
  /** Short headline, e.g. `growth-agent health GAP`. */
  title: string;
  /** One-line detail, usually `formatCoverage(...)` or a failure reason. */
  detail: string;
  /**
   * Same key inside the cooldown window is dropped. Use a day-scoped key for
   * coverage (`coverage_gap:2026-11-06`) so one missing day alerts once.
   */
  dedupeKey: string;
}

export type AlertFormat = 'generic' | 'feishu';

export interface NotifyOptions {
  /** Undefined or empty disables delivery entirely. */
  webhookUrl?: string | undefined;
  /** `generic` (default) posts `{ text, ... }`; `feishu` posts its text card. */
  format?: AlertFormat | undefined;
  /** Optional Bearer token. Never logged. */
  token?: string | undefined;
  /** Where the dedupe state is persisted. */
  statePath: string;
  now?: (() => Date) | undefined;
  /** Default 6h: long enough to collapse an hourly tick, short enough to repeat tomorrow. */
  cooldownMs?: number | undefined;
  /** Extra attempts after the first one (default 2 → 3 total). */
  retries?: number | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Non-fatal notes (state write failures); defaults to stderr. */
  warn?: ((message: string) => void) | undefined;
}

export type NotifyOutcome =
  | { status: 'sent'; attempts: number }
  | { status: 'disabled' }
  | { status: 'deduped'; lastSentAt: string }
  | { status: 'failed'; attempts: number; error: string };

const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Dedupe state lives next to the run ledger, inside the reports volume. */
export function alertStatePath(reportDir: string): string {
  return `${reportDir.replace(/\/+$/, '')}/alert-state.json`;
}

type AlertState = Record<string, string>;

function readState(statePath: string): AlertState {
  if (!existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const state: AlertState = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') state[key] = value;
    }
    return state;
  } catch {
    // A corrupt state file must not block an alert: start clean.
    return {};
  }
}

function writeState(statePath: string, state: AlertState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Exported so the wire shape is testable without a network call. */
export function buildAlertBody(
  event: AlertEvent,
  format: AlertFormat,
  sentAt: string,
): string {
  const text = `[growth-agent] ${event.title}\n${event.detail}\n(${sentAt})`;
  const envelope =
    format === 'feishu'
      ? { msg_type: 'text', content: { text } }
      : { text, source: 'growth-agent', kind: event.kind, dedupeKey: event.dedupeKey, ts: sentAt };
  return JSON.stringify(envelope);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deliver one alert. Returns what happened instead of throwing: callers log
 * the outcome and keep their own exit code.
 */
export async function notifyAlert(
  event: AlertEvent,
  options: NotifyOptions,
): Promise<NotifyOutcome> {
  const url = options.webhookUrl;
  if (url === undefined || url.trim() === '') return { status: 'disabled' };

  const now = options.now ?? (() => new Date());
  const format: AlertFormat = options.format ?? 'generic';
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const retries = Math.max(0, Math.trunc(options.retries ?? DEFAULT_RETRIES));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const warn =
    options.warn ??
    ((message: string) => {
      process.stderr.write(`batch: ${message}\n`);
    });

  const state = readState(options.statePath);
  const lastSentAt = state[event.dedupeKey];
  if (lastSentAt !== undefined) {
    const lastMs = Date.parse(lastSentAt);
    if (Number.isFinite(lastMs) && now().getTime() - lastMs < cooldownMs) {
      return { status: 'deduped', lastSentAt };
    }
  }

  const sentAt = now().toISOString();
  const body = buildAlertBody(event, format, sentAt);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined && options.token !== '') {
    headers.authorization = `Bearer ${options.token}`;
  }

  let attempts = 0;
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    attempts = attempt + 1;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        // Record only on a confirmed delivery, so a 500 does not suppress the
        // alert that the next tick should retry.
        state[event.dedupeKey] = sentAt;
        try {
          writeState(options.statePath, state);
        } catch (error) {
          warn(`alert state not written (${errorMessage(error)})`);
        }
        return { status: 'sent', attempts };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (attempt < retries) await sleep(1_000 * 2 ** attempt);
  }

  return { status: 'failed', attempts, error: lastError };
}
