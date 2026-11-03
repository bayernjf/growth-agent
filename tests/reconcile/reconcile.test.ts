import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { ChannelFailureRepository } from '../../src/connector/zeus/webhook-repository.js';
import { reconcileDecisions } from '../../src/reconcile/reconcile.js';
import { GrowthAgentErrors } from '../../src/errors.js';
import type { ZeusDecisionClient, ZeusDecisionReplay } from '../../src/connector/zeus/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

async function setup() {
  process.env.GA_REPO_ROOT = repoRoot;
  const db = new SqliteDriver(':memory:');
  await migrateUp(db);
  const tasks = new GrowthTaskRepository(db);
  const failures = new ChannelFailureRepository(db);
  return { db, tasks, failures };
}

function stubZeus(events: ZeusDecisionReplay['events'], opts: { notFound?: boolean } = {}): ZeusDecisionClient {
  return {
    name: 'zeus-stub',
    mode: 'offline',
    submitDecision: async () => {
      throw new Error('not used');
    },
    getDecisionAudit: async (id: string) => {
      if (opts.notFound) throw GrowthAgentErrors.notFound(`decision ${id}`);
      return { format: 'json', record: { id }, events };
    },
    getPolicies: async () => {
      throw new Error('not used');
    },
    ping: async () => true,
    buildSubscriptionPayload: ({ callbackUrl, secret }) => ({ url: callbackUrl, secret, active: true }),
    startupSelfCheck: async () => ({ ping: true, policyVersion: 1, policyDefaultGrade: 'approve', resubscribed: false }),
  };
}

