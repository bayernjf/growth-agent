// SitePublisher registry (T-D2). Mirrors the GSC/SERP/zeus registries:
//   - off (default) -> deterministic FakeSitePublisher (zero network).
//   - online + token + per-site owner/repo -> GitHubPublisher (REST, no octokit).
//   - online without complete config -> RejectingGithubPublisher (422 on
//     any call); never silently downgraded to the fake.
//
// F-05 (2026-11-02 review): the target repository is resolved from the SITE
// config, never from a deployment-wide GA_GITHUB_OWNER/REPO default. One
// deployment serves several site repositories, so a global default would open
// every site's PR in the same repository while the task prRef records the
// site's repository — the two would never match. A site without an explicit
// owner/repo fails closed instead of inheriting another site's target.

import type { AppConfig } from '../../config.js';
import type { SiteConfig } from '../../config/sites.js';
import { FakeSitePublisher } from '../fake.js';
import type { SitePublisher } from '../types.js';
import { GitHubPublisher } from './http.js';
import { RejectingGithubPublisher } from './rejecting.js';

export interface SitePublisherTarget {
  owner: string;
  repo: string;
  baseBranch: string;
  token: string;
}

export type SitePublisherResolution =
  | { ok: true; target: SitePublisherTarget }
  | { ok: false; reason: string };

/**
 * Resolve the GitHub target for one site. Exported so the CLI wiring and
 * tests can assert there is no global fallback: only the site's own
 * config/sites/*.json values (plus the deployment-level token) are used.
 */
export function resolveSitePublisherTarget(
  config: AppConfig,
  site: Pick<SiteConfig, 'id' | 'github'>,
): SitePublisherResolution {
  const owner = site.github.owner.trim();
  const repo = site.github.repo.trim();
  if (owner === '' || repo === '') {
    return {
      ok: false,
      reason: `site "${site.id}" has no github owner/repo; refusing to fall back to a global default`,
    };
  }
  if (!config.githubToken) {
    return {
      ok: false,
      reason: 'GA_GITHUB_MODE=online requires GA_GITHUB_TOKEN',
    };
  }
  return {
    ok: true,
    target: {
      owner,
      repo,
      baseBranch: site.github.baseBranch,
      token: config.githubToken,
    },
  };
}

export function createSitePublisher(config: AppConfig, site: SiteConfig): SitePublisher {
  if (config.githubMode !== 'online') {
    return new FakeSitePublisher();
  }
  const resolution = resolveSitePublisherTarget(config, site);
  if (!resolution.ok) {
    return new RejectingGithubPublisher(resolution.reason);
  }
  return new GitHubPublisher(resolution.target);
}
