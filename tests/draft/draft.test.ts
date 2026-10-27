// Draft-source port tests (inbox / loom / registry). The loom double below
// exercises THIS provider's branching (envelope validation, generating vs
// review, no duplicate submit) — loom's own wire semantics are covered
// separately in tests/connector/loom.test.ts against recorded payloads.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/config.js';
import type {
  LoomClient,
  LoomContent,
  LoomContentStatus,
  LoomTopicDraftInput,
  LoomTopicDraftRef,
} from '../../src/connector/loom/types.js';
import { InboxDraftProvider, readInboxFile } from '../../src/draft/inbox.js';
import { LoomDraftProvider, splitBodyParagraphs } from '../../src/draft/loom.js';
import { createDraftProvider } from '../../src/draft/registry.js';
import type { DraftRequest } from '../../src/draft/types.js';

const request: DraftRequest = {
  taskId: 'gt_20261027_write_1',
  taskType: 'write',
  siteId: 'bayjf.com',
  query: 'self hosted growth agent',
  angle: 'daily write candidate',
};

const validFile = {
  slug: 'guides/self-hosted-growth-agent',
  title: 'Self-hosted growth agent: a complete guide',
  changeSummary: 'New guide',
  paragraphs: [
    'A self-hosted growth agent runs the daily pipeline on your own infrastructure with keys you control.',
    'Every Search Console and SERP call is billed to your own account and recorded in a local cost ledger.',
    'The approval gate keeps a human in control: the bot opens pull requests but never merges them.',
  ],
};

let dir: string;

function writeDraftFile(taskId: string, content: unknown): string {
  const path = join(dir, `${taskId}.json`);
  writeFileSync(path, JSON.stringify(content), 'utf8');
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draft-inbox-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('InboxDraftProvider', () => {
  it('returns a ready draft built from the file plus the task context', async () => {
    writeDraftFile(request.taskId, validFile);

    const outcome = await new InboxDraftProvider(dir).obtain(request);

    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.draft).toEqual({
      taskType: 'write',
      // query comes from the persisted task context, never from the file: an
      // operator must not be able to re-point a task at a different keyword.
      query: 'self hosted growth agent',
      slug: validFile.slug,
      title: validFile.title,
      paragraphs: validFile.paragraphs,
    });
    expect(outcome.changeSummary).toBe('New guide');
    expect(outcome.loomContentId).toBeUndefined();
  });

  it('reports a missing file as unavailable rather than throwing', async () => {
    const outcome = await new InboxDraftProvider(dir).obtain(request);
    expect(outcome).toMatchObject({ status: 'unavailable' });
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toContain('no draft file at');
  });

  it('rejects malformed JSON and a non-object payload without throwing', async () => {
    writeFileSync(join(dir, `${request.taskId}.json`), '{not json', 'utf8');
    const bad = await new InboxDraftProvider(dir).obtain(request);
    expect(bad).toMatchObject({ status: 'unavailable' });
    if (bad.status === 'unavailable') expect(bad.reason).toContain('not valid JSON');

    writeDraftFile(request.taskId, ['not', 'an', 'object']);
    const arr = await new InboxDraftProvider(dir).obtain(request);
    if (arr.status === 'unavailable') expect(arr.reason).toContain('must contain a JSON object');
  });

  it('collects every structural problem in one pass', async () => {
    writeDraftFile(request.taskId, { slug: '', title: ' ', changeSummary: '', paragraphs: ['ok', 42] });

    const result = readInboxFile(dir, request.taskId);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reason).toContain('slug must be a non-empty string');
    expect(result.reason).toContain('title must be a non-empty string');
    expect(result.reason).toContain('changeSummary must be a non-empty string');
    expect(result.reason).toContain('paragraphs[1] must be a non-empty string');
  });

  it('enforces the value gate paragraph minimum before QA can burn the one rework', async () => {
    writeDraftFile(request.taskId, { ...validFile, paragraphs: ['only one paragraph'] });

    const outcome = await new InboxDraftProvider(dir).obtain(request);
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toContain('below the value gate minimum 3');
  });
});

/** Minimal in-test double for the loom port. */
class FakeLoom implements LoomClient {
  readonly name = 'loom-fake';
  readonly mode = 'mock' as const;
  readonly submitted: LoomTopicDraftInput[] = [];
  submitCalls = 0;

  constructor(
    private readonly status: LoomContentStatus,
    private readonly body: string | null,
  ) {}

  async submitTopicDraft(input: LoomTopicDraftInput): Promise<LoomTopicDraftRef> {
    this.submitCalls += 1;
    this.submitted.push(input);
    return { contentId: 'ct_1', finalId: input.finalId, status: 'generating' };
  }

  async getContent(contentId: string): Promise<LoomContent> {
    return {
      contentId,
      finalId: 'fcw_issued',
      status: this.status,
      goal: 'goal',
      platform: 'web',
      body: this.body,
      publishedUrl: null,
      qualityScore: null,
    };
  }

  async getReviewStatus(): Promise<LoomContentStatus> {
    return this.status;
  }
}

function loomProvider(loom: LoomClient): LoomDraftProvider {
  return new LoomDraftProvider({ loom, inboxDir: dir });
}

