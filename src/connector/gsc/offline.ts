// Deterministic offline GSC provider (GA_GSC_MODE=off, the default).
//
// Mirrors growth-os OfflineSearchProvider: zero network, replays a recorded
// fixture so the daily snapshot job and the fixture run of the script are
// fully runnable without any Google credential. It is an explicit offline
// mode — online mode without OAuth config returns the rejecting provider,
// never this fixture silently.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrowthAgentErrors } from '../../errors.js';
import type { GscAnalyticsInput, GscReadonlyProvider, GscRow, GscSite } from './types.js';

interface GscFixture {
  sites: GscSite[];
  analytics: GscRow[];
}

const here = dirname(fileURLToPath(import.meta.url));
// src/connector/gsc/offline.(js|ts) -> repo root is three levels up.
const repoRoot = process.env.GA_REPO_ROOT ?? join(here, '..', '..', '..');
const DEFAULT_FIXTURE_PATH = join(repoRoot, 'tests', 'fixtures', 'gsc-fixture.json');

function loadFixture(path: string): GscFixture {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as GscFixture;
  if (!Array.isArray(parsed.sites) || !Array.isArray(parsed.analytics)) {
    throw GrowthAgentErrors.validation('gsc fixture must contain sites[] and analytics[]');
  }
  return parsed;
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
    // Deterministic replay: rows carry one key (query dimension); rowLimit is
    // honoured so callers can observe pagination pressure.
    const limit = input.rowLimit ?? this.fixture.analytics.length;
    return this.fixture.analytics
      .slice(0, limit)
      .map(r => ({ ...r, keys: [...r.keys] }));
  }
}
