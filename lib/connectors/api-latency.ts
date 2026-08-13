/**
 * §25 — Connector 11: `api-latency`. P1 for `/app-health`, blocked on source (§13.7).
 *
 * A10 — the SLOs are placeholders. Real thresholds were never established, so
 * latency alerting stays gated behind `slo_confirmed` per endpoint. Placeholders
 * must not drive alerts: they produce either false breaches or missed real ones.
 */
import { rowVolume, range } from '@/lib/assertions';
import { CRITICAL_ENDPOINTS, DEFAULT_THRESHOLDS } from '@/lib/db/settings';
import type { DateWindow } from '@/lib/format/dates';
import { fixtureLatency, type LatencyRow } from '@/fixtures/business';
import { isBigQueryConfigured, runQuery } from '@/lib/gcp/bigquery';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

/**
 * Source preference (§25):
 *  1. Existing APM / OTel collector — ask first, someone has already measured
 *     p90/p95/p99 on 5–10 item carts for the sprint.
 *  2. Structured logs sunk to BigQuery, percentiles via APPROX_QUANTILES.
 *  3. Synthetic probes from the Playwright suite — a different measurement from
 *     real-user latency, labelled as such and never blended into the same series.
 */
export type LatencySource = 'apm' | 'bq_logs' | 'synthetic' | 'unconfigured';

export const LATENCY_BQ_SQL = (table: string) => `
SELECT
  DATE(timestamp, 'Asia/Kolkata') AS date_key,
  endpoint,
  APPROX_QUANTILES(duration_ms, 100)[OFFSET(50)] AS p50_ms,
  APPROX_QUANTILES(duration_ms, 100)[OFFSET(90)] AS p90_ms,
  APPROX_QUANTILES(duration_ms, 100)[OFFSET(95)] AS p95_ms,
  APPROX_QUANTILES(duration_ms, 100)[OFFSET(99)] AS p99_ms,
  COUNT(*) AS call_count,
  COUNTIF(status_code >= 500) AS error_count
FROM \`${table}\`
WHERE DATE(timestamp, 'Asia/Kolkata') BETWEEN @start_date AND @end_date
GROUP BY 1, 2
`.trim();

export class ApiLatencyConnector extends BaseConnector<LatencyRow, LatencyRow> {
  readonly id = 'api-latency';
  readonly displayName = 'API latency — five critical endpoints';
  readonly freshnessSlaMinutes = 90;
  readonly costTier: CostTier = 'metered';
  readonly priority = 'P1' as const;
  readonly powers = ['p95_latency', 'latency bands', 'App Health Score (latency component)'];
  readonly blockedBy = '§13.7 latency source undecided (APM vs logs vs synthetic); A10 real SLOs';

  private get logTable(): string {
    return process.env.BQ_LATENCY_TABLE ?? '';
  }

  source(): LatencySource {
    if (this.logTable && isBigQueryConfigured()) return 'bq_logs';
    if (process.env.LATENCY_SYNTHETIC === 'true') return 'synthetic';
    return 'unconfigured';
  }

  isConfigured(): boolean {
    return this.source() !== 'unconfigured';
  }

  protected async extract(w: DateWindow): Promise<LatencyRow[]> {
    const res = await runQuery<{
      date_key: string;
      endpoint: string;
      p50_ms: number;
      p90_ms: number;
      p95_ms: number;
      p99_ms: number;
      call_count: number;
      error_count: number;
    }>({
      query: LATENCY_BQ_SQL(this.logTable),
      params: { start_date: w.start, end_date: w.end },
      types: { start_date: 'DATE', end_date: 'DATE' },
      connector: this.id,
    });

    return res.rows.map((r) => ({
      dateKey: r.date_key,
      endpoint: r.endpoint,
      p50Ms: r.p50_ms,
      p90Ms: r.p90_ms,
      p95Ms: r.p95_ms,
      p99Ms: r.p99_ms,
      callCount: r.call_count,
      errorCount: r.error_count,
      sloP95Ms: DEFAULT_THRESHOLDS.slo_p95_ms[r.endpoint] ?? 0,
      sloConfirmed: DEFAULT_THRESHOLDS.slo_confirmed[r.endpoint] ?? false,
      source: 'real_user' as const,
    }));
  }

  protected transform(rows: LatencyRow[]): LatencyRow[] {
    const known = new Set(CRITICAL_ENDPOINTS.map((e) => e.id));
    return rows.filter((r) => known.has(r.endpoint as (typeof CRITICAL_ENDPOINTS)[number]['id']));
  }

  protected async load(rows: LatencyRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factApiLatency } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_api_latency' };
    await db
      .insert(factApiLatency)
      .values(rows)
      .onConflictDoUpdate({
        target: [factApiLatency.dateKey, factApiLatency.endpoint],
        set: {
          p50Ms: sql`excluded.p50_ms`,
          p90Ms: sql`excluded.p90_ms`,
          p95Ms: sql`excluded.p95_ms`,
          p99Ms: sql`excluded.p99_ms`,
          callCount: sql`excluded.call_count`,
          errorCount: sql`excluded.error_count`,
        },
      });
    return { rowsIngested: rows.length, table: 'fact_api_latency' };
  }

  protected fixture(w: DateWindow): LatencyRow[] {
    return fixtureLatency(w);
  }

  readonly assertions: Assertion<LatencyRow>[] = [
    rowVolume<LatencyRow>({ tolerance: 0.7, zeroIsFail: true }),
    range<LatencyRow>({ column: 'p95Ms', min: 0, max: 120_000, level: 'warn' }),
  ];
}

/** A10 — a breach only counts when the SLO behind it has been confirmed. */
export function isBreaching(row: LatencyRow): boolean {
  return row.sloConfirmed && row.sloP95Ms > 0 && row.p95Ms > row.sloP95Ms;
}

/** Over the placeholder SLO, but not alertable. Rendered as "over placeholder". */
export function isOverPlaceholder(row: LatencyRow): boolean {
  return !row.sloConfirmed && row.sloP95Ms > 0 && row.p95Ms > row.sloP95Ms;
}

export const apiLatency = new ApiLatencyConnector();
