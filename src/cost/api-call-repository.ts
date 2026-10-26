// api_calls ledger (design §11.1). The table ships in migration 001; this
// repository records every billable external call (GSC/SERP/zeus/LLM) and
// aggregates the §11.2 daily/weekly unit-economics numbers.
//
// Business SQL uses `?` placeholders (rewritten to $n on postgres). Rows are
// append-only; the ledger is never mutated.

import { randomUUID } from 'node:crypto';
import type { StorageDriver } from '../storage/driver.js';

export interface ApiCallInput {
  /** gsc | serp:<vendor> | llm | zeus | github ... */
  provider: string;
  /** HTTP verb (GET/POST/PATCH/PUT). */
  method: string;
  /** Logical endpoint name (e.g. searchanalytics, serp, decisions). */
  endpoint: string;
  /** Owning GrowthTask id; null for monitoring calls (snapshot, rankTrack). */
  taskId?: string;
  /** Rows returned / tokens / request count (§11.1 "units"). */
  units: number;
  /** Estimated cost in micros; 0 when the call failed or rates are zero. */
  costMicros: number;
  /** Upstream HTTP status; null for in-process/offline calls. */
  httpStatus?: number;
  /** Whether the response came from a cache rather than a billed call. */
  cached?: boolean;
  /** ISO timestamp of the call. */
  createdAt: string;
}

interface ApiCallDbRow {
  id: string;
  provider: string;
  method: string;
  endpoint: string;
  task_id: string | null;
  units: number;
  cost_micros: number;
  http_status: number | null;
  cached: number | boolean;
  created_at: string;
}

export interface ProviderCostRow {
  provider: string;
  calls: number;
  units: number;
  costMicros: number;
}

export interface RangeCost {
  calls: number;
  units: number;
  costMicros: number;
}

export class ApiCallRepository {
  constructor(private readonly driver: StorageDriver) {}

  async record(input: ApiCallInput): Promise<void> {
    await this.driver.run(
      `INSERT INTO api_calls
         (id, provider, method, endpoint, task_id, units, cost_micros,
          http_status, cached, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `ac_${randomUUID()}`,
        input.provider,
        input.method,
        input.endpoint,
        input.taskId ?? null,
        input.units,
        input.costMicros,
        input.httpStatus ?? null,
        this.driver.dialect === 'postgres' ? input.cached ?? false : input.cached ? 1 : 0,
        input.createdAt,
      ],
    );
  }

  /** Total cost over an inclusive ISO-date range [from, to]. */
  async rangeCost(from: string, to: string): Promise<RangeCost> {
    const row = await this.driver.get<{ calls: number; units: number; cost: number | null }>(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(units), 0) AS units,
              COALESCE(SUM(cost_micros), 0) AS cost
       FROM api_calls
       WHERE created_at >= ? AND created_at < ?`,
      [from, to],
    );
    return {
      calls: row?.calls ?? 0,
      units: row?.units ?? 0,
      costMicros: row?.cost ?? 0,
    };
  }

  /** Per-provider cost split over an inclusive ISO-date range. */
  async costByProvider(from: string, to: string): Promise<ProviderCostRow[]> {
    const rows = await this.driver.all<
      Pick<ApiCallDbRow, 'provider'> & { calls: number; units: number; cost: number | null }
    >(
      `SELECT provider,
              COUNT(*) AS calls,
              COALESCE(SUM(units), 0) AS units,
              COALESCE(SUM(cost_micros), 0) AS cost
       FROM api_calls
       WHERE created_at >= ? AND created_at < ?
       GROUP BY provider
       ORDER BY cost DESC, provider ASC`,
      [from, to],
    );
    return rows.map(r => ({
      provider: r.provider,
      calls: r.calls,
      units: r.units,
      costMicros: r.cost ?? 0,
    }));
  }

  async list(from: string, to: string): Promise<ApiCallInput[]> {
    const rows = await this.driver.all<ApiCallDbRow>(
      `SELECT * FROM api_calls
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`,
      [from, to],
    );
    return rows.map(r => this.map(r));
  }

  private map(row: ApiCallDbRow): ApiCallInput {
    const out: ApiCallInput = {
      provider: row.provider,
      method: row.method,
      endpoint: row.endpoint,
      units: row.units,
      costMicros: row.cost_micros,
      createdAt: row.created_at,
    };
    if (row.task_id !== null) out.taskId = row.task_id;
    if (row.http_status !== null) out.httpStatus = row.http_status;
    out.cached =
      typeof row.cached === 'boolean' ? row.cached : row.cached === 1;
    return out;
  }
}
