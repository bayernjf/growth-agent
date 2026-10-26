// gsc_daily_snapshot persistence (migration 003, design §4.1).
//
// Idempotency choice (fixed): same-day rerun of the 06:00 snapshot job
// OVERWRITES via ON CONFLICT on the unique key (site_url, snapshot_date,
// dimension_key) — corrected numbers replace stale ones; the job never
// fails with a duplicate-key error. Business SQL uses `?` placeholders;
// the postgres driver rewrites them to $n.

import type { StorageDriver } from '../../storage/driver.js';

export interface GscSnapshotRow {
  siteUrl: string;
  /** YYYY-MM-DD. */
  date: string;
  dimensionKey: string;
  clicks: number;
  impressions: number;
  position: number;
}

interface SnapshotDbRow {
  site_url: string;
  snapshot_date: string;
  dimension_key: string;
  clicks: number;
  impressions: number;
  position: number;
}

export class GscSnapshotRepository {
  constructor(
    private readonly driver: StorageDriver,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Upsert many rows; one statement per row (bounded by daily snapshot size). */
  async upsert(rows: GscSnapshotRow[]): Promise<void> {
    const at = this.now();
    for (const row of rows) {
      await this.driver.run(
        `INSERT INTO gsc_daily_snapshot
           (site_url, snapshot_date, dimension_key, clicks, impressions, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_url, snapshot_date, dimension_key) DO UPDATE SET
           clicks = excluded.clicks,
           impressions = excluded.impressions,
           position = excluded.position,
           updated_at = excluded.updated_at`,
        [
          row.siteUrl,
          row.date,
          row.dimensionKey,
          row.clicks,
          row.impressions,
          row.position,
          at,
          at,
        ],
      );
    }
  }

  async find(
    siteUrl: string,
    date: string,
    dimensionKey: string,
  ): Promise<GscSnapshotRow | undefined> {
    const row = await this.driver.get<SnapshotDbRow>(
      'SELECT * FROM gsc_daily_snapshot WHERE site_url = ? AND snapshot_date = ? AND dimension_key = ?',
      [siteUrl, date, dimensionKey],
    );
    return row === undefined ? undefined : this.toDomain(row);
  }

  async list(siteUrl: string, fromDate: string, toDate: string): Promise<GscSnapshotRow[]> {
    const rows = await this.driver.all<SnapshotDbRow>(
      `SELECT * FROM gsc_daily_snapshot
       WHERE site_url = ? AND snapshot_date >= ? AND snapshot_date <= ?
       ORDER BY snapshot_date DESC, dimension_key ASC`,
      [siteUrl, fromDate, toDate],
    );
    return rows.map(r => this.toDomain(r));
  }

  private toDomain(row: SnapshotDbRow): GscSnapshotRow {
    return {
      siteUrl: row.site_url,
      date: row.snapshot_date,
      dimensionKey: row.dimension_key,
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position,
    };
  }
}
