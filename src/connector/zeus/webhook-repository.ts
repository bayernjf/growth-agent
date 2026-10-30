// Persistence for the inbound zeus decision webhook (design §2.2, §6.1, §9).
// Two ledger tables (migration 002):
//   zeus_webhook_deliveries — append-per-delivery-id audit + at-least-once dedupe.
//   channel_failures       — per (channel, reason) aggregate for §9 weekly reports.
// Business SQL uses `?` placeholders; the postgres driver rewrites them to $1..$n.
// ON CONFLICT upserts are ANSI-shaped and work on both dialects.

import type { StorageDriver } from '../../storage/driver.js';
import type { DecisionEventType } from './inbound.js';

export type DeliveryProcessingResult = 'accepted' | 'rejected';

export interface WebhookDeliveryRow {
  deliveryId: string;
  decisionId: string;
  eventType: DecisionEventType;
  taskId?: string;
  signatureValid: boolean;
  processingResult: DeliveryProcessingResult;
  errorCode?: string;
  eventPayload?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryDbRow {
  delivery_id: string;
  decision_id: string;
  event_type: string;
  task_id: string | null;
  signature_valid: number | boolean;
  processing_result: string;
  error_code: string | null;
  event_payload: string | null;
  created_at: string;
  updated_at: string;
}

export class WebhookDeliveryRepository {
  constructor(private readonly driver: StorageDriver) {}

  async find(deliveryId: string): Promise<WebhookDeliveryRow | undefined> {
    const row = await this.driver.get<DeliveryDbRow>(
      'SELECT * FROM zeus_webhook_deliveries WHERE delivery_id = ?',
      [deliveryId],
    );
    return row ? this.map(row) : undefined;
  }

  /** Deliveries recorded in the inclusive timestamp range [from, to). */
  async list(from: string, to: string): Promise<WebhookDeliveryRow[]> {
    const rows = await this.driver.all<DeliveryDbRow>(
      `SELECT * FROM zeus_webhook_deliveries
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`,
      [from, to],
    );
    return rows.map(r => this.map(r));
  }

