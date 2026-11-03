// Contract tests for the GitHub REST publisher (T-D2, design §4.3). A
// node:http fake GitHub server records the wire shape; no real GitHub call
// is made (T-D4 e2e is deferred).

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrowthAgentError } from '../../src/errors.js';
import {
  branchForTask,
  GitHubPublisher,
} from '../../src/publisher/github/http.js';
import { RejectingGithubPublisher } from '../../src/publisher/github/rejecting.js';
import type { OpenChangeInput } from '../../src/publisher/types.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeGithub {
  baseUrl: string;
  requests: RecordedRequest[];
  handler: (req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }) => { status: number; json?: unknown; headers?: Record<string, string> };
  close: () => Promise<void>;
}

async function startFakeGithub(): Promise<FakeGithub> {
  const requests: RecordedRequest[] = [];
  let handler: FakeGithub['handler'] = () => ({ status: 500, json: { message: 'unhandled' } });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = {};
      if (raw !== '') {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          body = raw;
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const recorded = { method: req.method ?? 'GET', url: req.url ?? '/', headers, body };
      requests.push(recorded);
      const out = handler(recorded);
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(out.json === undefined ? '' : JSON.stringify(out.json));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const fake: FakeGithub = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    set handler(fn: FakeGithub['handler']) {
      handler = fn;
    },
    get handler() {
      return handler;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
  return fake;
}

/** Stateful emulation of the GitHub refs/contents/pulls endpoints. */
function statefulHandler(
  opts: {
    branchCreated?: boolean;
    existingFiles?: Set<string>;
    existingPr?: boolean;
  } = {},
): FakeGithub['handler'] {
  const branchExists = opts.branchCreated ?? false;
  const files = new Set(opts.existingFiles ?? []);
  let prExists = opts.existingPr ?? false;
  return ({ method, url, body }) => {
    const path = url.split('?')[0] ?? url;
    const bodyObj = (body ?? {}) as Record<string, unknown>;

    if (method === 'GET' && path === '/repos/o/r/git/ref/heads/main') {
      return { status: 200, json: { ref: 'refs/heads/main', object: { sha: 'base-sha', type: 'commit' } } };
    }
    if (method === 'GET' && path === '/repos/o/r/git/ref/heads/growth-agent/gt_1') {
      return branchExists
        ? { status: 200, json: { ref: 'refs/heads/growth-agent/gt_1', object: { sha: 'branch-sha', type: 'commit' } } }
        : { status: 404, json: { message: 'Not Found' } };
    }
    if (method === 'POST' && path === '/repos/o/r/git/refs') {
      return { status: 201, json: { ref: bodyObj.ref, object: { sha: 'branch-sha', type: 'commit' } } };
    }
    if (method === 'GET' && path.startsWith('/repos/o/r/contents/')) {
      const filePath = decodeURIComponent(path.slice('/repos/o/r/contents/'.length));
      if (files.has(filePath)) {
        return { status: 200, json: { sha: `blob-${filePath}` } };
      }
      return { status: 404, json: { message: 'Not Found' } };
    }
    if (method === 'PUT' && path.startsWith('/repos/o/r/contents/')) {
      const filePath = decodeURIComponent(path.slice('/repos/o/r/contents/'.length));
      files.add(filePath);
      return { status: 200, json: { content: { sha: `blob-new-${filePath}` } } };
    }
    if (method === 'GET' && path === '/repos/o/r/pulls') {
      return {
        status: 200,
        json: prExists
          ? [{ number: 1, html_url: 'https://github.com/o/r/pull/1', state: 'open', merged: false, head: { ref: 'growth-agent/gt_1' } }]
          : [],
      };
    }
    if (method === 'POST' && path === '/repos/o/r/pulls') {
      prExists = true;
      return {
        status: 201,
        json: { number: 1, html_url: 'https://github.com/o/r/pull/1', state: 'open', merged: false, head: { ref: 'growth-agent/gt_1' } },
      };
    }
    if (method === 'PATCH' && path === '/repos/o/r/pulls/1') {
      return {
        status: 200,
        json: { number: 1, html_url: 'https://github.com/o/r/pull/1', state: 'open', merged: false, head: { ref: 'growth-agent/gt_1' } },
      };
    }
    return { status: 500, json: { message: `unhandled ${method} ${path}` } };
  };
}

function makePublisher(baseUrl: string, overrides: Partial<ConstructorParameters<typeof GitHubPublisher>[0]> = {}) {
  const sleeps: number[] = [];
  const publisher = new GitHubPublisher({
    owner: 'o',
    repo: 'r',
    token: 'ghp_test-token',
    apiBaseUrl: baseUrl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { publisher, sleeps };
}

const changeInput: OpenChangeInput = {
  taskId: 'gt_1',
  title: 'Add a guide',
  body: 'PR body with query, evidence, QA scores and do-not-auto-merge',
  files: [{ path: 'src/guide.md', content: '# hello growth-agent' }],
};

let fake: FakeGithub;

beforeAll(async () => {
  fake = await startFakeGithub();
});

afterAll(async () => {
  await fake.close();
});

describe('GitHub publisher openChange (T-D2)', () => {
  it('derives a deterministic growth-agent branch from the task id', () => {
    expect(branchForTask('gt_1')).toBe('growth-agent/gt_1');
    expect(branchForTask('weird/id x')).toBe('growth-agent/weird-id-x');
  });

  it('creates branch, file and PR on the first run', async () => {
    fake.requests.length = 0;
    fake.handler = statefulHandler();
    const { publisher } = makePublisher(fake.baseUrl);

    const ref = await publisher.openChange(changeInput);
    expect(ref).toEqual({ ref: '1', url: 'https://github.com/o/r/pull/1', number: 1 });

    const methods = fake.requests.map(r => `${r.method} ${r.url}`);
    expect(methods).toContain('GET /repos/o/r/git/ref/heads/main');
    expect(methods).toContain('GET /repos/o/r/git/ref/heads/growth-agent/gt_1');
    expect(methods).toContain('POST /repos/o/r/git/refs');
    expect(methods.some(m => m.startsWith('PUT /repos/o/r/contents/'))).toBe(true);
    expect(methods).toContain('GET /repos/o/r/pulls?state=open&head=o%3Agrowth-agent%2Fgt_1');
    expect(methods).toContain('POST /repos/o/r/pulls');
    expect(methods).not.toContain('PATCH /repos/o/r/pulls/1');

    const createRef = fake.requests.find(r => r.url === '/repos/o/r/git/refs');
    expect(createRef?.body).toMatchObject({ ref: 'refs/heads/growth-agent/gt_1', sha: 'base-sha' });

    const putFile = fake.requests.find(r => r.method === 'PUT');
    expect(putFile?.headers.authorization).toBe('Bearer ghp_test-token');
    expect(putFile?.headers['x-github-api-version']).toBe('2022-11-28');
    const body = putFile?.body as { content: string; branch: string; message: string };
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe('# hello growth-agent');
    expect(body.branch).toBe('growth-agent/gt_1');

    const openPr = fake.requests.find(r => r.method === 'POST' && r.url === '/repos/o/r/pulls');
    expect(openPr?.body).toMatchObject({
      head: 'growth-agent/gt_1',
      base: 'main',
      title: 'Add a guide',
      body: changeInput.body,
    });
  });

  it('reuses the branch and updates the existing PR on re-run (no duplicate PR)', async () => {
    fake.requests.length = 0;
    fake.handler = statefulHandler({ branchCreated: true, existingFiles: new Set(['src/guide.md']), existingPr: true });
    const { publisher } = makePublisher(fake.baseUrl);

    await publisher.openChange(changeInput);

    const methods = fake.requests.map(r => r.method);
    expect(methods).not.toContain('POST');
    expect(methods).toContain('PATCH');
    const putFile = fake.requests.find(r => r.method === 'PUT');
    expect((putFile?.body as { sha?: string }).sha).toBe('blob-src/guide.md');
    const patch = fake.requests.find(r => r.method === 'PATCH');
    expect(patch?.url).toBe('/repos/o/r/pulls/1');
  });

  it('maps 401 to PUBLISH_AUTH without retrying', async () => {
    fake.requests.length = 0;
    fake.handler = () => ({ status: 401, json: { message: 'Bad credentials' } });
    const { publisher, sleeps } = makePublisher(fake.baseUrl);

    await expect(publisher.openChange(changeInput)).rejects.toMatchObject({
      code: 'PUBLISH_AUTH',
      retryable: false,
      status: 401,
    });
    expect(fake.requests.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('maps 403 to PUBLISH_FORBIDDEN without retrying', async () => {
    fake.requests.length = 0;
    fake.handler = () => ({ status: 403, json: { message: 'Resource not accessible by integration' } });
    const { publisher } = makePublisher(fake.baseUrl);

    await expect(publisher.openChange(changeInput)).rejects.toMatchObject({
      code: 'PUBLISH_FORBIDDEN',
      retryable: false,
      status: 403,
    });
    expect(fake.requests.length).toBe(1);
  });

  it('treats a rate-limited 403 as retryable upstream-unavailable', async () => {
    fake.requests.length = 0;
    fake.handler = () => ({
      status: 403,
      json: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0' },
    });
    const { publisher, sleeps } = makePublisher(fake.baseUrl);

    await expect(publisher.openChange(changeInput)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
      status: 503,
    });
    expect(fake.requests.length).toBe(3);
    expect(sleeps).toEqual([200, 400, 800]);
  });

  it('retries 5xx three times then throws UPSTREAM_UNAVAILABLE', async () => {
    fake.requests.length = 0;
    fake.handler = () => ({ status: 500, json: { message: 'boom' } });
    const { publisher, sleeps } = makePublisher(fake.baseUrl);

    await expect(publisher.openChange(changeInput)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    });
    expect(fake.requests.length).toBe(3);
    expect(sleeps).toEqual([200, 400, 800]);
  });

  it('fails closed without token/owner/repo', () => {
    let caught: unknown;
    try {
      new GitHubPublisher({ owner: 'o', repo: 'r', token: '', apiBaseUrl: fake.baseUrl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GrowthAgentError);
    expect((caught as GrowthAgentError).code).toBe('CREDENTIAL_MISSING');
  });

  it('rejecting publisher raises CREDENTIAL_MISSING on every call', async () => {
    const rejecting = new RejectingGithubPublisher('not configured');
    await expect(rejecting.openChange(changeInput)).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
      status: 422,
    });
    await expect(rejecting.getChangeStatus('1')).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  it('maps getChangeStatus to open / merged / closed', async () => {
    const states: Array<{ json: unknown; expected: 'open' | 'merged' | 'closed' }> = [
      { json: { number: 1, state: 'open', merged: false, html_url: '', head: { ref: 'b' } }, expected: 'open' },
      { json: { number: 1, state: 'closed', merged: true, html_url: '', head: { ref: 'b' } }, expected: 'merged' },
      { json: { number: 1, state: 'closed', merged: false, html_url: '', head: { ref: 'b' } }, expected: 'closed' },
    ];
    for (const state of states) {
      fake.handler = ({ method, url }) => {
        if (method === 'GET' && url === '/repos/o/r/pulls/1') {
          return { status: 200, json: state.json };
        }
        return { status: 404 };
      };
      const { publisher } = makePublisher(fake.baseUrl);
      expect(await publisher.getChangeStatus('1')).toBe(state.expected);
    }
  });

  // Review F-09: a draft slug lands at PUT /contents/:path with the bot PAT.
  // Unsafe paths must be rejected before ANY network call (fake server records
  // zero requests), otherwise `../../.github/workflows/x.yml` is privilege
  // escalation into repo workflows.
  describe('openChange path safety (F-09)', () => {
    const unsafePaths = [
      '../../.github/workflows/x.yml',
      '../outside.md',
      '/abs/path.md',
      '.github/workflows/x.yml',
      '.GITHUB/workflows/x.yml',
      'a/../b.md',
      'back\\slash.md',
      'with?query.md',
      'trailingslash/',
      'dot/./file.md',
    ];

    for (const badPath of unsafePaths) {
      it(`rejects "${badPath}" with VALIDATION_FAILED and zero network calls`, async () => {
        fake.requests.length = 0;
        const { publisher } = makePublisher(fake.baseUrl);
        await expect(
          publisher.openChange({ ...changeInput, files: [{ path: badPath, content: 'x' }] }),
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
        expect(fake.requests).toEqual([]);
      });
    }

    it('accepts ordinary nested page paths', async () => {
      fake.requests.length = 0;
      fake.handler = statefulHandler();
      const { publisher } = makePublisher(fake.baseUrl);
      const ref = await publisher.openChange({
        ...changeInput,
        files: [{ path: 'docs/guides/my-page_v2.md', content: '# ok' }],
      });
      expect(ref.number).toBeGreaterThan(0);
    });
  });
});
