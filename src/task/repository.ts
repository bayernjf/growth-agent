// GrowthTask persistence (dialect-agnostic; JSON serialized at the edge).
// Business SQL uses `?` placeholders; the postgres driver rewrites them to
// $1..$n. State-machine legality lives in state-machine.ts, not here.

import type { StorageDriver } from '../storage/driver.js';
import type {
  GrowthTask,
  GrowthTaskContext,
  GrowthTaskCreateInput,
  GrowthTaskStatus,
  GrowthTaskType,
  PrRef,
  QaResult,
  VerifyCheck,
  VerifyResult,
} from './types.js';

interface GrowthTaskRow {
  id: string;
  site_id: string;
  task_type: string;
  signal_id: string | null;
  zeus_decision_id: string | null;
  loom_content_id: string | null;
  pr_ref: string | null;
  status: string;
  qa_result: string | null;
  verify_result: string | null;
  verify_checks: string | null;
  context: string | null;
  qa_revision_count: number;
  cost_micros_total: number;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, site_id, task_type, signal_id, zeus_decision_id, loom_content_id, pr_ref,' +
  ' status, qa_result, verify_result, verify_checks, context, qa_revision_count,' +
  ' cost_micros_total, idempotency_key, created_at, updated_at';

/**
 * JSON columns come back as TEXT from sqlite but as already-parsed objects
 * from postgres JSONB (node-pg runs its own type parsers, and this driver
 * installs no override). Accept both so the mapping is dialect-agnostic.
 */
function parseJsonColumn<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** Partial mutable fields; the orchestrator writes each as upstream replies arrive. */
export interface GrowthTaskPatch {
  zeusDecisionId?: string;
  loomContentId?: string;
  prRef?: PrRef;
  qaResult?: QaResult;
  verifyResult?: VerifyResult;
  verifyChecks?: VerifyCheck[];
  costMicrosTotal?: number;
  qaRevisionCount?: number;
  /** Whole-value replace; the sweep adds publishedUrl once a PR is open. */
  context?: GrowthTaskContext;
}

export class GrowthTaskRepository {
  constructor(private readonly driver: StorageDriver) {}

