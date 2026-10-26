// Multi-site dogfood configuration (T-H1). Each site owns one GSC property,
// one SERP locale and one GitHub repository; the daily runner iterates site
// configs. Validation is strict and fail-closed: an invalid site file
// aborts the run with the full list of problems rather than silently
// operating on a half-configured site.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SiteGscConfig {
  /** Exact GSC property URL (must include protocol and trailing slash). */
  siteUrl: string;
}

export interface SiteSerpConfig {
  /** DataForSEO-style integer location code (e.g. 2840 = United States). */
  locationCode: number;
  /** ISO language code (e.g. en). */
  languageCode: string;
  location?: string;
  language?: string;
}

export interface SiteGithubConfig {
  owner: string;
  repo: string;
  baseBranch: string;
}

export interface SiteConfig {
  /** Stable site identifier, also the GSC site id used in storage. */
  id: string;
  gsc: SiteGscConfig;
  serp: SiteSerpConfig;
  github: SiteGithubConfig;
  /** Queries rankTracked daily. */
  watchQueries: string[];
  /** Seed keywords for write-candidate expansion. */
  keywordSeeds: string[];
}

function fail(errors: string[]): never {
  throw new Error(`invalid site config: ${errors.join('; ')}`);
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function looksLikeGscSiteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && value.endsWith('/');
}

/**
 * Validate one parsed JSON site config. Collects every problem so the
 * operator fixes them in one pass.
 */
export function validateSiteConfig(raw: unknown, source = 'site config'): SiteConfig {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail([`${source} must be a JSON object`]);
  }
  const obj = raw as Record<string, unknown>;

  if (!isString(obj.id)) errors.push(`${source}: id is required`);

  const gsc = obj.gsc as Record<string, unknown> | undefined;
  if (gsc === undefined || typeof gsc !== 'object') {
    errors.push(`${source}: gsc.siteUrl is required`);
  } else if (!isString(gsc.siteUrl) || !looksLikeGscSiteUrl(gsc.siteUrl)) {
    errors.push(`${source}: gsc.siteUrl must be an absolute URL ending with "/"`);
  }

  const serp = obj.serp as Record<string, unknown> | undefined;
  if (serp === undefined || typeof serp !== 'object') {
    errors.push(`${source}: serp {locationCode, languageCode} is required`);
  } else {
    if (typeof serp.locationCode !== 'number' || !Number.isInteger(serp.locationCode) || serp.locationCode <= 0) {
      errors.push(`${source}: serp.locationCode must be a positive integer`);
    }
    if (!isString(serp.languageCode) || !/^[a-z]{2}(-[A-Za-z0-9]+)?$/.test(serp.languageCode)) {
      errors.push(`${source}: serp.languageCode must be an ISO language code (e.g. en)`);
    }
  }

  const github = obj.github as Record<string, unknown> | undefined;
  if (github === undefined || typeof github !== 'object') {
    errors.push(`${source}: github {owner, repo, baseBranch} is required`);
  } else {
    if (!isString(github.owner)) errors.push(`${source}: github.owner is required`);
    if (!isString(github.repo)) errors.push(`${source}: github.repo is required`);
    if (!isString(github.baseBranch)) errors.push(`${source}: github.baseBranch is required`);
  }

  if (!Array.isArray(obj.watchQueries) || obj.watchQueries.some(q => !isString(q))) {
    errors.push(`${source}: watchQueries must be an array of non-empty strings`);
  }
  if (!Array.isArray(obj.keywordSeeds) || obj.keywordSeeds.some(q => !isString(q))) {
    errors.push(`${source}: keywordSeeds must be an array of non-empty strings`);
  }

  if (errors.length > 0) fail(errors);

  const serpObj = obj.serp as Record<string, unknown>;
  const gscObj = obj.gsc as Record<string, unknown>;
  const ghObj = obj.github as Record<string, unknown>;
  const out: SiteConfig = {
    id: (obj.id as string).trim(),
    gsc: { siteUrl: gscObj.siteUrl as string },
    serp: {
      locationCode: serpObj.locationCode as number,
      languageCode: serpObj.languageCode as string,
    },
    github: {
      owner: ghObj.owner as string,
      repo: ghObj.repo as string,
      baseBranch: ghObj.baseBranch as string,
    },
    watchQueries: (obj.watchQueries as unknown[]).map(q => String(q)),
    keywordSeeds: (obj.keywordSeeds as unknown[]).map(q => String(q)),
  };
  if (isString(serpObj.location)) out.serp.location = serpObj.location;
  if (isString(serpObj.language)) out.serp.language = serpObj.language;
  return out;
}

export function loadSiteConfigFile(path: string): SiteConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    fail([`${path}: cannot parse JSON (${err instanceof Error ? err.message : String(err)})`]);
  }
  return validateSiteConfig(parsed, path);
}

/** Load and validate every *.json site file in the directory (sorted). */
export function loadSiteConfigs(dir: string): SiteConfig[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new Error(`no site config files (*.json) found in ${dir}`);
  }
  return files.map(f => loadSiteConfigFile(join(dir, f)));
}
