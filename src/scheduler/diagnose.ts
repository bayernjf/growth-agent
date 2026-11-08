// Zero-candidate diagnosis for the morning batch.
//
// A new operator runs `batch daily` on a fresh site with no credentials and
// gets "deferred 0 write / 0 fix" — which looks like the product is broken.
// The pipeline did run: every connector is in offline fixture mode and the
// fixture has no rows for that site. This module turns that silence into one
// short block that names the missing credentials, what still works without
// them, and how to see a full pass on sample data.

import type { AppConfig } from '../config.js';
import type { SelectionResult } from './candidates.js';

export interface CredentialGroup {
  /** Human label of the capability this unlocks. */
  readonly unlocks: string;
  /** Environment variables that must all be set. */
  readonly env: readonly string[];
}

/** Credentials that change candidate output (not publishing/approval). */
export function missingCandidateCredentials(config: AppConfig): CredentialGroup[] {
  const groups: CredentialGroup[] = [];
  const gscReady = config.gscMode === 'online'
    && config.gscClientId !== undefined
    && config.gscClientSecret !== undefined
    && config.growthMasterKey !== undefined;
  if (!gscReady) {
    groups.push({
      unlocks: 'real Search Console pages (fix candidates)',
      env: ['GA_GSC_MODE=online', 'GA_GSC_CLIENT_ID', 'GA_GSC_CLIENT_SECRET', 'GA_GROWTH_MASTER_KEY'],
    });
  }
  const serpReady = config.serpMode === 'online'
    && config.serpLogin !== undefined
    && config.serpPassword !== undefined;
  if (!serpReady) {
    groups.push({
      unlocks: 'keyword volumes and SERP morphology (write candidates)',
      env: ['GA_SERP_MODE=online', 'GA_SERP_DATAFORSEO_LOGIN', 'GA_SERP_DATAFORSEO_PASSWORD'],
    });
  }
  return groups;
}

/**
 * Lines printed when a daily run completed but selected nothing. Deliberately
 * not a setup wizard: the operator can look at `batch demo` first and decide
 * later whether the credentials are worth it.
 */
export function formatNoCandidates(config: AppConfig, siteId: string): string[] {
  const groups = missingCandidateCredentials(config);
  const missing = groups.length === 0
    ? 'none of the candidate connectors are missing'
    : groups.map(g => `${g.env.join(' + ')} (${g.unlocks})`).join('; ');
  const offline = config.gscMode !== 'online' || config.serpMode !== 'online';
  return [
    `daily: 0 candidates for "${siteId}" — the run succeeded, the connectors returned no data.`,
    `  missing credentials: ${missing}`,
    offline
      ? '  offline mode replays recorded fixtures; a site whose queries were never recorded yields []'
      : '  both connectors are online: no row met the candidate gates (volume, rank, morphology)',
    '  what still works: task lifecycle, run ledger (`batch history`), weekly report/packet skeleton',
    `  see a full pass on sample data: batch demo --site bayjf.com${groups.length === 0 ? '' : ' (fixture data, nothing written)'}`,
  ];
}

/** One-line-per-candidate rendering shared by `batch demo`. */
export function formatDemoSelection(siteId: string, selection: SelectionResult): string[] {
  const lines: string[] = [
    `demo: fixture data for "${siteId}" — not your site, nothing written`,
  ];
  for (const write of selection.selectedWrites) {
    const own = write.ownPosition === null ? 'absent' : `#${write.ownPosition}`;
    lines.push(
      `  write: "${write.query}" volume=${write.volume} own=${own} form=${write.form} alignment=${write.alignmentScore}`,
    );
  }
  for (const fix of selection.selectedFixes) {
    lines.push(
      `  fix:   ${fix.pageUrl} position ${fix.positionDelta > 0 ? '+' : ''}${fix.positionDelta}`
        + ` impressions -${Math.round(fix.impressionsLossRatio * 100)}%`,
    );
  }
  if (selection.selectedWrites.length === 0 && selection.selectedFixes.length === 0) {
    lines.push('  no candidate met the gates for this fixture day');
  }
  lines.push(
    `  deferred by the 1+1 daily cap: ${selection.deferredWrites.length} write / ${selection.deferredFixes.length} fix`,
  );
  return lines;
}
