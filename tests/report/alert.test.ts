// Outbound alerts (2026-11-08 handoff P0): the webhook must fire once per
// incident, retry transient failures, and never throw into the batch loop.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  alertStatePath,
  buildAlertBody,
  notifyAlert,
  type AlertEvent,
} from '../../src/report/alert.js';

const EVENT: AlertEvent = {
  kind: 'coverage_gap',
  title: 'growth-agent health GAP',
  detail: 'health: GAP — 2/4 complete days missing',
  dedupeKey: 'coverage_gap:2026-11-06',
};

const BASE_MS = Date.parse('2026-11-08T06:00:00.000Z');

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Sequential fake transport: each call consumes the next status. */
function fakeFetch(statuses: readonly number[], calls: Call[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 500;
    return new Response(null, { status });
  }) as typeof fetch;
}

function bodyOf(call: Call | undefined): Record<string, unknown> | undefined {
  if (call?.init?.body === undefined) return undefined;
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('notifyAlert', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ga-alert-'));
    statePath = alertStatePath(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is inert without a webhook URL', async () => {
    const calls: Call[] = [];
    const outcome = await notifyAlert(EVENT, {
      statePath,
      fetchImpl: fakeFetch([200], calls),
    });
    expect(outcome).toEqual({ status: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('posts the generic envelope and records the dedupe key', async () => {
    const calls: Call[] = [];
    const outcome = await notifyAlert(EVENT, {
      webhookUrl: 'https://example.test/hook',
      statePath,
      now: () => new Date(BASE_MS),
      fetchImpl: fakeFetch([200], calls),
    });

    expect(outcome).toEqual({ status: 'sent', attempts: 1 });
    expect(calls).toHaveLength(1);
    const body = bodyOf(calls[0]);
    expect(body?.kind).toBe('coverage_gap');
    expect(body?.dedupeKey).toBe(EVENT.dedupeKey);
    expect(String(body?.text)).toContain('health: GAP');

    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, string>;
    expect(state[EVENT.dedupeKey]).toBe(new Date(BASE_MS).toISOString());
  });

  it('drops the same key inside the cooldown window', async () => {
    const calls: Call[] = [];
    await writeFile(statePath, JSON.stringify({ [EVENT.dedupeKey]: new Date(BASE_MS).toISOString() }));

    const outcome = await notifyAlert(EVENT, {
      webhookUrl: 'https://example.test/hook',
      statePath,
      cooldownMs: 6 * 60 * 60 * 1000,
      now: () => new Date(BASE_MS + 60 * 60 * 1000),
      fetchImpl: fakeFetch([200], calls),
    });

    expect(outcome).toEqual({
      status: 'deduped',
      lastSentAt: new Date(BASE_MS).toISOString(),
    });
    expect(calls).toHaveLength(0);
  });

  it('sends again once the cooldown has passed', async () => {
    const calls: Call[] = [];
    await writeFile(statePath, JSON.stringify({ [EVENT.dedupeKey]: new Date(BASE_MS).toISOString() }));

    const outcome = await notifyAlert(EVENT, {
      webhookUrl: 'https://example.test/hook',
      statePath,
      cooldownMs: 6 * 60 * 60 * 1000,
      now: () => new Date(BASE_MS + 7 * 60 * 60 * 1000),
      fetchImpl: fakeFetch([200], calls),
    });

    expect(outcome).toEqual({ status: 'sent', attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const outcome = await notifyAlert(EVENT, {
      webhookUrl: 'https://example.test/hook',
      statePath,
      retries: 2,
      now: () => new Date(BASE_MS),
      fetchImpl: fakeFetch([500, 500, 200], calls),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(outcome).toEqual({ status: 'sent', attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('reports failure without throwing and without recording the key', async () => {
    const calls: Call[] = [];
    const outcome = await notifyAlert(EVENT, {
      webhookUrl: 'https://example.test/hook',
      statePath,
      retries: 1,
      now: () => new Date(BASE_MS),
      fetchImpl: fakeFetch([500, 500], calls),
      sleep: async () => {},
    });

    expect(outcome).toEqual({ status: 'failed', attempts: 2, error: 'HTTP 500' });
    // A failed delivery must not suppress the next tick's attempt.
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();
  });

  it('treats a transport error as retryable, not fatal', async () => {
    let calls = 0;
    const outcome = await notifyAlert(EVENT, {
      webhookUrl: 'https://example.test/hook',
      statePath,
      retries: 1,
      now: () => new Date(BASE_MS),
      fetchImpl: (async () => {
        calls += 1;
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
      sleep: async () => {},
    });

    expect(calls).toBe(2);
    expect(outcome).toEqual({ status: 'failed', attempts: 2, error: 'ECONNREFUSED' });
  });

  it('sends a Bearer token when configured', async () => {
    const calls: Call[] = [];
    await notifyAlert(EVENT, {
      webhookUrl: 'https://example.test/hook',
      token: 'secret-token',
      statePath,
      now: () => new Date(BASE_MS),
      fetchImpl: fakeFetch([200], calls),
    });

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer secret-token');
    expect(headers?.['content-type']).toBe('application/json');
  });
});

describe('buildAlertBody', () => {
  it('wraps the text in a Feishu text card', () => {
    const parsed = JSON.parse(
      buildAlertBody(EVENT, 'feishu', '2026-11-08T06:00:00.000Z'),
    ) as {
      msg_type?: string;
      content?: { text?: string };
    };
    expect(parsed.msg_type).toBe('text');
    expect(parsed.content?.text).toContain('growth-agent health GAP');
    expect(parsed.content?.text).toContain('2/4 complete days missing');
  });

  it('keeps a Slack-compatible generic shape', () => {
    const parsed = JSON.parse(
      buildAlertBody(EVENT, 'generic', '2026-11-08T06:00:00.000Z'),
    ) as Record<string, unknown>;
    expect(parsed.source).toBe('growth-agent');
    expect(String(parsed.text)).toContain('growth-agent health GAP');
  });
});
