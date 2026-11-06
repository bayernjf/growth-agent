import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '..', 'scripts', 'check-site-urls.mjs');
const repoRoot = join(here, '..');
const shippedSites = join(repoRoot, 'config', 'sites');

function runCheck(sitesDir: string) {
  return spawnSync(process.execPath, [scriptPath, sitesDir], { encoding: 'utf8' });
}

function makeSitesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'site-urls-'));
  return dir;
}

function writeSite(dir: string, file: string, siteUrl: string) {
  writeFileSync(join(dir, file), JSON.stringify({ gsc: { siteUrl } }));
}

describe('check-site-urls placeholder guard', () => {
  it('passes the three shipped production site configs', () => {
    const r = runCheck(shippedSites);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('site config(s)');
  });

  it('exits 1 naming both the file and gsc.siteUrl for a pages.dev host', () => {
    const dir = makeSitesDir();
    try {
      writeSite(dir, 'bad.json', 'https://staging.pages.dev/');
      const r = runCheck(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('bad.json');
      expect(r.stderr).toContain('gsc.siteUrl');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an example.com placeholder with exit 1', () => {
    const dir = makeSitesDir();
    try {
      writeSite(dir, 'example.json', 'https://example.com/');
      const r = runCheck(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('example.json');
      expect(r.stderr).toContain('gsc.siteUrl');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a literal placeholder marker and a missing trailing slash', () => {
    const dir = makeSitesDir();
    try {
      writeSite(dir, 'ph.json', 'https://placeholder.example/');
      const marker = runCheck(dir);
      expect(marker.status).toBe(1);
      expect(marker.stderr).toContain('ph.json');

      writeSite(dir, 'noslash.json', 'https://bayjf.com');
      const noSlash = runCheck(dir);
      expect(noSlash.status).toBe(1);
      expect(noSlash.stderr).toContain('noslash.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the sites directory is empty or unreadable', () => {
    const empty = makeSitesDir();
    const missing = join(empty, 'does-not-exist');
    try {
      expect(runCheck(empty).status).toBe(1);
      expect(runCheck(missing).status).toBe(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('accepts a clean absolute https production URL', () => {
    const dir = makeSitesDir();
    try {
      writeSite(dir, 'good.json', 'https://search.bayjf.com/');
      const r = runCheck(dir);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
