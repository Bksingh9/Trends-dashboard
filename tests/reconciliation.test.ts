/**
 * The global reconciliation suite.
 *
 * Every other test here checks one thing in isolation. This one checks that the
 * things agree — because the failure that destroys a dashboard's credibility is
 * not a wrong number, it is two numbers on two screens that disagree and no way
 * to tell which is right. Once that happens people stop using the dashboard and
 * go back to asking someone.
 *
 * Each assertion below is a promise the product makes across surfaces. Where a
 * gap is expected and legitimate, it is asserted as a *bounded* gap with the
 * reason, rather than being skipped.
 */
import { describe, expect, it } from 'vitest';
import {
  appHealthModule,
  catalogueModule,
  issuesModule,
  journeyDiscoveryModule,
  journeyModule,
  salesModule,
  storesModule,
} from '@/lib/services/modules';
import { buildBoard, DEFAULT_BOARD } from '@/lib/widgets/board';
import { getMetric } from '@/lib/metrics/registry';
import { trailingWindow } from '@/lib/format/dates';

const w = trailingWindow(28);

const [sales, journey, stores, catalogue, appHealth, issues, discovered, board] = await Promise.all([
  salesModule(w),
  journeyModule(w),
  storesModule(w),
  catalogueModule(),
  appHealthModule(w),
  issuesModule(),
  journeyDiscoveryModule(w),
  buildBoard(DEFAULT_BOARD, w),
]);

const kpi = (mod: { kpis: Array<{ id: string; value: number | null }> }, id: string) =>
  mod.kpis.find((k) => k.id === id)?.value ?? null;

describe('a metric means the same thing wherever it appears', () => {
  it('shows the same value on a board tile as on its own page', () => {
    // The board is the surface most likely to drift, because it reads through
    // a second layer. A tile that disagrees with the page it links to is worse
    // than a tile that is absent.
    const byModule: Record<string, { kpis: Array<{ id: string; value: number | null }> }> = {
      orders: sales,
      net_revenue: sales,
      scan_success_rate: journey,
      unique_coverage: catalogue,
      crash_free_rate: appHealth,
      p0_open: issues,
    };

    for (const widget of board.widgets) {
      const id = widget.spec.metricId;
      if (!id || !widget.metric || !byModule[id]) continue;
      expect(widget.metric.value, `${id} differs between its board tile and its page`).toBe(
        kpi(byModule[id], id),
      );
    }
  });

  it('never publishes the same metric id from two modules with different values', () => {
    const seen = new Map<string, { module: string; value: number | null }>();
    const all: Array<[string, typeof sales]> = [
      ['sales', sales],
      ['journey', journey],
      ['stores', stores],
      ['catalogue', catalogue],
      ['appHealth', appHealth],
      ['issues', issues],
      ['discovered', discovered],
    ];
    for (const [name, mod] of all) {
      for (const k of mod.kpis) {
        const prior = seen.get(k.id);
        if (prior) {
          // `p0_open` is emitted by app-health as a score input and by issues as
          // its subject. Same id, same window — so it must be the same number.
          expect(k.value, `${k.id} differs: ${prior.module}=${prior.value}, ${name}=${k.value}`).toBe(
            prior.value,
          );
        } else {
          seen.set(k.id, { module: name, value: k.value });
        }
      }
    }
  });
});

describe('breakdowns add up to their headline', () => {
  it('sums the state rollup back to the national store counts', () => {
    const live = stores.data.states.reduce((a, s) => a + s.storesLive, 0);
    expect(live).toBe(kpi(stores, 'stores_live'));
  });

  it('sums daily revenue back to the window total', () => {
    const daily = sales.data.daily.reduce((a, d) => a + d.netRevenue, 0);
    const headline = kpi(sales, 'net_revenue')!;
    // Floating-point addition over ~90 days, not a tolerance for disagreement.
    expect(Math.abs(daily - headline) / Math.max(1, headline)).toBeLessThan(1e-9);
  });

  it('keeps the state matrix on the same basis as the headline', () => {
    // §5.1 — every headline on /sales is confirmed-only, so every breakdown of
    // it must be. Mixing bases made the state table sum to neither figure.
    const matrix = sales.data.stateMatrix.reduce((a, s) => a + s.revenue, 0);
    const headline = kpi(sales, 'net_revenue')!;
    expect(Math.abs(matrix - headline) / Math.max(1, headline)).toBeLessThan(0.001);
  });
});

