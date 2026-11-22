// Deterministic offline GSC provider (GA_GSC_MODE=off, the default).
//
// Mirrors growth-os OfflineSearchProvider: zero network, replays a recorded
// fixture so the daily snapshot job and the fixture run of the script are
// fully runnable without any Google credential. It is an explicit offline
// mode — online mode without OAuth config returns the rejecting provider,
// never this fixture silently.
//
// Replay honours the input dimensions: rows are filtered by the asked site
// (tolerating the sc-domain:/https:// spellings), the inclusive
// [startDate, endDate] window and the requested dimensions. A miss yields
// [] — never another site's rows and never another window's data.
//
// Opt-in `rolling` mode (GA_GSC_OFFLINE_ROLLING=1) shifts recorded dates so
// the newest row lands on a stable anchor (yesterday UTC by default, matching
// the daily window's end). It exists so a zero-credential dogfood run in
// November can still replay the October fixture; the data remains synthetic
// and is never presented as live GSC.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrowthAgentErrors } from '../../errors.js';
import type { GscAnalyticsInput, GscReadonlyProvider, GscRow, GscSite } from './types.js';

/** One recorded analytics row plus the request dimensions it was fetched with. */
interface GscFixtureRow {
  siteUrl: string;
  /** YYYY-MM-DD the row was recorded for. */
  date: string;
  /** The dimensions the keys align with, exactly as requested when recorded. */
  dimensions: GscAnalyticsInput['dimensions'];
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GscFixture {
  sites: GscSite[];
  analytics: GscFixtureRow[];
}

const here = dirname(fileURLToPath(import.meta.url));
// src/connector/gsc/offline.(js|ts) -> repo root is three levels up.
const repoRoot = process.env.GA_REPO_ROOT ?? join(here, '..', '..', '..');
const DEFAULT_FIXTURE_PATH = join(repoRoot, 'tests', 'fixtures', 'gsc-fixture.json');

/**
 * Normalise the siteUrl spellings GSC and site configs use
 * ("sc-domain:bayjf.com", "https://bayjf.com/", "bayjf.com") so replay
 * matches on the site identity, not on the spelling.
 */
function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl
    .replace(/^sc-domain:/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function loadFixture(path: string): GscFixture {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as GscFixture;
  if (!Array.isArray(parsed.sites) || !Array.isArray(parsed.analytics)) {
    throw GrowthAgentErrors.validation('gsc fixture must contain sites[] and analytics[]');
  }
  const rowsShaped = parsed.analytics.every(
    r => typeof r.siteUrl === 'string' && r.siteUrl !== ''
      && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)
      && Array.isArray(r.dimensions) && r.dimensions.length > 0
      && Array.isArray(r.keys),
  );
  if (!rowsShaped) {
    throw GrowthAgentErrors.validation(
      'gsc fixture analytics rows must carry siteUrl, date (YYYY-MM-DD), dimensions[] and keys[]',
    );
  }
  return parsed;
}

export interface OfflineGscOptions {
  /**
   * Shift recorded rows so the newest row for the asked site/dimensions lands
   * on this UTC date. Explicit synthetic replay for long-running
   * zero-credential dogfood; default false keeps strict recorded-date replay.
   */
  rolling?: boolean;
  /**
   * Stable anchor for rolling replay (YYYY-MM-DD). Defaults to yesterday UTC,
   * because the daily GSC windows end on day-1 (the current day is partial).
   */
  anchorDate?: string;
}

const DAY_MS = 86_400_000;

/** UTC date arithmetic; ISO date strings only, no local timezone drift. */
function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00.000Z`).getTime();
  const b = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / DAY_MS);
}

export class OfflineGscProvider implements GscReadonlyProvider {
  readonly name = 'gsc-offline';
  readonly mode = 'offline' as const;
  readonly rolling: boolean;
  private readonly fixture: GscFixture;
  private readonly anchorDate: string;

  /** Tests pass inline fixtures; production reads tests/fixtures/gsc-fixture.json. */
  constructor(
    fixture?: GscFixture,
    fixturePath: string = DEFAULT_FIXTURE_PATH,
    options: OfflineGscOptions = {},
  ) {
    this.fixture = fixture ?? loadFixture(fixturePath);
    this.rolling = options.rolling ?? false;
    this.anchorDate = options.anchorDate
      ?? new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  }

  async listSites(): Promise<GscSite[]> {
    return this.fixture.sites.map(s => ({ ...s }));
  }

  async queryAnalytics(input: GscAnalyticsInput): Promise<GscRow[]> {
    if (input.siteUrl === '') {
      throw GrowthAgentErrors.validation('queryAnalytics: siteUrl is required');
    }
    if (input.startDate === '' || input.endDate === '') {
      throw GrowthAgentErrors.validation('queryAnalytics: startDate and endDate are required');
    }
    if (input.dimensions.length === 0) {
      throw GrowthAgentErrors.validation('queryAnalytics: at least one dimension is required');
    }
    // Deterministic replay: filter the recorded rows by the asked site,
    // date window and dimension set; rowLimit is honoured over the filtered
    // set so callers can observe pagination pressure.
    const site = normalizeSiteUrl(input.siteUrl);
    const dimensions = input.dimensions.join(',');
    const siteRows = this.fixture.analytics.filter(
      r => normalizeSiteUrl(r.siteUrl) === site && r.dimensions.join(',') === dimensions,
    );

    // Strict replay: recorded dates only. Rolling replay: anchor the newest
    // recorded row to endDate, then apply the same day shift to every row so
    // the fixture's recorded intervals (and deltas) survive as the calendar
    // moves. This is explicitly synthetic, never a claim of live GSC data.
    let hits: GscFixtureRow[];
    if (this.rolling && siteRows.length > 0) {
      const anchor = siteRows.reduce(
        (max, row) => (row.date > max ? row.date : max),
        siteRows[0]?.date ?? input.endDate,
      );
      const shift = daysBetween(anchor, this.anchorDate);
      hits = siteRows.filter((row) => {
        const shifted = addDays(row.date, shift);
        return shifted >= input.startDate && shifted <= input.endDate;
      });
    } else {
      hits = siteRows.filter(
        r => r.date >= input.startDate && r.date <= input.endDate,
      );
    }
    return hits
      .slice(0, input.rowLimit ?? hits.length)
      .map(r => ({
        keys: [...r.keys],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));
  }
}
