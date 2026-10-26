// CostRecorder wraps every external call so the daily script cannot forget
// the §11.1 ledger row. The wrapped operation returns the data plus a unit
// count; failures are also recorded (zero units/cost, upstream status) so a
// failing day is visible in the report. The throw is always re-raised — the
// ledger is an audit side effect, never a retry/swallow layer.

import { GrowthAgentError } from '../errors.js';
import type { ApiCallRepository } from './api-call-repository.js';
import type { Pricing } from './pricing.js';

export interface CallMeta {
  provider: string;
  method: string;
  endpoint: string;
  taskId?: string;
  cached?: boolean;
}

export interface CallResult<T> {
  data: T;
  /** Units returned (rows / tokens / requests); defaults to 1. */
  units?: number;
  httpStatus?: number;
}

export class CostRecorder {
  constructor(
    private readonly repo: ApiCallRepository,
    private readonly pricing: Pricing,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async measure<T>(
    meta: CallMeta,
    fn: () => Promise<CallResult<T>>,
  ): Promise<T> {
    try {
      const result = await fn();
      const units = result.units ?? 1;
      await this.repo.record({
        provider: meta.provider,
        method: meta.method,
        endpoint: meta.endpoint,
        ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
        units,
        costMicros: this.pricing.estimate(meta.provider, units),
        ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        ...(meta.cached !== undefined ? { cached: meta.cached } : {}),
        createdAt: this.now(),
      });
      return result.data;
    } catch (err) {
      await this.repo.record({
        provider: meta.provider,
        method: meta.method,
        endpoint: meta.endpoint,
        ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
        units: 0,
        costMicros: 0,
        ...(err instanceof GrowthAgentError && typeof err.status === 'number'
          ? { httpStatus: err.status }
          : {}),
        cached: meta.cached ?? false,
        createdAt: this.now(),
      });
      throw err;
    }
  }
}
