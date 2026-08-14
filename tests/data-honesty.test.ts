/**
 * The trust layer: every figure on a page either ties to the figure above it,
 * or says why it does not.
 *
 * Each block here is a QA finding turned into a test. They exist because the
 * bugs they cover are all silent — a page with a mixed basis, a rounded-away
 * rate or an undeclared row cap looks exactly like a correct one, and the only
 * person who finds out is the reader who tries to add up a column.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aggregateOrders,
  measured,
  metricValue,
  noData,
  presence,
} from '@/lib/metrics/compute';
import { formatCount } from '@/lib/format/currency';
import { reconcileGapRegister } from '@/lib/metrics/reconcile';
import { gapRegisterCoverage } from '@/lib/assertions';
import { catalogueModule, salesModule, storesModule } from '@/lib/services/modules';
import { fixtureOrders } from '@/fixtures/business';
import { trailingWindow } from '@/lib/format/dates';

/* ── 1.1 a real zero and a missing measurement are different facts ────────── */

describe('1.1 — a measured zero never renders as "no data", and vice versa', () => {
  it('keeps a genuine zero live rather than downgrading it to missing', () => {
    const p = presence(0, true, 'unused');
    expect(p.state).toBe('live');
    expect(p.value).toBe(0);
    expect(metricValue('missing_new', p).state).toBe('live');
  });

  it('marks a metric missing when the window carries no data to measure it on', () => {
    const p = presence(0, false, 'No scan data for 2026-08-12');
    expect(p.state).toBe('missing');
    expect(p.value).toBeNull();
    expect(p.reason).toMatch(/No scan data/);
  });

  it('refuses to let an explicit state override a missing presence', () => {
    // The service layer passes `{ state: scans.state }` alongside the presence.
    // If a connector is live but *this particular measurement* is unmeasurable,
    // "live" must not win — that is precisely how a hole gets painted green.
    const v = metricValue('daily_order_compliance', noData('window ends before today'), {
      state: 'live',
    });
    expect(v.state).toBe('missing');
    expect(v.value).toBeNull();
  });

  it('measures daily compliance against the window\'s last day, not the wall clock', async () => {
    // Trailing windows end yesterday because today is partial. Anchoring the
    // metric to the wall clock looked for orders on a date the window does not
    // contain, found none, and printed 0.0% — a business collapse that was
    // really a date-range artefact. It must be a real rate on any window.
    for (const w of [trailingWindow(28), { start: '2026-06-01', end: '2026-06-14' }]) {
      const mod = await storesModule(w);
      const compliance = mod.kpis.find((k) => k.id === 'daily_order_compliance')!;
      expect(compliance.state, `${w.start}→${w.end}`).not.toBe('missing');
      expect(compliance.value, `${w.start}→${w.end}`).toBeGreaterThan(0);
      expect(compliance.value).toBeLessThanOrEqual(1);
    }
  });

  it('reports daily compliance as missing, not 0%, when the window yields nothing', async () => {
    // "No store ordered" and "we cannot tell" are different facts, and only one
    // of them is worth waking someone for. An inverted window is the degenerate
    // case that reaches this branch — a real feed outage takes the same path.
    const dead = await storesModule({ start: '2026-08-14', end: '2026-08-13' });
    const compliance = dead.kpis.find((k) => k.id === 'daily_order_compliance')!;
    expect(compliance.state).toBe('missing');
    expect(compliance.value).toBeNull();
    expect(compliance.notInstrumentedReason).toMatch(/not measurable/);
  });

  it('treats a plain number as measured', () => {
    expect(metricValue('orders', 1360).state).toBe('live');
    expect(measured(0).state).toBe('live');
  });

  it('prints a sub-unit rate instead of rounding it to a reassuring zero', () => {
    // orders_per_active_store genuinely runs at 0.24. Rounding it to 0 turns a
    // measured value into what reads as "no orders at all".
    expect(formatCount(0.24)).toBe('0.24');
    expect(formatCount(0.04)).toBe('0.04');
    expect(formatCount(2.5)).toBe('2.5');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(null)).toBe('—');
    // Large counts stay integers with Indian grouping.
    expect(formatCount(1360)).toBe('1,360');
    expect(formatCount(241_628)).toBe('2,41,628');
  });
});

