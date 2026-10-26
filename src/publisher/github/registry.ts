// SitePublisher registry (T-D2). Mirrors the GSC/SERP/zeus registries:
//   - off (default) -> deterministic FakeSitePublisher (zero network).
//   - online + token/owner/repo -> GitHubPublisher (REST, no octokit).
//   - online without complete config -> RejectingGithubPublisher (422 on
//     any call); never silently downgraded to the fake.

import type { AppConfig } from '../../config.js';
import { FakeSitePublisher } from '../fake.js';
import type { SitePublisher } from '../types.js';
import { GitHubPublisher } from './http.js';
import { RejectingGithubPublisher } from './rejecting.js';

export function createSitePublisher(config: AppConfig): SitePublisher {
  if (config.githubMode === 'online') {
    if (!config.githubToken || !config.githubOwner || !config.githubRepo) {
      return new RejectingGithubPublisher(
        'GA_GITHUB_MODE=online requires GA_GITHUB_TOKEN, GA_GITHUB_OWNER and GA_GITHUB_REPO',
      );
    }
    return new GitHubPublisher({
      owner: config.githubOwner,
      repo: config.githubRepo,
      token: config.githubToken,
      baseBranch: config.githubBaseBranch,
    });
  }
  return new FakeSitePublisher();
}