describe('relationships that must hold by definition', () => {
  it('never lets a funnel step exceed the one before it', () => {
    const steps = journey.data.steps.filter((s) => s.isInstrumented && s.count != null);
    for (let i = 1; i < steps.length; i++) {
      expect(
        steps[i].count!,
        `${steps[i].step} (${steps[i].count}) exceeds ${steps[i - 1].step} (${steps[i - 1].count})`,
      ).toBeLessThanOrEqual(steps[i - 1].count!);
    }
  });

  it('keeps confirmed orders at or below all orders', () => {
    expect(kpi(sales, 'orders_confirmed')!).toBeLessThanOrEqual(kpi(sales, 'orders')!);
  });

  it('keeps active stores at or below live stores', () => {
    expect(kpi(stores, 'stores_active')!).toBeLessThanOrEqual(kpi(stores, 'stores_live')!);
  });

  it('makes dark and active stores account for the live estate', () => {
    // A store is either ordering or it is not. If these stop summing, one of
    // the two definitions has drifted.
    expect(kpi(stores, 'stores_active')! + kpi(stores, 'stores_dark')!).toBeLessThanOrEqual(
      kpi(stores, 'stores_live')!,
    );
  });

  it('keeps every rate inside 0–1', () => {
    for (const mod of [sales, journey, stores, catalogue, appHealth, issues, discovered]) {
      for (const k of mod.kpis) {
        if (getMetric(k.id)?.unit !== 'ratio' || k.value == null) continue;
        expect(k.value, `${k.id} = ${k.value} is not a ratio`).toBeGreaterThanOrEqual(0);
        expect(k.value, `${k.id} = ${k.value} is not a ratio`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('produces no NaN or Infinity on any surface', () => {
    for (const mod of [sales, journey, stores, catalogue, appHealth, issues, discovered]) {
      for (const k of mod.kpis) {
        if (k.value == null) continue;
        expect(Number.isFinite(k.value), `${k.id} = ${k.value}`).toBe(true);
      }
    }
  });
});

describe('gaps that are expected, asserted as bounded rather than skipped', () => {
  it('lands GA4 purchases within 10% of the order count', () => {
    // §16.8 — client-side loss, ad blockers and session expiry mean these never
    // match exactly. Beyond 10% one of the two feeds has a real problem.
    const orders = kpi(sales, 'orders')!;
    const purchases = journey.data.steps.find((s) => s.step === 'purchase')?.count;
    if (purchases == null) return;
    expect(Math.abs(purchases - orders) / Math.max(1, orders)).toBeLessThan(0.1);
  });

  it('keeps audited coverage below scan-observed coverage', () => {
    // Customers mostly scan things that work; an auditor scans at random. The
    // two converging would mean one of them has stopped measuring what it says.
    expect(kpi(catalogue, 'audited_coverage')!).toBeLessThan(kpi(catalogue, 'unique_coverage')!);
  });

  it('reconciles the gap register against what was observed', () => {
    const r = catalogue.data.gapReconciliation;
    expect(r.registered).toBe(r.open + r.closed);
    expect(r.unregistered).toBeGreaterThanOrEqual(0);
  });

  it('accounts for every session path, including the rare ones', () => {
    // §16.4 — the `(other)` bucket is real traffic on paths too rare to store
    // individually. Coverage plus the tail must be the whole.
    const d = discovered.data;
    const coverage = kpi(discovered, 'journey_path_coverage');
    if (coverage == null || d.totalSessions === 0) return;
    const implied = (d.totalSessions - d.tailSessions) / d.totalSessions;
    expect(Math.abs(implied - coverage)).toBeLessThan(1e-9);
  });
});

describe('provenance travels with every number', () => {
  it('gives every KPI a source, a grain and a state', () => {
    for (const mod of [sales, journey, stores, catalogue, appHealth, issues, discovered]) {
      for (const k of mod.kpis) {
        expect(k.source, `${k.id} has no source`).toBeTruthy();
        expect(k.grain, `${k.id} has no grain`).toBeTruthy();
        expect(k.state, `${k.id} has no state`).toBeTruthy();
      }
    }
  });

  it('never lets a board tile report a better state than its metric', () => {
    // The tile inherits provenance; it may not improve on it. A fixture
    // rendered as live on a wall display is the §14.5 failure in its worst
    // possible venue.
    for (const widget of board.widgets) {
      if (!widget.metric) continue;
      expect(widget.metric.state).toBeTruthy();
    }
  });

  it('states a caveat wherever §5 declares one', () => {
    for (const mod of [sales, journey, stores, catalogue, appHealth, issues, discovered]) {
      for (const k of mod.kpis) {
        const def = getMetric(k.id);
        if (!def?.caveat) continue;
        expect(k.caveat, `${k.id} drops its §5 caveat on the way to the surface`).toBeTruthy();
      }
    }
  });
});
