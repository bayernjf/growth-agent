// Zero-credential first-run: the daily batch returns 0 candidates and used to
// say nothing else. These tests pin the explanation block and the fixture
// demo, including a real CLI run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBatch } from '../../src/cli/batch.js';
import { loadConfig } from '../../src/config.js';
import { formatDemoSelection, formatNoCandidates } from '../../src/scheduler/diagnose.js';
import type { SelectionResult } from '../../src/scheduler/candidates.js';

const ENV_KEYS = [
  'GA_GSC_MODE',
  'GA_GSC_CLIENT_ID',
  'GA_GSC_CLIENT_SECRET',
  'GA_GROWTH_MASTER_KEY',
  'GA_SERP_MODE',
  'GA_SERP_DATAFORSEO_LOGIN',
  'GA_SERP_DATAFORSEO_PASSWORD',
  'GA_REPO_ROOT',
] as const;

describe('zero-candidate diagnosis', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.GA_REPO_ROOT = new URL('../..', import.meta.url).pathname;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('names the missing credentials and the demo command', () => {
    const lines = formatNoCandidates(loadConfig(), 'new-site.example').join('\n');
    expect(lines).toContain('daily: 0 candidates for "new-site.example"');
    expect(lines).toContain('GA_GSC_CLIENT_ID');
    expect(lines).toContain('GA_SERP_DATAFORSEO_LOGIN');
    expect(lines).toContain('offline mode replays recorded fixtures');
    expect(lines).toContain('batch demo --site bayjf.com');
    expect(lines).toContain('task lifecycle');
  });

  it('does not claim fixtures when both connectors are online', () => {
    process.env.GA_GSC_MODE = 'online';
    process.env.GA_GSC_CLIENT_ID = 'id';
    process.env.GA_GSC_CLIENT_SECRET = 'secret';
    process.env.GA_GROWTH_MASTER_KEY = 'a'.repeat(64);
    process.env.GA_SERP_MODE = 'online';
    process.env.GA_SERP_DATAFORSEO_LOGIN = 'login';
    process.env.GA_SERP_DATAFORSEO_PASSWORD = 'pass';
    const lines = formatNoCandidates(loadConfig(), 'site.example').join('\n');
    expect(lines).toContain('both connectors are online');
    expect(lines).toContain('none of the candidate connectors are missing');
    expect(lines).not.toContain('offline mode');
  });
});

describe('formatDemoSelection', () => {
  const empty: SelectionResult = {
    selectedWrites: [],
    selectedFixes: [],
    deferredWrites: [],
    deferredFixes: [],
  };

  it('says the fixture day had no passing candidate instead of printing nothing', () => {
    expect(formatDemoSelection('bayjf.com', empty).join('\n')).toContain(
      'no candidate met the gates',
    );
  });

  it('prints the candidate query and page', () => {
    const selection: SelectionResult = {
      ...empty,
      selectedWrites: [{
        kind: 'write',
        query: 'byok seo automation',
        volume: 120,
        ownPosition: null,
        form: 'encyclopedic',
        alignmentScore: 0.8,
        signalId: 'write:byok seo automation',
      }],
      selectedFixes: [{
        kind: 'fix',
        pageUrl: 'https://bayjf.com/guides/legacy-guide',
        positionDelta: 4.5,
        impressionsLossRatio: 0.3,
        currentPosition: 12,
        currentImpressions: 70,
        previousImpressions: 100,
        signalId: 'fix:legacy',
      }],
    };
    const lines = formatDemoSelection('bayjf.com', selection).join('\n');
    expect(lines).toContain('byok seo automation');
    expect(lines).toContain('https://bayjf.com/guides/legacy-guide');
    expect(lines).toContain('not your site, nothing written');
  });
});

describe('batch demo CLI', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces fixture candidates without a database or credentials', async () => {
    process.env.GA_REPO_ROOT = new URL('../..', import.meta.url).pathname;
    await runBatch(['demo', '--site', 'bayjf.com']);
    const out = logs.join('\n');
    expect(out).toContain('demo: fixture data for "bayjf.com"');
    expect(out).toMatch(/write:|fix:/);
  });
});