describe('LoomDraftProvider', () => {
  const body = [
    'First assembled paragraph with concrete numbers: 1 write and 1 fix per day.',
    'Second assembled paragraph covering the sealed OAuth token volume.',
    'Third assembled paragraph on the human merge gate.',
  ].join('\n\n');

  it('splits the assembled loom body into paragraphs and keeps the operator envelope', async () => {
    writeDraftFile(request.taskId, { ...validFile, paragraphs: [], finalId: 'fcw_issued' });
    const loom = new FakeLoom('review', body);

    const outcome = await loomProvider(loom).obtain(request);

    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.draft.paragraphs).toEqual(splitBodyParagraphs(body));
    expect(outcome.draft.slug).toBe(validFile.slug);
    expect(outcome.draft.title).toBe(validFile.title);
    expect(outcome.loomContentId).toBe('ct_1');
    expect(loom.submitted[0]).toMatchObject({
      taskId: request.taskId,
      finalId: 'fcw_issued',
      query: request.query,
      angle: request.angle,
      siteId: request.siteId,
    });
  });

  it('does not require a body in the envelope (loom writes it)', async () => {
    writeDraftFile(request.taskId, {
      slug: validFile.slug,
      title: validFile.title,
      changeSummary: 'New guide',
      finalId: 'fcw_issued',
    });
    const outcome = await loomProvider(new FakeLoom('review', body)).obtain(request);
    expect(outcome.status).toBe('ready');
  });

  it('refuses to run without an operator-issued final_id', async () => {
    writeDraftFile(request.taskId, validFile);

    const outcome = await loomProvider(new FakeLoom('review', body)).obtain(request);

    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toContain('carries no finalId');
    expect(outcome.reason).toContain('/api/fcw/assemble');
  });

  it('reports a still-generating chain as unavailable but hands back the content id', async () => {
    writeDraftFile(request.taskId, { ...validFile, finalId: 'fcw_issued' });

    const outcome = await loomProvider(new FakeLoom('generating', null)).obtain(request);

    expect(outcome).toMatchObject({ status: 'unavailable', loomContentId: 'ct_1' });
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toContain('still generating');
  });

  it('polls an already-submitted content id instead of starting a second chain', async () => {
    writeDraftFile(request.taskId, { ...validFile, finalId: 'fcw_issued' });
    const loom = new FakeLoom('review', body);

    const outcome = await loomProvider(loom).obtain({ ...request, loomContentId: 'ct_existing' });

    expect(loom.submitCalls).toBe(0);
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.loomContentId).toBe('ct_existing');
  });

  it('reports a rejected or discarded chain as terminal', async () => {
    writeDraftFile(request.taskId, { ...validFile, finalId: 'fcw_issued' });

    const outcome = await loomProvider(new FakeLoom('rejected', body)).obtain(request);

    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toContain('ended as rejected');
  });

  it('refuses a body that splits below the value gate minimum', async () => {
    writeDraftFile(request.taskId, { ...validFile, finalId: 'fcw_issued' });

    const outcome = await loomProvider(new FakeLoom('review', 'one line only')).obtain(request);

    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toContain('below the value gate minimum 3');
  });
});

describe('splitBodyParagraphs', () => {
  it('splits on blank lines, trims and drops empties', () => {
    expect(splitBodyParagraphs('  a  \n\n\n  b\n\nc')).toEqual(['a', 'b', 'c']);
    expect(splitBodyParagraphs('')).toEqual([]);
  });
});

describe('createDraftProvider', () => {
  function config(overrides: Partial<AppConfig>): AppConfig {
    return {
      host: '127.0.0.1',
      port: 8790,
      dbDriver: 'sqlite',
      sqlitePath: ':memory:',
      zeusMode: 'off',
      gscMode: 'off',
      gscTokenDir: '/tmp/tokens',
      serpMode: 'off',
      loomMode: 'off',
      draftMode: 'inbox',
      draftInboxDir: '/tmp/drafts',
      githubMode: 'off',
      githubBaseBranch: 'main',
      reportDir: '/tmp/reports',
      ...overrides,
    };
  }

  it('defaults to the credential-free inbox provider', () => {
    const provider = createDraftProvider(config({}));
    expect(provider.name).toBe('draft-inbox');
    expect(provider.mode).toBe('inbox');
  });

  it('wires the loom client when loom is online', () => {
    const provider = createDraftProvider(
      config({ draftMode: 'loom', loomMode: 'online', loomUrl: 'http://127.0.0.1:8000', loomTenantId: 't1' }),
    );
    expect(provider.name).toBe('draft-loom');
    expect(provider.mode).toBe('loom');
  });

  it('fails closed on draftMode=loom without loom online, so a mock article cannot reach a real PR', () => {
    expect(() => createDraftProvider(config({ draftMode: 'loom', loomMode: 'off' }))).toThrowError(
      /GA_DRAFT_MODE=loom requires GA_LOOM_MODE=online/,
    );
  });

  it('reads the inbox directory from config', () => {
    const target = join(tmpdir(), 'draft-inbox-configured');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, `${request.taskId}.json`), JSON.stringify(validFile), 'utf8');

    const provider = createDraftProvider(config({ draftInboxDir: target }));
    return expect(provider.obtain(request)).resolves.toMatchObject({ status: 'ready' });
  });
});
