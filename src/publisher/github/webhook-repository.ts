// Persistence for inbound GitHub pull_request webhooks (migration 004,
// design §4.3/§6.1/§9). One row per (PR number, action) for at-least-once
// idempotency and audit. GitHub channel failures are aggregated in the
// existing channel_failures table (migration 002) under
// channel='github_webhook'.

import type { StorageDriver } from '../../storage/driver.js';

export type GithubDeliveryResult = 'accepted' | 'rejected' | 'ignored';

export interface GithubDeliveryRow {
  id: string;
  prNumber: number;
  eventType: string;
  action: string;
  taskId?: string;
  signatureValid: boolean;
  processingResult: GithubDeliveryResult;
  errorCode?: string;
  eventPayload?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryDbRow {
  id: string;
  pr_number: number;
  event_type: string;
  action: string;
  task_id: string | null;
  signature_valid: number | boolean;
  processing_result: string;
  error_code: string | null;
  event_payload: string | null;
  created_at: string;
  updated_at: string;
}

/** Deterministic idempotency key for one (PR number, action) delivery. */
/**
 * Deterministic ledger id. Lifecycle actions (opened, closed-merged, ...)
 * are unique per (PR, action); repeatable audit actions (synchronize,
 * edited, ...) append a per-event key — the push head SHA, falling back to
 * the GitHub delivery GUID — so redelivery dedupes while genuine pushes
 * are recorded individually (PRD §8.1 indicator 3).
 */
export function githubDeliveryId(prNumber: number, action: string, repeatKey?: string): string {
  return repeatKey !== undefined
    ? `gh:${prNumber}:${action}:${repeatKey}`
    : `gh:${prNumber}:${action}`;
}

export class GithubWebhookRepository {
  constructor(private readonly driver: StorageDriver) {}

  async find(id: string): Promise<GithubDeliveryRow | undefined> {
    const row = await this.driver.get<DeliveryDbRow>(
      'SELECT * FROM github_webhook_deliveries WHERE id = ?',
      [id],
    );
    return row ? this.map(row) : undefined;
  }

  /** Deliveries recorded in the inclusive timestamp range [from, to). */
  async list(from: string, to: string): Promise<GithubDeliveryRow[]> {
    const rows = await this.driver.all<DeliveryDbRow>(
      `SELECT * FROM github_webhook_deliveries
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`,
      [from, to],
    );
    return rows.map(r => this.map(r));
  }

  /** Insert once; ON CONFLICT DO NOTHING makes a raced duplicate a no-op. */
  async record(row: GithubDeliveryRow): Promise<void> {
    await this.driver.run(
      `INSERT INTO github_webhook_deliveries
         (id, pr_number, event_type, action, task_id, signature_valid,
          processing_result, error_code, event_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        row.id,
        row.prNumber,
        row.eventType,
        row.action,
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

  private map(row: DeliveryDbRow): GithubDeliveryRow {
    const out: GithubDeliveryRow = {
      id: row.id,
      prNumber: row.pr_number,
      eventType: row.event_type,
      action: row.action,
      signatureValid:
        typeof row.signature_valid === 'boolean'
          ? row.signature_valid
          : row.signature_valid === 1,
      processingResult: row.processing_result as GithubDeliveryResult,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.task_id !== null) out.taskId = row.task_id;
    if (row.error_code !== null) out.errorCode = row.error_code;
    if (row.event_payload !== null) out.eventPayload = JSON.parse(row.event_payload) as unknown;
    return out;
  }
}
