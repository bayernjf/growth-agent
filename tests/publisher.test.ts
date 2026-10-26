import { describe, expect, it } from 'vitest';
import { buildPrBody, DO_NOT_AUTO_MERGE_LINE } from '../src/publisher/pr-body.js';
import { FakeSitePublisher } from '../src/publisher/fake.js';

describe('buildPrBody (§4.3 required sections)', () => {
  const body = buildPrBody({
    taskId: 'gt_2026-10-26_site-audit',
    query: 'site audit checklist',
    changeSummary: 'Added a new /blog/site-audit-checklist page.',
    gscEvidence: 'query "site audit checklist": 12 clicks / 480 impressions / pos 3.4',
    serpEvidence: 'fixture SERP depth 10',
    qaScores: { intent: 0.91, dedupe: 0.84, value: 0.77 },
  });

  it('contains the target query, evidence, QA scores and do-not-auto-merge notice', () => {
    expect(body).toContain('site audit checklist');
    expect(body).toContain('12 clicks / 480 impressions / pos 3.4');
    expect(body).toContain('intent: 0.91');
    expect(body).toContain('dedupe: 0.84');
    expect(body).toContain('value: 0.77');
    expect(body).toContain(DO_NOT_AUTO_MERGE_LINE);
  });

  it('renders "none this run" when an evidence block is omitted', () => {
    const noEvidence = buildPrBody({
      taskId: 'gt_x',
      query: 'q',
      changeSummary: 's',
      qaScores: { intent: 0.9, dedupe: 0.9, value: 0.9 },
    });
    expect(noEvidence).toContain('none this run');
  });
});

describe('FakeSitePublisher contract (§4.3)', () => {
  const input = {
    taskId: 'gt_2026-10-26_site-audit',
    title: 'New page: site audit checklist',
    body: buildPrBody({
      taskId: 'gt_2026-10-26_site-audit',
      query: 'site audit checklist',
      changeSummary: 'new page',
      qaScores: { intent: 0.9, dedupe: 0.9, value: 0.9 },
    }),
    files: [{ path: 'src/pages/blog/site-audit-checklist.mdx', content: '# ...' }],
  };

  it('openChange returns {ref, url, number} and starts open', async () => {
    const publisher = new FakeSitePublisher();
    const change = await publisher.openChange(input);
    expect(change.ref).toContain('gt_2026-10-26_site-audit');
    expect(change.url).toMatch(/^https:\/\/fake\.local\//);
    expect(typeof change.number).toBe('number');
    expect(await publisher.getChangeStatus(change.ref)).toBe('open');
  });

  it('is idempotent by taskId: re-opening returns the same change, never a duplicate PR', async () => {
    const publisher = new FakeSitePublisher();
    const first = await publisher.openChange(input);
    const second = await publisher.openChange({ ...input, body: 'different body', title: 'revised' });
    expect(second).toEqual(first);
    expect(publisher.openedChanges()).toHaveLength(1);
  });

  it('reflects merged/closed transitions and rejects unknown refs', async () => {
    const publisher = new FakeSitePublisher();
    const change = await publisher.openChange(input);
    publisher.setStatus(change.ref, 'merged');
    expect(await publisher.getChangeStatus(change.ref)).toBe('merged');
    await expect(publisher.getChangeStatus('refs/heads/growth/nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('validates the input contract', async () => {
    const publisher = new FakeSitePublisher();
    await expect(publisher.openChange({ ...input, taskId: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      publisher.openChange({ ...input, files: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
