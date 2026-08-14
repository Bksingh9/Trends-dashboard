/**
 * §16.5 — Connector 15: `bq-ga4-scans`. P0.
 *
 * The scan half of the GA4 export. `bq-ga4-events` owns the funnel and loads
 * `fact_funnel_daily`; this owns the scans and loads `fact_scan_daily`.
 *
 * They are separate connectors rather than one, because the lifecycle is
 * one-row-type per connector and these are genuinely different grains — a
 * funnel step keyed by step name, a scan keyed by EAN and result. Sharing the
 * class would mean a union type and a `load()` that branches on which half it
 * was handed, which is how the wrong rows end up in the wrong table.
 *
 * It exists because nothing loaded `fact_scan_daily` at all. The SQL, the
 * EAN-hygiene partition and the assertions had all been written; the table was
 * read by `/catalogue`, `/stores`, the Scan Strip and the test-EAN canary, and
 * no connector ever filled it. With a database configured, every one of those
 * would have found an empty mart and silently fallen back to fixtures — the
 * §18.7 coverage baseline included.
 */
import { config } from '@/lib/config';
import { cardinality, freshness, nullRate, rowVolume, valueSet } from '@/lib/assertions';
import { bqSuffix, type DateWindow } from '@/lib/format/dates';
import { isBigQueryConfigured, runQuery } from '@/lib/gcp/bigquery';
import { fixtureScanRows } from '@/fixtures/catalogue';
import { BaseConnector } from './base';
import { partitionScanRows, SCAN_SQL, type ScanAggregateRow } from './bq-ga4-events';
import type { Assertion, CostTier, LoadResult } from './types';

interface RawScanRow {
  date_key: string;
  store_id: string | null;
  ean: unknown;
  result: string | null;
  platform: string | null;
  sales_channel: string | null;
  scan_count: number;
  session_count: number;
}

export class BqGa4ScansConnector extends BaseConnector<RawScanRow, ScanAggregateRow> {
  readonly id = 'bq-ga4-scans';
  readonly displayName = 'BigQuery — GA4 scan events';
  // Matches `bq-ga4-events`: GA4's daily export is finalised up to 48h late, so
  // claiming anything tighter would mark a healthy feed stale every morning.
  readonly freshnessSlaMinutes = 48 * 60;
  readonly costTier: CostTier = 'metered';
  readonly priority = 'P0' as const;
  readonly powers = [
    'fact_scan_daily',
    'unique_coverage / total_coverage (§5.3)',
    'the Scan Strip',
    '/catalogue store × coverage',
    'test-ean-canary',
  ];
  readonly blockedBy = '§13.1 GA4→BQ dataset name (unknown); §13.2 GCP service account';

  isConfigured(): boolean {
    return isBigQueryConfigured() && Boolean(config.bqGa4Dataset);
  }

  protected async extract(w: DateWindow): Promise<RawScanRow[]> {
    const res = await runQuery<RawScanRow>({
      query: SCAN_SQL(),
      params: { suffix_start: bqSuffix(w.start), suffix_end: bqSuffix(w.end) },
      types: { suffix_start: 'STRING', suffix_end: 'STRING' },
      connector: this.id,
    });
    return res.rows;
  }

  protected transform(rows: RawScanRow[]): ScanAggregateRow[] {
    // §16.5.1 — junk in the `ean` param is recorded and classified, never
    // silently dropped. A rising rejection rate is an app instrumentation bug,
    // and discarding those rows would make it invisible while dragging reported
    // coverage down for a reason nobody could find.
    const { valid, rejected, rejectionRate } = partitionScanRows(
      rows.map((r) => ({
        dateKey: r.date_key,
        storeId: r.store_id ?? '',
        ean: r.ean,
        result: r.result ?? '',
        platform: r.platform ?? '',
        salesChannel: r.sales_channel ?? '',
        scanCount: Number(r.scan_count ?? 0),
        sessionCount: Number(r.session_count ?? 0),
      })),
    );

    if (rejected.length > 0) {
      // Surfaced on `/catalogue` next to coverage rather than buried in a log.
      console.warn(
        `[${this.id}] rejected ${rejected.length} EAN groups (${(rejectionRate * 100).toFixed(2)}% of scans): ` +
          rejected
            .slice(0, 5)
            .map((r) => `${r.reason}×${r.scanCount}`)
            .join(', '),
      );
    }

    return valid;
  }

  protected async load(rows: ScanAggregateRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factScanDaily } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_scan_daily' };

    // Chunked: a 3-day window across 272 stores runs to tens of thousands of
    // rows, and Postgres has a hard cap on bind parameters per statement.
    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(factScanDaily)
        .values(rows.slice(i, i + 500))
        .onConflictDoUpdate({
          // §27.5 — the natural key. Re-running a window must replace it, not
          // double it: the whole point of a wide re-run window is that the same
          // day is loaded several times as late rows arrive.
          target: [
            factScanDaily.dateKey,
            factScanDaily.storeId,
            factScanDaily.ean,
            factScanDaily.result,
            factScanDaily.platform,
          ],
          set: {
            scanCount: sql`excluded.scan_count`,
            sessionCount: sql`excluded.session_count`,
            salesChannel: sql`excluded.sales_channel`,
          },
        });
    }
    return { rowsIngested: rows.length, table: 'fact_scan_daily' };
  }

  protected fixture(w: DateWindow): ScanAggregateRow[] {
    return fixtureScanRows(w).map((r) => ({
      dateKey: r.dateKey,
      storeId: r.storeId,
      ean: r.ean,
      result: r.result,
      platform: r.platform,
      salesChannel: r.salesChannel,
      scanCount: r.scanCount,
      sessionCount: r.sessionCount,
    }));
  }

  readonly assertions: Assertion<ScanAggregateRow>[] = [
    freshness<ScanAggregateRow>({ column: 'dateKey', maxLagHours: 48, level: 'warn' }),
    rowVolume<ScanAggregateRow>({ tolerance: 0.4, zeroIsFail: true }),
    // A scan row with no EAN is meaningless — coverage is computed per EAN.
    nullRate<ScanAggregateRow>({ columns: ['ean', 'dateKey'], max: 0, level: 'fail' }),
    valueSet<ScanAggregateRow>({ column: 'result', allowed: ['found', 'not_found'], level: 'fail' }),
    // §16.5 — a collapse in distinct stores means the `store_id` param has
    // stopped being sent, which reads as a national coverage change rather than
    // an instrumentation break unless it is caught here.
    cardinality<ScanAggregateRow>({ column: 'storeId', minDistinct: 20, level: 'warn' }),
  ];
}

export const bqGa4Scans = new BqGa4ScansConnector();