  async create(input: GrowthTaskCreateInput, now: string): Promise<GrowthTask> {
    const task: GrowthTask = {
      id: input.id,
      siteId: input.siteId,
      type: input.type,
      ...(input.signalId !== undefined ? { signalId: input.signalId } : {}),
      status: input.status ?? 'signaled',
      qaRevisionCount: 0,
      costMicrosTotal: input.costMicrosTotal ?? 0,
      idempotencyKey: `gt:${input.id}`,
      createdAt: now,
      updatedAt: now,
    };
    if (input.context !== undefined) task.context = input.context;
    await this.driver.run(
      `INSERT INTO growth_tasks
        (id, site_id, task_type, signal_id, zeus_decision_id, loom_content_id,
         pr_ref, status, qa_result, verify_result, context, qa_revision_count,
         cost_micros_total, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.siteId,
        task.type,
        task.signalId ?? null,
        null,
        null,
        null,
        task.status,
        null,
        null,
        task.context !== undefined ? JSON.stringify(task.context) : null,
        task.qaRevisionCount,
        task.costMicrosTotal,
        task.idempotencyKey,
        task.createdAt,
        task.updatedAt,
      ],
    );
    return task;
  }

  async get(id: string): Promise<GrowthTask | undefined> {
    const row = await this.driver.get<GrowthTaskRow>(
      `SELECT ${COLUMNS} FROM growth_tasks WHERE id = ?`,
      [id],
    );
    return row ? this.map(row) : undefined;
  }

  /** Resolve the local task a zeus decision event refers to (§2.2). */
  async findByZeusDecisionId(decisionId: string): Promise<GrowthTask | undefined> {
    const row = await this.driver.get<GrowthTaskRow>(
      `SELECT ${COLUMNS} FROM growth_tasks WHERE zeus_decision_id = ? LIMIT 1`,
      [decisionId],
    );
    return row ? this.map(row) : undefined;
  }

  /**
   * Resolve the local task linked to a GitHub PR number (§6.1 inbound
   * writeback). pr_ref is stored as JSON with dialect-specific extraction
   * syntax; the task volume is tiny (one write + one fix per day hard cap),
   * so lifecycle rows are read and filtered in JS instead of embedding
   * sqlite json_extract / postgres ->> differences in the SQL.
   */
  async findByPrNumber(prNumber: number): Promise<GrowthTask | undefined> {
    const statuses: GrowthTaskStatus[] = [
      'pr_opened',
      'awaiting_merge',
      'merged',
      'verifying',
      'cancelled',
    ];
    for (const status of statuses) {
      const rows = await this.driver.all<GrowthTaskRow>(
        `SELECT ${COLUMNS} FROM growth_tasks WHERE status = ? ORDER BY updated_at DESC`,
        [status],
      );
      for (const row of rows) {
        if (row.pr_ref === null) continue;
        const parsed = parseJsonColumn<Partial<PrRef>>(row.pr_ref);
        if (parsed?.number === prNumber) return this.map(row);
      }
    }
    return undefined;
  }

  async list(status?: GrowthTaskStatus): Promise<GrowthTask[]> {
    const rows =
      status === undefined
        ? await this.driver.all<GrowthTaskRow>(
            `SELECT ${COLUMNS} FROM growth_tasks ORDER BY created_at ASC`,
          )
        : await this.driver.all<GrowthTaskRow>(
            `SELECT ${COLUMNS} FROM growth_tasks WHERE status = ? ORDER BY created_at ASC`,
            [status],
          );
    return rows.map((r) => this.map(r));
  }

  /** Persist a verified transition; returns rows changed (0 = task vanished). */
  async setStatus(id: string, status: GrowthTaskStatus, now: string): Promise<number> {
    const result = await this.driver.run(
      'UPDATE growth_tasks SET status = ?, updated_at = ? WHERE id = ?',
      [status, now, id],
    );
    return result.changes;
  }

  /** Apply partial mutable fields (JSON snapshots stringified at the edge). */
  async patch(id: string, patch: GrowthTaskPatch, now: string): Promise<number> {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.zeusDecisionId !== undefined) {
      sets.push('zeus_decision_id = ?');
      params.push(patch.zeusDecisionId);
    }
    if (patch.loomContentId !== undefined) {
      sets.push('loom_content_id = ?');
      params.push(patch.loomContentId);
    }
    if (patch.prRef !== undefined) {
      sets.push('pr_ref = ?');
      params.push(JSON.stringify(patch.prRef));
    }
    if (patch.qaResult !== undefined) {
      sets.push('qa_result = ?');
      params.push(JSON.stringify(patch.qaResult));
    }
    if (patch.verifyResult !== undefined) {
      sets.push('verify_result = ?');
      params.push(JSON.stringify(patch.verifyResult));
    }
    if (patch.verifyChecks !== undefined) {
      sets.push('verify_checks = ?');
      params.push(JSON.stringify(patch.verifyChecks));
    }
    if (patch.costMicrosTotal !== undefined) {
      sets.push('cost_micros_total = ?');
      params.push(patch.costMicrosTotal);
    }
    if (patch.qaRevisionCount !== undefined) {
      sets.push('qa_revision_count = ?');
      params.push(patch.qaRevisionCount);
    }
    if (patch.context !== undefined) {
      sets.push('context = ?');
      params.push(JSON.stringify(patch.context));
    }
    if (sets.length === 1) return 0;
    params.push(id);
    const result = await this.driver.run(
      `UPDATE growth_tasks SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
    return result.changes;
  }

  private map(row: GrowthTaskRow): GrowthTask {
    const task: GrowthTask = {
      id: row.id,
      siteId: row.site_id,
      type: row.task_type as GrowthTaskType,
      status: row.status as GrowthTaskStatus,
      qaRevisionCount: row.qa_revision_count,
      costMicrosTotal: row.cost_micros_total,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.signal_id !== null) task.signalId = row.signal_id;
    if (row.zeus_decision_id !== null) task.zeusDecisionId = row.zeus_decision_id;
    if (row.loom_content_id !== null) task.loomContentId = row.loom_content_id;
    const prRef = parseJsonColumn<PrRef>(row.pr_ref);
    if (prRef !== undefined) task.prRef = prRef;
    const qaResult = parseJsonColumn<QaResult>(row.qa_result);
    if (qaResult !== undefined) task.qaResult = qaResult;
    const verifyResult = parseJsonColumn<VerifyResult>(row.verify_result);
    if (verifyResult !== undefined) task.verifyResult = verifyResult;
    const verifyChecks = parseJsonColumn<VerifyCheck[]>(row.verify_checks);
    if (verifyChecks !== undefined) task.verifyChecks = verifyChecks;
    const context = parseJsonColumn<GrowthTaskContext>(row.context);
    if (context !== undefined) task.context = context;
    return task;
  }
}
