// sentiment_daily_snapshot persistence (migration 009, W6 / OP-40).
//
// Idempotency mirrors gsc_daily_snapshot: same-day rerun OVERWRITES via
// ON CONFLICT on the unique key (keyword, source, snapshot_date, url), so the
// daily snapshot job refreshes corrected rows instead of failing on duplicates.

import type { StorageDriver } from '../../storage/driver.js';
import type { SentimentKind } from './types.js';

export interface SentimentSnapshotRow {
  keyword: string;
  source: string;
  /** YYYY-MM-DD. */
  date: string;
  title: string;
  url: string;
  sentiment: SentimentKind;
  metricValue: number;
}

interface SnapshotDbRow {
  keyword: string;
  source: string;
  snapshot_date: string;
  title: string;
  url: string;
  sentiment: string;
  metric_value: number;
}

export class SentimentSnapshotRepository {
  constructor(
    private readonly driver: StorageDriver,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async upsert(rows: SentimentSnapshotRow[]): Promise<void> {
    const at = this.now();
    for (const row of rows) {
      await this.driver.run(
        `INSERT INTO sentiment_daily_snapshot
           (keyword, source, snapshot_date, title, url, sentiment, metric_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (keyword, source, snapshot_date, url) DO UPDATE SET
           title = excluded.title,
           sentiment = excluded.sentiment,
           metric_value = excluded.metric_value,
           updated_at = excluded.updated_at`,
        [
          row.keyword,
          row.source,
          row.date,
          row.title,
          row.url,
          row.sentiment,
          row.metricValue,
          at,
          at,
        ],
      );
    }
  }

  async list(fromDate: string, toDate: string): Promise<SentimentSnapshotRow[]> {
    const rows = await this.driver.all<SnapshotDbRow>(
      `SELECT * FROM sentiment_daily_snapshot
       WHERE snapshot_date >= ? AND snapshot_date <= ?
       ORDER BY snapshot_date DESC, keyword ASC, source ASC`,
      [fromDate, toDate],
    );
    return rows.map((r) => this.toDomain(r));
  }

  /** Negative mentions in a window — the weekly-report alert source (OP-42). */
  async listNegative(fromDate: string, toDate: string): Promise<SentimentSnapshotRow[]> {
    const rows = await this.driver.all<SnapshotDbRow>(
      `SELECT * FROM sentiment_daily_snapshot
       WHERE snapshot_date >= ? AND snapshot_date <= ? AND sentiment = 'negative'
       ORDER BY snapshot_date DESC, keyword ASC`,
      [fromDate, toDate],
    );
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: SnapshotDbRow): SentimentSnapshotRow {
    return {
      keyword: row.keyword,
      source: row.source,
      date: row.snapshot_date,
      title: row.title,
      url: row.url,
      sentiment: row.sentiment as SentimentKind,
      metricValue: row.metric_value,
    };
  }
}
