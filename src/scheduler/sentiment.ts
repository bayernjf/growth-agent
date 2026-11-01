// Sentiment alert scoring (OP-41). Pure functions, no I/O and no clock: the
// daily runner supplies the snapshot rows and the weekly report renders the
// resulting alerts. A negative mention becomes an alert once it crosses the
// per-keyword threshold (OP-42), so a single stray complaint does not flood the
// weekly report.

import type { SentimentSnapshotRow } from '../connector/sentiment/snapshot-repository.js';

/** A negative mention that crossed the alert threshold. */
export interface SentimentAlert {
  keyword: string;
  source: string;
  date: string;
  title: string;
  url: string;
}

/** Minimum negative mentions per keyword before an alert fires (OP-42). */
export const NEGATIVE_ALERT_THRESHOLD = 1;

/**
 * Negative mentions become alerts; the threshold is per keyword so a single
 * complaint does not fire. Sort is deterministic (newest first, then keyword).
 */
export function scoreSentimentAlerts(rows: SentimentSnapshotRow[]): SentimentAlert[] {
  const negativeByKeyword = new Map<string, SentimentSnapshotRow[]>();
  for (const row of rows) {
    if (row.sentiment !== 'negative') continue;
    const acc = negativeByKeyword.get(row.keyword) ?? [];
    acc.push(row);
    negativeByKeyword.set(row.keyword, acc);
  }

  const alerts: SentimentAlert[] = [];
  for (const [keyword, mentions] of negativeByKeyword) {
    if (mentions.length < NEGATIVE_ALERT_THRESHOLD) continue;
    for (const m of mentions) {
      alerts.push({ keyword, source: m.source, date: m.date, title: m.title, url: m.url });
    }
  }
  alerts.sort((a, b) => b.date.localeCompare(a.date) || a.keyword.localeCompare(b.keyword));
  return alerts;
}
