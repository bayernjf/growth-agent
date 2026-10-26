import { describe, expect, it } from 'vitest';
import { MockLoomClient } from '../../src/connector/loom/mock.js';
import { createLoomClient } from '../../src/connector/loom/registry.js';

describe('MockLoomClient (T-E4 openapi-shaped mock)', () => {
  it('returns deterministic openapi-shaped ids and awaiting_review status', async () => {
    const loom = new MockLoomClient();
    const ref = await loom.submitTopicDraft({
      taskId: 'gt_1',
      query: 'self hosted growth agent',
      angle: 'guide',
      siteId: 'bayjf.com',
      evidenceSignalIds: ['sig_1'],
    });
    expect(ref.draftId).toBe('loom_draft_gt_1');
    expect(ref.finalId).toBe('loom_final_gt_1');
    expect(ref.status).toBe('awaiting_review');

    const content = await loom.getContent('loom_final_gt_1');
    expect(content.finalId).toBe('loom_final_gt_1');
    expect(content.status).toBe('awaiting_review');
    expect(content.path).toBe('guides/self-hosted-growth-agent');
    expect(Array.isArray(content.paragraphs)).toBe(true);
    expect((content.paragraphs ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent on taskId', async () => {
    const loom = new MockLoomClient();
    const input = { taskId: 'gt_2', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [] };
    const first = await loom.submitTopicDraft(input);
    const second = await loom.submitTopicDraft(input);
    expect(second).toEqual(first);
  });

  it('honors seeded terminal status', async () => {
    const loom = new MockLoomClient({
      statusByFinalId: new Map([['loom_final_gt_3', 'approved']]),
    });
    await loom.submitTopicDraft({ taskId: 'gt_3', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [] });
    expect(await loom.getReviewStatus('loom_final_gt_3')).toBe('approved');
    const content = await loom.getContent('loom_final_gt_3');
    expect(content.status).toBe('approved');
  });

  it('returns a 404-shaped error for unknown content', async () => {
    const loom = new MockLoomClient();
    await expect(loom.getContent('loom_final_missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(loom.getReviewStatus('loom_final_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects empty taskId or query', async () => {
    const loom = new MockLoomClient();
    await expect(
      loom.submitTopicDraft({ taskId: '', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [] }),
    ).rejects.toThrow();
  });

  it('registry returns the mock off-line and fails closed for online mode', () => {
    expect(createLoomClient('mock').mode).toBe('mock');
    expect(() => createLoomClient('online')).toThrow(/openapi/i);
  });
});
