// F-05 regression (2026-11-02 review): the publisher used to read a single
// deployment-wide GA_GITHUB_OWNER/GA_GITHUB_REPO, so every site opened its PR
// in the same repository while the task prRef recorded the site's repository.
// These tests prove each site resolves to its own repository and that a site
// without one fails closed instead of inheriting a default.

import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import type { SiteConfig } from '../../src/config/sites.js';
import {
  createSitePublisher,
  resolveSitePublisherTarget,
} from '../../src/publisher/github/registry.js';
import { GitHubPublisher } from '../../src/publisher/github/http.js';
import { FakeSitePublisher } from '../../src/publisher/fake.js';
import type { OpenChangeInput } from '../../src/publisher/types.js';

const config: AppConfig = {
  host: '127.0.0.1',
  port: 8790,
  dbDriver: 'sqlite',
  sqlitePath: ':memory:',
  zeusMode: 'off',
  gscMode: 'off',
  adsMode: 'off',
  sentimentMode: 'off',
  gscTokenDir: '/tmp/tokens',
  serpMode: 'off',
  loomMode: 'off',
  draftMode: 'inbox',
  draftInboxDir: '/tmp/drafts',
  githubMode: 'online',
  githubToken: 'test-token',
  githubWebhookSecret: '0123456789abcdef0123456789abcdef',
  reportDir: '/tmp/reports',
  zeusWebhookMaxSkewSeconds: 300,
};

function site(id: string, owner: string, repo: string): SiteConfig {
  return {
    id,
    gsc: { siteUrl: `https://${id}/` },
    serp: { locationCode: 2840, languageCode: 'en' },
    github: { owner, repo, baseBranch: 'main' },
    watchQueries: ['q'],
    keywordSeeds: ['k'],
  };
}

interface FakeGithub {
  baseUrl: string;
  paths: () => string[];
  close: () => Promise<void>;
}

/** Minimal GitHub REST stand-in that records every requested path. */
async function fakeGithub(): Promise<FakeGithub> {
  const { createServer } = await import('node:http');
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    paths.push(url.pathname);
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/git/ref/heads/main')) {
      res.end(JSON.stringify({ ref: 'refs/heads/main', object: { sha: 'base-sha', type: 'commit' } }));
      return;
    }
    if (url.pathname.includes('/git/ref/heads/')) {
      res.statusCode = 404;
      res.end('{"message":"Not Found"}');
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/git/refs')) {
      res.statusCode = 201;
      res.end(JSON.stringify({ ref: 'refs/heads/x', object: { sha: 'new-sha', type: 'commit' } }));
      return;
    }
    if (req.method === 'GET' && url.pathname.includes('/contents/')) {
      res.end('{"sha":"content-sha"}');
      return;
    }
    if (req.method === 'PUT' && url.pathname.includes('/contents/')) {
      res.end('{"content":{"sha":"content-sha"}}');
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/pulls')) {
      res.end('[]');
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/pulls')) {
      res.statusCode = 201;
      res.end(JSON.stringify({ number: 1, html_url: 'https://github.test/pull/1', state: 'open' }));
      return;
    }
    res.statusCode = 500;
    res.end('{"message":"unhandled"}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake github did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    paths: () => paths,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err === undefined ? resolve() : reject(err)));
    }),
  };
}

const input: OpenChangeInput = {
  taskId: 'gt_site_repo',
  title: 'growth-agent: test',
  body: 'do not auto-merge',
  files: [{ path: 'src/pages/test.mdx', content: '# test\n' }],
};

describe('site publisher target resolution (F-05)', () => {
  it('resolves a different repository per site, with no shared default', () => {
    const siteA = site('bayjf.com', 'owner-a', 'repo-a');
    const siteB = site('zeus-landing', 'owner-b', 'repo-b');
    const a = resolveSitePublisherTarget(config, siteA);
    const b = resolveSitePublisherTarget(config, siteB);
    expect(a).toMatchObject({ ok: true, target: { owner: 'owner-a', repo: 'repo-a' } });
    expect(b).toMatchObject({ ok: true, target: { owner: 'owner-b', repo: 'repo-b' } });
  });

  it('opens each site change in its own repository', async () => {
    for (const target of [
      { site: site('bayjf.com', 'owner-a', 'repo-a'), expectPath: '/repos/owner-a/repo-a/' },
      { site: site('zeus-landing', 'owner-b', 'repo-b'), expectPath: '/repos/owner-b/repo-b/' },
    ]) {
      const resolution = resolveSitePublisherTarget(config, target.site);
      if (!resolution.ok) throw new Error(resolution.reason);
      const fake = await fakeGithub();
      try {
        const publisher = new GitHubPublisher({ ...resolution.target, apiBaseUrl: fake.baseUrl });
        await publisher.openChange(input);
        // Every wire request (refs, contents, pulls) targets this site's repo.
        expect(fake.paths().length).toBeGreaterThan(0);
        expect(fake.paths().every(path => path.startsWith(target.expectPath))).toBe(true);
      } finally {
        await fake.close();
      }
    }
  });

  it('fails closed when a site has no repository instead of using a global default', async () => {
    const broken = site('broken', '', '');
    const resolution = resolveSitePublisherTarget(config, broken);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toContain('refusing to fall back to a global default');

    const publisher = createSitePublisher(config, broken);
    await expect(publisher.openChange(input)).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
      status: 422,
    });
  });

  it('uses the deterministic fake only when github mode is off', () => {
    expect(createSitePublisher({ ...config, githubMode: 'off' }, site('x', 'o', 'r'))).toBeInstanceOf(
      FakeSitePublisher,
    );
  });
});