describe('reconcileDecisions (§9.2)', () => {
  const now = '2026-10-26T06:00:00.000Z';

  it('reconciles approved/rejected/timed-out to drafting/rejected/expired', async () => {
    const { db, tasks } = await setup();
    await tasks.create({ id: 'gt_a', siteId: 's', type: 'write', status: 'deciding' }, now);
    await tasks.create({ id: 'gt_b', siteId: 's', type: 'write', status: 'deciding' }, now);
    await tasks.create({ id: 'gt_c', siteId: 's', type: 'write', status: 'deciding' }, now);
    await tasks.patch('gt_a', { zeusDecisionId: 'dec_a' }, now);
    await tasks.patch('gt_b', { zeusDecisionId: 'dec_b' }, now);
    await tasks.patch('gt_c', { zeusDecisionId: 'dec_c' }, now);

    // Per-decision audit timeline keyed off id.
    const audits = new Map<string, ZeusDecisionReplay['events']>([
      ['dec_a', [{ type: 'approved', at: now }]],
      ['dec_b', [{ type: 'rejected', at: now }]],
      ['dec_c', [{ type: 'timed-out', at: now }]],
    ]);
    const zeus = stubZeus([]);
    zeus.getDecisionAudit = async id => ({
      format: 'json',
      record: { id },
      events: audits.get(id) ?? [],
    });

    const summary = await reconcileDecisions({
      tasks,
      zeus,
      now: () => now,
    });
    expect(summary.reconciled).toBe(3);
    expect(await tasks.get('gt_a')).toMatchObject({ status: 'drafting' });
    expect(await tasks.get('gt_b')).toMatchObject({ status: 'rejected' });
    expect(await tasks.get('gt_c')).toMatchObject({ status: 'expired' });
    await db.close();
  });

  it('leaves deciding tasks unchanged when no terminal event exists', async () => {
    const { db, tasks } = await setup();
    await tasks.create({ id: 'gt_pending', siteId: 's', type: 'write', status: 'deciding' }, now);
    await tasks.patch('gt_pending', { zeusDecisionId: 'dec_pending' }, now);
    const zeus = stubZeus([{ type: 'created', at: now }, { type: 'late', at: now }]);
    const summary = await reconcileDecisions({ tasks, zeus, now: () => now });
    expect(summary.unchanged).toBe(1);
    expect(await tasks.get('gt_pending')).toMatchObject({ status: 'deciding' });
    await db.close();
  });

  it('counts deciding tasks without a decision id as missing', async () => {
    const { db, tasks } = await setup();
    await tasks.create({ id: 'gt_noid', siteId: 's', type: 'write', status: 'deciding' }, now);
    const summary = await reconcileDecisions({ tasks, zeus: stubZeus([]), now: () => now });
    expect(summary.missingDecision).toBe(1);
    await db.close();
  });

  it('records a channel failure for a missing decision (404) and leaves state', async () => {
    const { db, tasks, failures } = await setup();
    await tasks.create({ id: 'gt_ghost', siteId: 's', type: 'write', status: 'deciding' }, now);
    await tasks.patch('gt_ghost', { zeusDecisionId: 'dec_ghost' }, now);
    const zeus = stubZeus([], { notFound: true });
    const summary = await reconcileDecisions({ tasks, zeus, failures, now: () => now });
    expect(summary.unchanged).toBe(1);
    expect(await tasks.get('gt_ghost')).toMatchObject({ status: 'deciding' });
    const row = await failures.get('cf:zeus:DECISION_NOT_FOUND');
    expect(row?.attempts).toBe(1);
    expect(row?.retryable).toBe(false);
    await db.close();
  });

  // Review F-07: signaled tasks stranded by a mid-loop submit failure.
  it('resubmits a stranded signaled task from its persisted context', async () => {
    const { db, tasks } = await setup();
    await tasks.create(
      {
        id: 'gt_stranded',
        siteId: 's',
        type: 'write',
        status: 'signaled',
        signalId: 'sig_1',
        context: { query: 'how to bake bread', angle: 'daily write candidate' },
      },
      now,
    );

    const submitted: string[] = [];
    const zeus = stubZeus([]);
    zeus.submitDecision = async input => {
      submitted.push(input.taskId);
      return {
        decisionId: 'dec_revived',
        grade: 'pending',
        mode: 'offline',
        status: 'created',
        ruleId: 'rule_offline',
        auditSeq: 1,
      };
    };

    const summary = await reconcileDecisions({ tasks, zeus, now: () => now });
    expect(summary.resubmitted).toBe(1);
    expect(submitted).toEqual(['gt_stranded']);
    expect(await tasks.get('gt_stranded')).toMatchObject({
      status: 'deciding',
      zeusDecisionId: 'dec_revived',
    });
    await db.close();
  });

  it('counts signaled tasks without persisted context as unsubmittable (no fabrication)', async () => {
    const { db, tasks } = await setup();
    // Pre-migration-007 shape: no context at all.
    await tasks.create({ id: 'gt_legacy', siteId: 's', type: 'write', status: 'signaled' }, now);
    const zeus = stubZeus([]);
    const summary = await reconcileDecisions({ tasks, zeus, now: () => now });
    expect(summary.unsubmittable).toBe(1);
    expect(summary.resubmitted).toBe(0);
    expect(await tasks.get('gt_legacy')).toMatchObject({ status: 'signaled' });
    await db.close();
  });

  it('leaves a signaled task in place (retryable) when zeus resubmit fails', async () => {
    const { db, tasks, failures } = await setup();
    await tasks.create(
      {
        id: 'gt_flaky',
        siteId: 's',
        type: 'fix',
        status: 'signaled',
        signalId: 'sig_2',
        context: { query: '/drop', angle: 'daily fix candidate', targetUrl: '/drop' },
      },
      now,
    );
    const zeus = stubZeus([]);
    zeus.submitDecision = async () => {
      throw new Error('UPSTREAM_UNAVAILABLE: zeus down');
    };

    const summary = await reconcileDecisions({ tasks, zeus, failures, now: () => now });
    expect(summary.resubmitted).toBe(0);
    expect(summary.unchanged).toBe(1);
    expect(await tasks.get('gt_flaky')).toMatchObject({ status: 'signaled' });
    const row = await failures.get('cf:zeus:SIGNALED_RESUBMIT_FAILED');
    expect(row?.retryable).toBe(true);
    await db.close();
  });
});
