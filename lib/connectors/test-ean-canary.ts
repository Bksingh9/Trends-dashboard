/**
 * §7.10 / §30 #13 — Connector 13: `test-ean-canary`. P1, and nearly free.
 *
 * Nightly, Postgres-only: for every seeded test EAN, look up the most recent
 * result in `fact_scan_daily` and flag any known-good barcode that has started
 * failing. No new credentials, no new API.
 *
 * This is a cheap, high-signal regression detector — a known-good product going
 * unscannable is almost always an upstream catalogue break, and it shows up here
 * before the aggregate coverage number moves enough to trip a z-score.
 */
import { TEST_EANS } from '@/fixtures/baselines';
import { fixtureScanRows } from '@/fixtures/catalogue';
import { trailingWindow, type DateWindow } from '@/lib/format/dates';
import { rowVolume } from '@/lib/assertions';
import { getDb } from '@/lib/db/client';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

export interface CanaryRow {
  ean: string;
  expectedResult: 'found' | 'not_found';
  feature: string | null;
  source: string;
  sourceNote: string | null;
  lastActualResult: 'found' | 'not_found' | null;
  lastActualOn: string | null;
  /** True when a `found`-expected EAN came back `not_found` — an `act` anomaly. */
  regressed: boolean;
  /** True when a `not_found`-expected EAN now scans — a gap that got fixed. */
  recovered: boolean;
}

export class TestEanCanaryConnector extends BaseConnector<CanaryRow, CanaryRow> {
  readonly id = 'test-ean-canary';
  readonly displayName = 'Test EAN canary — catalogue regression detector';
  readonly freshnessSlaMinutes = 26 * 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P1' as const;
  readonly powers = ['/reference test EAN registry', 'early catalogue-break detection'];
  readonly blockedBy = 'DATABASE_URL — this connector needs no credentials, only the scan mart';

  isConfigured(): boolean {
    // Postgres-only. It needs no API key and no service account, so the single
    // thing that can block it is having nowhere to read from.
    //
    // Deliberately not "…and fact_scan_daily has rows": an empty mart is a
    // finding, not a configuration problem, and hiding it behind `configured:
    // false` would turn "the scan feed has stopped" into "this connector is not
    // set up" — the wrong diagnosis, pointing at the wrong team. The `rowVolume`
    // assertion is what reports the empty case, and it reports it as a failure.
    return getDb() != null;
  }

  protected async extract(w: DateWindow): Promise<CanaryRow[]> {
    const { getDb } = await import('@/lib/db/client');
    const { factScanDaily } = await import('@/lib/db/schema');
    const { and, gte, lte, inArray, desc } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return [];

    const eans = TEST_EANS.map((t) => t.ean);
    // Bounded by the window on purpose. Unbounded, `lastActualResult` could come
    // from a scan months old and read as current — a canary reporting a stale
    // "as expected" is worse than no canary, because it actively reassures.
    const rows = await db
      .select()
      .from(factScanDaily)
      .where(
        and(
          inArray(factScanDaily.ean, eans),
          gte(factScanDaily.dateKey, w.start),
          lte(factScanDaily.dateKey, w.end),
        ),
      )
      .orderBy(desc(factScanDaily.dateKey));

    return this.buildRows(
      rows.map((r) => ({ ean: r.ean, result: r.result as 'found' | 'not_found', dateKey: r.dateKey })),
    );
  }

  private buildRows(scans: Array<{ ean: string; result: 'found' | 'not_found'; dateKey: string }>): CanaryRow[] {
    const latest = new Map<string, { result: 'found' | 'not_found'; dateKey: string }>();
    for (const s of scans) {
      const cur = latest.get(s.ean);
      if (!cur || s.dateKey > cur.dateKey) latest.set(s.ean, { result: s.result, dateKey: s.dateKey });
    }

    return TEST_EANS.map((t) => {
      const actual = latest.get(t.ean) ?? null;
      return {
        ean: t.ean,
        expectedResult: t.expectedResult as 'found' | 'not_found',
        feature: t.feature ?? null,
        source: t.source,
        sourceNote: 'sourceNote' in t ? ((t as { sourceNote?: string }).sourceNote ?? null) : null,
        lastActualResult: actual?.result ?? null,
        lastActualOn: actual?.dateKey ?? null,
        regressed: t.expectedResult === 'found' && actual?.result === 'not_found',
        recovered: t.expectedResult === 'not_found' && actual?.result === 'found',
      };
    });
  }

  protected transform(rows: CanaryRow[]): CanaryRow[] {
    return rows;
  }

  protected async load(rows: CanaryRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { dimTestEan } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'dim_test_ean' };
    await db
      .insert(dimTestEan)
      .values(
        rows.map((r) => ({
          ean: r.ean,
          expectedResult: r.expectedResult,
          feature: r.feature,
          source: r.source,
          sourceNote: r.sourceNote,
          lastActualResult: r.lastActualResult,
          lastActualOn: r.lastActualOn,
        })),
      )
      .onConflictDoUpdate({
        target: dimTestEan.ean,
        set: {
          lastActualResult: sql`excluded.last_actual_result`,
          lastActualOn: sql`excluded.last_actual_on`,
        },
      });
    return { rowsIngested: rows.length, table: 'dim_test_ean' };
  }

  /** Fixture path reads the synthetic scan table, so the canary works in Phase 0. */
  protected fixture(w: DateWindow): CanaryRow[] {
    // The canary reads whatever window it was given; falling back to 14 days
    // only when called without one.
    const scans = fixtureScanRows(w?.start && w?.end ? w : trailingWindow(14));
    const relevant = scans.filter((s) => TEST_EANS.some((t) => t.ean === s.ean));
    return this.buildRows(relevant.map((s) => ({ ean: s.ean, result: s.result, dateKey: s.dateKey })));
  }

  readonly assertions: Assertion<CanaryRow>[] = [
    rowVolume<CanaryRow>({ tolerance: 0.5, zeroIsFail: false }),
  ];
}

export const testEanCanary = new TestEanCanaryConnector();

/** Run the canary and return anything that needs raising as an `act` anomaly. */
export async function runCanary(w: DateWindow): Promise<{ rows: CanaryRow[]; regressions: CanaryRow[] }> {
  const result = await testEanCanary.run(w);
  return { rows: result.rows, regressions: result.rows.filter((r) => r.regressed) };
}
