#!/usr/bin/env node
// Guard against placeholder GSC properties leaking into a site config.
//
// `config/sites/*.json` is mounted over the image copy at deploy time, so a
// stale host-side file can silently reintroduce a `*.pages.dev` placeholder
// even after the repo is fixed. This check runs in CI and in `check:all` and
// fails with the file + field that still needs a verified production URL.
//
// Usage: node scripts/check-site-urls.mjs [sites-dir]

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sitesDir = process.argv[2] ?? 'config/sites';

const PLACEHOLDER_HOSTS = [
  { pattern: /\.pages\.dev$/i, label: 'Cloudflare Pages preview host' },
  { pattern: /\.workers\.dev$/i, label: 'Cloudflare Workers preview host' },
  { pattern: /^(localhost|127\.0\.0\.1)$/i, label: 'local host' },
  { pattern: /^example\.(com|org|net)$/i, label: 'example host' },
];

const PLACEHOLDER_MARKERS = [
  { pattern: /placeholder/i, label: 'placeholder marker' },
  { pattern: /your-domain/i, label: 'your-domain marker' },
  { pattern: /change[-_]?me/i, label: 'change-me marker' },
  { pattern: /^https?:\/\/<[^>]+>\/?$/i, label: 'angle-bracket template' },
];

let files;
try {
  files = readdirSync(sitesDir).filter(f => f.endsWith('.json')).sort();
} catch (err) {
  console.error(`FAIL: cannot read ${sitesDir}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`FAIL: no site config files (*.json) found in ${sitesDir}`);
  process.exit(1);
}

const problems = [];

for (const file of files) {
  const source = join(sitesDir, file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(source, 'utf8'));
  } catch (err) {
    problems.push(`${source}: gsc.siteUrl cannot be checked, invalid JSON (${err instanceof Error ? err.message : String(err)})`);
    continue;
  }

  const siteUrl = parsed?.gsc?.siteUrl;
  if (typeof siteUrl !== 'string' || siteUrl.trim() === '') {
    problems.push(`${source}: gsc.siteUrl is missing`);
    continue;
  }

  let url;
  try {
    url = new URL(siteUrl);
  } catch {
    problems.push(`${source}: gsc.siteUrl is not an absolute URL (${siteUrl})`);
    continue;
  }

  if (!siteUrl.endsWith('/')) {
    problems.push(`${source}: gsc.siteUrl must end with "/" (${siteUrl})`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push(`${source}: gsc.siteUrl must use http(s) (${siteUrl})`);
  }

  const hostMatch = PLACEHOLDER_HOSTS.find(({ pattern }) => pattern.test(url.hostname));
  if (hostMatch) {
    problems.push(
      `${source}: gsc.siteUrl still points at a ${hostMatch.label} (${siteUrl}); use the verified production GSC property URL`,
    );
  }

  const markerMatch = PLACEHOLDER_MARKERS.find(({ pattern }) => pattern.test(siteUrl));
  if (markerMatch) {
    problems.push(`${source}: gsc.siteUrl contains a ${markerMatch.label} (${siteUrl})`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}

console.log(`OK: ${files.length} site config(s) use production GSC property URLs`);