  /**
   * Durably record one signed delivery. A pre-check `find()` already decided
   * dedupe, so this is an INSERT; ON CONFLICT DO NOTHING makes a race-safe
   * second write a no-op instead of a 500.
   */
  async record(row: WebhookDeliveryRow): Promise<void> {
    await this.driver.run(
      `INSERT INTO zeus_webhook_deliveries
         (delivery_id, decision_id, event_type, task_id, signature_valid,
          processing_result, error_code, event_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(delivery_id) DO NOTHING`,
      [
        row.deliveryId,
        row.decisionId,
        row.eventType,
        row.taskId ?? null,
        this.driver.dialect === 'postgres' ? row.signatureValid : row.signatureValid ? 1 : 0,
        row.processingResult,
        row.errorCode ?? null,
        row.eventPayload === undefined ? null : JSON.stringify(row.eventPayload),
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  private map(row: DeliveryDbRow): WebhookDeliveryRow {
    const out: WebhookDeliveryRow = {
      deliveryId: row.delivery_id,
      decisionId: row.decision_id,
      eventType: row.event_type as DecisionEventType,
      signatureValid:
        typeof row.signature_valid === 'boolean' ? row.signature_valid : row.signature_valid === 1,
      processingResult: row.processing_result as DeliveryProcessingResult,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.task_id !== null) out.taskId = row.task_id;
    if (row.error_code !== null) out.errorCode = row.error_code;
    if (row.event_payload !== null) out.eventPayload = JSON.parse(row.event_payload) as unknown;
    return out;
  }
}

export interface ChannelFailureInput {
  channel: string;
  reason: string;
  externalRef?: string;
  retryable: boolean;
  /** Sanitized human message; must never contain the HMAC secret. */
  lastError?: string;
  now: string;
}

export interface ChannelFailureRow {
  id: string;
  channel: string;
  reason: string;
  externalRef?: string;
  retryable: boolean;
  attempts: number;
  lastError?: string;
  createdAt: string;
  lastAt: string;
}

interface ChannelFailureDbRow {
  id: string;
  channel: string;
  reason: string;
  external_ref: string | null;
  retryable: number | boolean;
  attempts: number;
  last_error: string | null;
  created_at: string;
  last_at: string;
}

/**
 * Channel-failure ledger (§9). Failures aggregate per (channel, reason) with a
 * deterministic id `cf:<channel>:<reason>` so repeated occurrences increment
 * `attempts` instead of piling rows — the weekly report reads "channel X
 * failed N times" from one row per reason.
 */
export class ChannelFailureRepository {
  constructor(private readonly driver: StorageDriver) {}

  async upsert(input: ChannelFailureInput): Promise<ChannelFailureRow> {
    const id = `cf:${input.channel}:${input.reason}`;
    await this.driver.run(
      `INSERT INTO channel_failures
         (id, channel, external_ref, reason, retryable, attempts, last_error, created_at, last_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         external_ref = excluded.external_ref,
         retryable = excluded.retryable,
         attempts = channel_failures.attempts + 1,
         last_error = excluded.last_error,
         last_at = excluded.last_at`,
      [
        id,
        input.channel,
        input.externalRef ?? null,
        input.reason,
        this.driver.dialect === 'postgres' ? input.retryable : input.retryable ? 1 : 0,
        input.lastError ?? null,
        input.now,
        input.now,
      ],
    );
    const row = await this.driver.get<ChannelFailureDbRow>(
      'SELECT * FROM channel_failures WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`channel_failures upsert did not persist row ${id}`);
    return this.map(row);
  }

  async get(id: string): Promise<ChannelFailureRow | undefined> {
    const row = await this.driver.get<ChannelFailureDbRow>(
      'SELECT * FROM channel_failures WHERE id = ?',
      [id],
    );
    return row ? this.map(row) : undefined;
  }

  /** All failure aggregates whose latest occurrence is in [from, to). */
  async list(from?: string, to?: string): Promise<ChannelFailureRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (from !== undefined) {
      where.push('last_at >= ?');
      params.push(from);
    }
    if (to !== undefined) {
      where.push('last_at < ?');
      params.push(to);
    }
    const sql =
      'SELECT * FROM channel_failures' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY attempts DESC, last_at DESC';
    const rows = await this.driver.all<ChannelFailureDbRow>(sql, params);
    return rows.map(r => this.map(r));
  }

  private map(row: ChannelFailureDbRow): ChannelFailureRow {
    const out: ChannelFailureRow = {
      id: row.id,
      channel: row.channel,
      reason: row.reason,
      retryable:
        typeof row.retryable === 'boolean' ? row.retryable : row.retryable === 1,
      attempts: row.attempts,
      createdAt: row.created_at,
      lastAt: row.last_at,
    };
    if (row.external_ref !== null) out.externalRef = row.external_ref;
    if (row.last_error !== null) out.lastError = row.last_error;
    return out;
  }
}

/**
 * Replay defense for v2 webhooks (migration 008): one row per nonce accepted
 * inside the freshness window. Business idempotency stays with the
 * delivery-id ledger; this only stops a captured signed request being replayed.
 */
export class WebhookNonceRepository {
  /** Rows older than this on every consume are pruned (generous: 24h). */
  private static readonly RETENTION_MS = 24 * 60 * 60 * 1000;

  constructor(private readonly driver: StorageDriver) {}

  /**
   * Atomically claim a nonce. Returns false when it was already consumed.
   * Pruning is best-effort and never blocks acceptance.
   */
  async consume(nonce: string, nowIso: string): Promise<boolean> {
    const pruneBefore = new Date(Date.parse(nowIso) - WebhookNonceRepository.RETENTION_MS).toISOString();
    await this.driver.run('DELETE FROM zeus_webhook_nonces WHERE seen_at < ?', [pruneBefore]);
    const result = await this.driver.run(
      'INSERT INTO zeus_webhook_nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING',
      [nonce, nowIso],
    );
    return result.changes > 0;
  }
}