/* ── 1.2 / 1.3 / 1.4 one basis per page ──────────────────────────────────── */

describe('1.2–1.4 — every breakdown shares the headline\'s basis', () => {
  const w = trailingWindow(90);

  it('sums the store table to the same revenue as the headline card', async () => {
    const mod = await salesModule(w);
    const headline = mod.kpis.find((k) => k.id === 'net_revenue')!.value!;
    const summed = mod.data.storeMatrix.reduce((a, r) => a + r.revenue, 0);
    expect(summed).toBeCloseTo(headline, 0);
  });

  it('sums the state table to the same revenue as the store table', async () => {
    const mod = await salesModule(w);
    const byStore = mod.data.storeMatrix.reduce((a, r) => a + r.revenue, 0);
    const byState = mod.data.stateMatrix.reduce((a, r) => a + r.revenue, 0);
    expect(byState).toBeCloseTo(byStore, 0);
  });

  it('sums both tables to the confirmed-order card, not the all-orders card', async () => {
    const mod = await salesModule(w);
    const confirmed = mod.kpis.find((k) => k.id === 'orders_confirmed')!.value!;
    expect(mod.data.storeMatrix.reduce((a, r) => a + r.orders, 0)).toBe(confirmed);
    expect(mod.data.stateMatrix.reduce((a, r) => a + r.orders, 0)).toBe(confirmed);
  });

  it('counts the order-value histogram on confirmed orders only', async () => {
    const mod = await salesModule(w);
    const confirmed = mod.kpis.find((k) => k.id === 'orders_confirmed')!.value!;
    const binned = mod.data.valueHistogram.reduce((a, b) => a + b.count, 0);
    expect(binned).toBe(confirmed);
  });

  it('proves the confirmed basis is narrower, so the tests above cannot pass trivially', async () => {
    // §15.4 / A3 — the status enum is still unresolved, so `orders` (all) and
    // `orders_confirmed` are both published and are deliberately different
    // numbers. If they ever converge these tests stop proving anything.
    const agg = aggregateOrders(fixtureOrders(w));
    expect(agg.ordersConfirmed).toBeLessThan(agg.orders);
  });

  it('keeps both order cards on the page so the basis is choosable, not assumed', async () => {
    const mod = await salesModule(w);
    expect(mod.kpis.find((k) => k.id === 'orders')).toBeDefined();
    expect(mod.kpis.find((k) => k.id === 'orders_confirmed')).toBeDefined();
  });
});

/* ── 1.5 a capped table declares what it hides ───────────────────────────── */

