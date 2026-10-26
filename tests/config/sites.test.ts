import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadSiteConfigs, loadSiteConfigFile, validateSiteConfig } from '../../src/config/sites.js';

const validConfig = {
  id: 'bayjf.com',
  gsc: { siteUrl: 'https://bayjf.com/' },
  serp: { locationCode: 2840, languageCode: 'en', location: 'United States', language: 'English' },
  github: { owner: 'bayernjf', repo: 'bayjf', baseBranch: 'main' },
  watchQueries: ['growth agent'],
  keywordSeeds: ['byok seo'],
};

describe('site config validation (T-H1)', () => {
  it('accepts a valid config and keeps the shape', () => {
    const site = validateSiteConfig(validConfig);
    expect(site.id).toBe('bayjf.com');
    expect(site.gsc.siteUrl).toBe('https://bayjf.com/');
    expect(site.serp.locationCode).toBe(2840);
    expect(site.serp.languageCode).toBe('en');
    expect(site.github).toEqual({ owner: 'bayernjf', repo: 'bayjf', baseBranch: 'main' });
  });

  it('loads all three shipped dogfood site files', () => {
    const sites = loadSiteConfigs(join(process.cwd(), 'config', 'sites'));
    expect(sites.map(s => s.id).sort()).toEqual(['bayjf.com', 'job-agent-landing', 'zeus-landing']);
    for (const site of sites) {
      expect(site.gsc.siteUrl.endsWith('/')).toBe(true);
      expect(site.watchQueries.length).toBeGreaterThan(0);
      expect(site.keywordSeeds.length).toBeGreaterThan(0);
      expect(site.github.owner).toBe('bayernjf');
    }
  });

  it('loads a file from disk', () => {
    const site = loadSiteConfigFile(join(process.cwd(), 'config', 'sites', 'bayjf-com.json'));
    expect(site.id).toBe('bayjf.com');
  });

  const bad: Array<[string, unknown]> = [
    ['not an object', null],
    ['missing id', { ...validConfig, id: undefined }],
    ['bad gsc url (no trailing slash)', { ...validConfig, gsc: { siteUrl: 'https://bayjf.com' } }],
    ['non-absolute gsc url', { ...validConfig, gsc: { siteUrl: 'bayjf.com/' } }],
    ['non-integer location code', { ...validConfig, serp: { locationCode: 2840.5, languageCode: 'en' } }],
    ['bad language code', { ...validConfig, serp: { locationCode: 2840, languageCode: 'english' } }],
    ['missing github owner', { ...validConfig, github: { owner: '', repo: 'r', baseBranch: 'main' } }],
    ['watchQueries not strings', { ...validConfig, watchQueries: [1, 2] }],
    ['keywordSeeds not an array', { ...validConfig, keywordSeeds: 'q' }],
    ['missing gsc block', { ...validConfig, gsc: undefined }],
  ];
  for (const [label, raw] of bad) {
    it(`fails closed: ${label}`, () => {
      expect(() => validateSiteConfig(raw)).toThrow(/invalid site config/);
    });
  }

  it('aggregates multiple problems in one error', () => {
    expect(() =>
      validateSiteConfig({
        id: 'x',
        gsc: { siteUrl: 'no' },
        serp: { locationCode: -1, languageCode: 'xx' },
        github: { owner: '', repo: '', baseBranch: '' },
        watchQueries: [],
        keywordSeeds: [],
      }),
    ).toThrow(/siteUrl|locationCode|languageCode|owner|watchQueries|keywordSeeds/);
  });
});
