import { describe, expect, it } from 'vitest';
import { GrowthAgentError } from '../../src/errors.js';
import {
  GROWTH_TASK_TRANSITIONS,
  assertTaskTransition,
  isTerminalStatus,
} from '../../src/task/state-machine.js';

describe('GrowthTask state machine (design §3.2)', () => {
  describe('legal transitions', () => {
    type Tuple = [
      Parameters<typeof assertTaskTransition>[0],
      Parameters<typeof assertTaskTransition>[0],
      number?,
    ];
    const cases: Tuple[] = [
      ['signaled', 'deciding'],
      ['deciding', 'drafting'],
      ['deciding', 'rejected'],
      ['deciding', 'expired'],
      ['deciding', 'failed'],
      ['drafting', 'pr_opened'],
      ['drafting', 'qa_revision', 0],
      ['drafting', 'failed'],
      ['qa_revision', 'drafting'],
      ['qa_revision', 'failed'],
      ['pr_opened', 'awaiting_merge'],
      ['awaiting_merge', 'merged'],
      ['awaiting_merge', 'cancelled'],
      ['merged', 'verifying'],
      ['verifying', 'done'],
    ];

    for (const [from, to, count] of cases) {
      it(`${from} → ${to}`, () => {
        const ctx = count === undefined ? {} : { qaRevisionCount: count };
        expect(() => assertTaskTransition(from, to, ctx)).not.toThrow();
      });
    }
  });

  describe('illegal transitions fail closed (409 INVALID_TRANSITION)', () => {
    type Tuple = [
      Parameters<typeof assertTaskTransition>[0],
      Parameters<typeof assertTaskTransition>[0],
      number?,
    ];
    const cases: Tuple[] = [
      ['signaled', 'drafting'],
      ['signaled', 'qa_revision'],
      ['deciding', 'signaled'],
      ['drafting', 'merged'],
      ['awaiting_merge', 'drafting'],
      ['qa_revision', 'pr_opened'],
      ['qa_revision', 'signaled'],
      ['merged', 'drafting'],
      ['verifying', 'drafting'],
      ['rejected', 'signaled'],
      ['expired', 'signaled'],
      ['cancelled', 'signaled'],
      ['done', 'verifying'],
      ['failed', 'drafting'],
    ];

    for (const [from, to] of cases) {
      it(`${from} → ${to}`, () => {
        expect.assertions(2);
        try {
          assertTaskTransition(from, to);
          throw new Error('expected assertTaskTransition to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(GrowthAgentError);
          expect((err as GrowthAgentError).code).toBe('INVALID_TRANSITION');
        }
      });
    }
  });

  describe('one-shot qa_revision rework guard', () => {
    it('allows drafting→qa_revision while the rework pass is unused (count=0)', () => {
      expect(() =>
        assertTaskTransition('drafting', 'qa_revision', { qaRevisionCount: 0 }),
      ).not.toThrow();
    });

    it('rejects drafting→qa_revision after the rework pass was already used (count=1)', () => {
      expect(() =>
        assertTaskTransition('drafting', 'qa_revision', { qaRevisionCount: 1 }),
      ).toThrowError(/rework already used/);
    });

    it('routes the second QA failure via drafting→failed instead', () => {
      expect(() =>
        assertTaskTransition('drafting', 'failed', { qaRevisionCount: 1 }),
      ).not.toThrow();
    });

    it('treats a missing count as 0 (first failure may rework)', () => {
      expect(() => assertTaskTransition('drafting', 'qa_revision')).not.toThrow();
    });
  });

  it('rejects an unknown target status as validation (400)', () => {
    expect(() =>
      assertTaskTransition('signaled', 'nope' as Parameters<typeof assertTaskTransition>[1]),
    ).toThrowError(/unknown growth task status/);
  });

  it('terminal states have no outgoing transitions', () => {
    for (const status of ['done', 'rejected', 'expired', 'cancelled', 'failed'] as const) {
      expect(GROWTH_TASK_TRANSITIONS[status]).toEqual([]);
      expect(isTerminalStatus(status)).toBe(true);
    }
  });
});