/** Every .tsx under the given roots, so these checks cannot be routed around. */
function tsxFiles(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tsx')) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

describe('1.5 — no table renders a subset without saying so', () => {
  it('never hands DataTable a pre-sliced array', () => {
    // A pre-sliced array is invisible to DataTable, so its header would claim
    // the truncated length is the whole set. Slicing belongs in the component,
    // where N, M, the sort key and the residual all come off one array.
    const files = tsxFiles('app', 'components');
    // A walker that silently finds nothing is a green test that checks nothing.
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // `rows={foo.slice(0, 200)}` — with or without a line break after `rows=`.
      if (/rows=\{[^}]*\.slice\(/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('declares limit, sort key, noun and residual wherever a cap is applied', () => {
    for (const f of tsxFiles('app')) {
      const src = readFileSync(f, 'utf8');
      // Each `truncation={{ ... }}` block must carry the full disclosure.
      for (const block of src.match(/truncation=\{\{[\s\S]*?\n\s*\}\}/g) ?? []) {
        expect(block, `${f}: truncation without a limit`).toMatch(/limit:/);
        expect(block, `${f}: truncation without a sort key`).toMatch(/sortKey:/);
        expect(block, `${f}: truncation without a row noun`).toMatch(/noun:/);
        expect(block, `${f}: truncation without a residual`).toMatch(/residual:/);
      }
    }
  });

  it('has an actual residual to disclose on the sales store table', async () => {
    // The disclosure is only worth testing if the table really does overflow.
    const mod = await salesModule(trailingWindow(90));
    expect(mod.data.storeMatrix.length).toBeGreaterThan(200);
  });
});

/* ── 1.6 the catalogue figures reconcile or explain themselves ───────────── */

describe('1.6 — observed, open and closed missing EANs are labelled separately', () => {
  it('partitions the register into open and closed', () => {
    const rec = reconcileGapRegister({
      observedDistinctMissing: 2510,
      gaps: [
        ...Array.from({ length: 2138 }, () => ({ status: 'open' })),
        ...Array.from({ length: 300 }, () => ({ status: 'resolved' })),
        ...Array.from({ length: 72 }, () => ({ status: 'wontfix' })),
      ],
    });
    expect(rec.registered).toBe(2510);
    expect(rec.open).toBe(2138);
    expect(rec.closed).toBe(372);
    expect(rec.unregistered).toBe(0);
    expect(rec.reconciled).toBe(true);
    expect(rec.line).toBe("2,510 observed · 2,138 open · 372 resolved or won't fix");
  });

  it('flags EANs observed failing that never reached the register', () => {
    const rec = reconcileGapRegister({
      observedDistinctMissing: 2510,
      gaps: Array.from({ length: 2400 }, () => ({ status: 'open' })),
    });
    expect(rec.unregistered).toBe(110);
    expect(rec.reconciled).toBe(false);
    expect(rec.line).toMatch(/110 observed but not registered/);
  });

  it('does not read a register larger than the observed set as a negative hole', () => {
    const rec = reconcileGapRegister({
      observedDistinctMissing: 100,
      gaps: Array.from({ length: 140 }, () => ({ status: 'open' })),
    });
    expect(rec.unregistered).toBe(0);
    expect(rec.reconciled).toBe(true);
  });

  it('fails the §6.3 gate when the register does not cover the observed misses', async () => {
    const ctx = { connector: 'test', window: { start: '2026-08-01', end: '2026-08-12' } };
    const gate = gapRegisterCoverage<{ status: string }>({ observedDistinctMissing: () => 2510 });

    const short = await gate.run(Array.from({ length: 2000 }, () => ({ status: 'open' })), ctx);
    expect(short.level).toBe('fail');
    expect(short.observed).toBe(2000);
    expect(short.expected).toBe(2510);

    const whole = await gate.run(
      [
        ...Array.from({ length: 2138 }, () => ({ status: 'open' })),
        ...Array.from({ length: 372 }, () => ({ status: 'resolved' })),
      ],
      ctx,
    );
    expect(whole.level).toBe('pass');
  });

  it('reconciles the live catalogue module and states the split on the page data', async () => {
    const mod = await catalogueModule();
    const rec = mod.data.gapReconciliation;
    const observed = mod.kpis.find((k) => k.id === 'missing_distinct')!.value!;

    expect(rec.observed).toBe(observed);
    expect(rec.open + rec.closed).toBe(rec.registered);
    expect(rec.reconciled).toBe(true);

    // The breakdowns count open gaps, and the line says which figure is which.
    const reasonTotal = mod.data.reasons.reduce((a, r) => a + r.count, 0);
    const agingTotal = mod.data.ageBuckets.reduce((a, b) => a + b.count, 0);
    expect(reasonTotal).toBe(rec.open);
    expect(agingTotal).toBe(rec.open);
    expect(rec.line).toContain(`${rec.open.toLocaleString('en-IN')} open`);
  });
});
