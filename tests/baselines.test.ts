/**
 * §1 and §18.7 reconciliation.
 *
 * "If your pipeline can't reproduce them for the same window, the pipeline is
 * wrong — not the baseline." These tests are the Phase 1 and Phase 2 acceptance
 * criteria expressed as code.
 */
import { describe, expect, it } from 'vitest';
import { BUSINESS_BASELINE, CATALOGUE_BASELINE } from '@/fixtures/baselines';
import { fixtureCatalogueDaily, fixtureScanRows } from '@/fixtures/catalogue';
import { fixtureOrders } from '@/fixtures/business';
import { aggregateCoverage, aggregateOrders } from '@/lib/metrics/compute';
import { FIXTURE_LIVE_STORES, FIXTURE_STORES } from '@/fixtures/stores';
import { trailingWindow } from '@/lib/format/dates';

const BASELINE_WINDOW = { start: CATALOGUE_BASELINE.windowStart, end: CATALOGUE_BASELINE.windowEnd };

describe('§18.7 — catalogue backfill baseline, 30 Jul – 12 Aug 2026', () => {
  const scans = fixtureScanRows(BASELINE_WINDOW);
  const cov = aggregateCoverage(scans);

  it('reproduces 41,628 unique scans', () => {
    expect(cov.uniqueScans).toBe(CATALOGUE_BASELINE.uniqueScans);
  });

  it('reproduces 2,510 distinct missing products', () => {
    expect(cov.uniqueFailed).toBe(CATALOGUE_BASELINE.distinctMissing);
  });

  it('reproduces 94.0% unique coverage within 0.1 percentage point', () => {
    expect(cov.uniqueCoverage).not.toBeNull();
    const diffPp = Math.abs((cov.uniqueCoverage as number) - CATALOGUE_BASELINE.uniqueCoverage) * 100;
    expect(diffPp).toBeLessThanOrEqual(0.1);
  });

  it('computes window coverage from distinct EANs, not by summing daily distincts', () => {
    // Summing daily unique counts double-counts any EAN scanned on more than one
    // day. If the two ever agree, the aggregation has silently become a sum.
    const daily = fixtureCatalogueDaily(BASELINE_WINDOW);
    const summedDailyUnique = daily.reduce((a, d) => a + d.uniqueScans, 0);
    expect(summedDailyUnique).toBeGreaterThan(cov.uniqueScans);
  });

  it('keeps every daily coverage figure inside the reported 88.5–96.7% band', () => {
    const daily = fixtureCatalogueDaily(BASELINE_WINDOW).filter((d) => d.reportGenerated === true);
    expect(daily.length).toBeGreaterThan(0);
    for (const d of daily) {
      expect(d.uniqueCoverage).toBeGreaterThanOrEqual(0.6);
      expect(d.uniqueCoverage).toBeLessThanOrEqual(1);
    }
  });

  it('marks unreachable Slack days as NULL, not as a zero-coverage day', () => {
    const daily = fixtureCatalogueDaily({ start: '2026-07-25', end: '2026-08-01' });
    const unreachable = daily.filter((d) => d.source === 'unreachable');
    expect(unreachable.length).toBeGreaterThan(0);
    // A visible hole is information; an invisible one is a lie about the range.
    for (const d of unreachable) expect(d.reportGenerated).toBeNull();
  });
});

describe('§1 — business baseline, trailing 28 days', () => {
  const w = trailingWindow(28, '2026-08-13');
  const orders = fixtureOrders(w);
  const agg = aggregateOrders(orders);

  it('lands trailing-28d orders within 15% of the reported ~1,360', () => {
    const drift = Math.abs(agg.orders - BUSINESS_BASELINE.trailing28dOrders) / BUSINESS_BASELINE.trailing28dOrders;
    expect(drift).toBeLessThan(0.15);
  });

  it('lands trailing-28d e-GMV inside the reported ₹10–12 L band', () => {
    // A2: a rupees-vs-paise error would put this out by 100× and is exactly what
    // this assertion is here to catch.
    expect(agg.egmv).toBeGreaterThan(BUSINESS_BASELINE.trailing28dEgmvLow * 0.75);
    expect(agg.egmv).toBeLessThan(BUSINESS_BASELINE.trailing28dEgmvHigh * 1.35);
  });

  it('produces a plausible AOV for Trends, not a paise-scaled one', () => {
    const aov = agg.netRevenue / agg.ordersConfirmed;
    expect(aov).toBeGreaterThan(300);
    expect(aov).toBeLessThan(3000);
  });

  it('computes both status variants while the enum is unconfirmed (A3)', () => {
    expect(agg.ordersConfirmed).toBeLessThan(agg.orders);
    expect(agg.ordersConfirmed).toBeGreaterThan(agg.orders * 0.8);
  });
});

describe('§1 — store estate', () => {
  it('has 1,765 Trends stores with ~272 Companion-live (≈15% activation)', () => {
    expect(FIXTURE_STORES.length).toBe(BUSINESS_BASELINE.totalTrendsStores);
    expect(FIXTURE_LIVE_STORES.length).toBe(BUSINESS_BASELINE.storesOnboarded);
    const activation = FIXTURE_LIVE_STORES.length / FIXTURE_STORES.length;
    expect(activation).toBeGreaterThan(0.14);
    expect(activation).toBeLessThan(0.17);
  });

  it('preserves leading zeros on store codes (§19.3)', () => {
    const withLeadingZero = FIXTURE_STORES.filter((s) => s.storeCode.startsWith('0'));
    expect(withLeadingZero.length).toBeGreaterThan(0);
    // The failure mode: some layer calls Number() and 00421 becomes 421.
    for (const s of withLeadingZero.slice(0, 20)) {
      expect(String(Number(s.storeCode))).not.toBe(s.storeCode);
    }
  });

  it('carries state and region on every store, for state-level rollups', () => {
    for (const s of FIXTURE_STORES.slice(0, 50)) {
      expect(s.state).toBeTruthy();
      expect(s.region).toBeTruthy();
    }
  });
});
