/**
 * End-to-end KPI coverage.
 *
 * §5 is a contract in both directions: a metric cannot exist without a formula,
 * and a metric that exists must actually reach a surface. Without this test it
 * is easy to define a metric in the registry, never wire it, and have nobody
 * notice that a number leadership asked for is simply absent from the product.
 */
import { describe, expect, it } from 'vitest';
import { ALL_METRIC_IDS, getMetric } from '@/lib/metrics/registry';
import {
  appHealthModule,
  catalogueModule,
  issuesModule,
  journeyModule,
  salesModule,
  storesModule,
} from '@/lib/services/modules';
import { loyaltyModule } from '@/lib/services/loyalty';
import { trailingWindow } from '@/lib/format/dates';

const modules = await Promise.all([
  salesModule(trailingWindow(28)),
  journeyModule(trailingWindow(28)),
  storesModule(trailingWindow(28)),
  catalogueModule(),
  appHealthModule(trailingWindow(28)),
  issuesModule(),
  // ADR-001 — loyalty metrics must reach a surface like every other metric.
  loyaltyModule(trailingWindow(28)),
]);

const emitted = new Map(modules.flatMap((m) => m.kpis).map((k) => [k.id, k]));

describe('every §5 metric reaches a surface', () => {
  it('emits all of them', () => {
    const missing = ALL_METRIC_IDS.filter((id) => !emitted.has(id));
    expect(missing, `Defined in §5 but never surfaced: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries source, grain, refreshed time and state on every one', () => {
    for (const [id, k] of emitted) {
      expect(k.source, `${id} source`).toBeTruthy();
      expect(k.grain, `${id} grain`).toBeTruthy();
      expect(k.fetchedAt, `${id} fetchedAt`).toBeTruthy();
      expect(k.state, `${id} state`).toBeTruthy();
    }
  });

  it('matches each value to the label, unit and direction declared in §5', () => {
    for (const [id, k] of emitted) {
      const def = getMetric(id)!;
      expect(k.label).toBe(def.label);
      expect(k.unit).toBe(def.unit);
      expect(k.direction).toBe(def.direction);
    }
  });
});

describe('metrics with no feed are shown as missing, not omitted or zeroed', () => {
  it.each([
    ['true_coverage', 'SAP + RRA feeds are deferred (§13.9)'],
    ['geofence_delivery_rate', 'no backend feed yet'],
    ['time_to_order_p50', 'needs session-level GA4 extraction'],
  ])('%s renders as missing with a null value', (id) => {
    const k = emitted.get(id)!;
    expect(k.state).toBe('missing');
    // Zero would read as "the thing is broken"; null reads as "we do not know".
    expect(k.value).toBeNull();
  });
});

describe('module KPI headers answer their module’s question', () => {
  const [sales, journey, stores, catalogue, appHealth, issues] = modules;

  it('sales carries orders, revenue and AOV', () => {
    const ids = sales.kpis.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining(['orders', 'egmv', 'net_revenue', 'aov']));
  });

  it('journey carries every funnel conversion rate', () => {
    const ids = journey.kpis.map((k) => k.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'scan_success_rate', 'atc_rate', 'checkout_rate',
        'payment_success_rate', 'session_conversion',
      ]),
    );
  });

  it('stores carries the NOC operating metrics and rolls up by state', () => {
    const ids = stores.kpis.map((k) => k.id);
    expect(ids).toEqual(
      expect.arrayContaining(['stores_live', 'stores_active', 'stores_dark', 'daily_order_compliance']),
    );
    expect(stores.data.states.length).toBeGreaterThan(0);
    for (const st of stores.data.states) {
      expect(st.state).toBeTruthy();
      expect(st.region).toBeTruthy();
      expect(st.storesLive).toBeGreaterThan(0);
    }
  });

  it('catalogue keeps the three coverage measurements separate', () => {
    const ids = catalogue.kpis.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining(['unique_coverage', 'audited_coverage', 'true_coverage']));
    const scanObserved = catalogue.kpis.find((k) => k.id === 'unique_coverage')!.value!;
    const audited = catalogue.kpis.find((k) => k.id === 'audited_coverage')!.value!;
    // Customers mostly scan things that work; an auditor scans at random. The
    // audited figure running well below scan-observed is the expected finding,
    // not an error — and the two must never converge by accident.
    expect(audited).toBeLessThan(scanObserved);
  });

  it('app health decomposes its score and names any missing component', () => {
    expect(appHealth.data.score.components).toHaveLength(5);
    const ids = appHealth.kpis.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining(['app_health_score', 'crash_free_rate', 'p95_latency']));
  });

  it('issues carries the P0 state', () => {
    const ids = issues.kpis.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining(['p0_open', 'p0_age_p50', 'issues_unowned']));
  });
});

describe('the funnel ties to sales', () => {
  it('lands GA4 purchases within 10% of the order count (§16.8 cross-check)', async () => {
    const [sales, journey] = [modules[0], modules[1]];
    const orders = sales.kpis.find((k) => k.id === 'orders')!.value!;
    const purchases = journey.data.steps.find((s) => s.step === 'purchase')!.count!;
    // They never match exactly — client-side loss, ad blockers, session expiry —
    // but a widening gap means instrumentation or the order pipeline broke.
    expect(Math.abs(purchases - orders) / orders).toBeLessThan(0.1);
  });

  it('runs the full journey in order, ending at the uninstrumented de-tag step', () => {
    const steps = modules[1].data.steps;
    expect(steps.map((s) => s.step)).toEqual([
      'session_start', 'scanner_open', 'scan_attempt', 'scan_success', 'view_item',
      'add_to_cart', 'view_cart', 'begin_checkout', 'add_payment_info', 'purchase', 'invoice_detag',
    ]);
    // Each instrumented step is smaller than the one before it.
    const counts = steps.filter((s) => s.isInstrumented).map((s) => s.count!);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    // A6 — the last step of the core journey is invisible today.
    expect(steps.at(-1)!.isInstrumented).toBe(false);
    expect(steps.at(-1)!.count).toBeNull();
  });
});
