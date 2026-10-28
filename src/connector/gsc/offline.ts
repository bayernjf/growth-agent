// Deterministic offline GSC provider (GA_GSC_MODE=off, the default).
//
// Mirrors growth-os OfflineSearchProvider: zero network, replays a recorded
// fixture so the daily snapshot job and the fixture run of the script are
// fully runnable without any Google credential. It is an explicit offline
// mode — online mode without OAuth config returns the rejecting provider,
// never this fixture silently.
//
// The tape is recorded per dimension and per window: `analytics.query` holds
// query-dimension rows and `analytics.page` holds one 28-day row set per
// recorded window (recent vs prior). Replay therefore keys on the same inputs
// the real searchanalytics endpoint keys on: the requested dimensions and the
// requested date range. The daily runner issues two back-to-back 28-day calls
// (recent then prior); the provider picks a window bucket by comparing the
// requested start date against the midpoint between the two recorded window
// starts — at/after the midpoint is the recent tape, earlier is the prior
// tape. This is stateless and stays correct for runs up to ~14 days after the
// recording date.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrowthAgentErrors } from '../../errors.js';
import type { GscAnalyticsInput, GscReadonlyProvider, GscRow, GscSite } from './types.js';

type GscDimension = GscAnalyticsInput['dimensions'][number];

interface GscWindow {
  start: string;
  end: string;
}

interface GscFixture {
  sites: GscSite[];
  windows: { recent: GscWindow; prior: GscWindow };
  analytics: {
    query: GscRow[];
    page: { recent: GscRow[]; prior: GscRow[] };
  };
}

const here = dirname(fileURLToPath(import.meta.url));
// src/connector/gsc/offline.(js|ts) -> repo root is three levels up.
const repoRoot = process.env.GA_REPO_ROOT ?? join(here, '..', '..', '..');
const DEFAULT_FIXTURE_PATH = join(repoRoot, 'tests', 'fixtures', 'gsc-fixture.json');

function loadFixture(path: string): GscFixture {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GscFixture>;
  if (!Array.isArray(parsed.sites)) {
    throw GrowthAgentErrors.validation('gsc fixture must contain sites[]');
  }
  const analytics = parsed.analytics;
  if (
    analytics === undefined ||
    !Array.isArray(analytics.query) ||
    analytics.page === undefined ||
    !Array.isArray(analytics.page.recent) ||
    !Array.isArray(analytics.page.prior)
  ) {
    throw GrowthAgentErrors.validation(
      'gsc fixture must contain analytics.query[], analytics.page.recent[] and analytics.page.prior[]',
    );
  }
  const windows = parsed.windows;
  if (
    windows === undefined ||
    typeof windows.recent?.start !== 'string' ||
    typeof windows.prior?.start !== 'string'
  ) {
    throw GrowthAgentErrors.validation('gsc fixture must contain windows.recent.start and windows.prior.start');
  }
  return parsed as GscFixture;
}

/** Pick the recorded window bucket the requested range belongs to. */
function selectWindow(startDate: string, windows: GscFixture['windows']): 'recent' | 'prior' {
  const midpoint = (Date.parse(windows.recent.start) + Date.parse(windows.prior.start)) / 2;
  return Date.parse(startDate) >= midpoint ? 'recent' : 'prior';
}

export class OfflineGscProvider implements GscReadonlyProvider {
  readonly name = 'gsc-offline';
  readonly mode = 'offline' as const;
  private readonly fixture: GscFixture;

  /** Tests pass inline fixtures; production reads tests/fixtures/gsc-fixture.json. */
  constructor(fixture?: GscFixture, fixturePath: string = DEFAULT_FIXTURE_PATH) {
    this.fixture = fixture ?? loadFixture(fixturePath);
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
    // Deterministic replay keyed on the requested dimension; the page tape is
    // further bucketed by window. rowLimit is honoured so callers can observe
    // pagination pressure.
    const dimension: GscDimension = input.dimensions[0] as GscDimension;
    let rows: GscRow[];
    if (dimension === 'page') {
      rows = this.fixture.analytics.page[selectWindow(input.startDate, this.fixture.windows)];
    } else {
      rows = dimension === 'query' ? this.fixture.analytics.query : [];
    }
    const limit = input.rowLimit ?? rows.length;
    return rows.slice(0, limit).map(r => ({ ...r, keys: [...r.keys] }));
  }
}
