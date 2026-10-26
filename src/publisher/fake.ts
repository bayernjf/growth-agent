// In-memory fake publisher (T-D1 contract tests + fixture script runs).
// Models the §4.3 contract WITHOUT any platform SDK:
//   - openChange keyed by taskId is idempotent (re-open returns the same
//     {ref, url, number} — never a duplicate PR);
//   - getChangeStatus reflects the state the test pins on it.
// The real GitHub adapter (branch + contents API + PR) is T-D2/W6; CMS
// adapters are P1/P2.

import { GrowthAgentErrors } from '../errors.js';
import type {
  ChangeRef,
  ChangeStatus,
  OpenChangeInput,
  SitePublisher,
} from './types.js';

interface StoredChange extends ChangeRef {
  status: ChangeStatus;
  taskId: string;
}

export class FakeSitePublisher implements SitePublisher {
  readonly platform = 'github' as const;

  private readonly byTaskId = new Map<string, StoredChange>();
  private readonly byRef = new Map<string, StoredChange>();
  private nextNumber = 1;

  async openChange(input: OpenChangeInput): Promise<ChangeRef> {
    if (input.taskId === '') {
      throw GrowthAgentErrors.validation('openChange: taskId is required (idempotency key)');
    }
    if (input.title === '') {
      throw GrowthAgentErrors.validation('openChange: title is required');
    }
    if (input.files.length === 0) {
      throw GrowthAgentErrors.validation('openChange: at least one file is required');
    }
    // Idempotency contract: same taskId -> the previously opened change.
    const existing = this.byTaskId.get(input.taskId);
    if (existing !== undefined) {
      return { ref: existing.ref, url: existing.url, number: existing.number };
    }
    const number = this.nextNumber;
    this.nextNumber += 1;
    const change: StoredChange = {
      ref: `refs/heads/growth/${input.taskId}`,
      url: `https://fake.local/growth-agent/pull/${number}`,
      number,
      status: 'open',
      taskId: input.taskId,
    };
    this.byTaskId.set(input.taskId, change);
    this.byRef.set(change.ref, change);
    return { ref: change.ref, url: change.url, number: change.number };
  }

  async getChangeStatus(ref: string): Promise<ChangeStatus> {
    const change = this.byRef.get(ref);
    if (change === undefined) {
      throw GrowthAgentErrors.notFound(`change ${ref}`);
    }
    return change.status;
  }

  /** Test-only state pinning (a simulated human merge / close). */
  setStatus(ref: string, status: ChangeStatus): void {
    const change = this.byRef.get(ref);
    if (change === undefined) {
      throw GrowthAgentErrors.notFound(`change ${ref}`);
    }
    change.status = status;
  }

  /** Test helper: list every opened change in creation order. */
  openedChanges(): ChangeRef[] {
    return [...this.byTaskId.values()].map(c => ({
      ref: c.ref,
      url: c.url,
      number: c.number,
    }));
  }
}
