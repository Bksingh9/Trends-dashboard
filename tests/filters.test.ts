/**
 * §9.3 — the query-param contract.
 *
 * The URL is the state. Two properties have to hold or a shared link stops
 * being the view the sender was looking at:
 *
 *   parse(serialize(f)) === f     no filter is lost in a round trip
 *   never throws                  a stale bookmark degrades, it does not 500
 *
 * The scoping tests below exist because the interesting failure is not "the
 * filter did nothing" — it is "the filter narrowed the table and left the
 * headline national", which looks entirely plausible on screen.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPARE_MODES,
  DEFAULT_TENANT,
  comparisonWindow,
  parseFilters,
  parseFiltersFromUrl,
  samePeriodLastMonth,
  serializeFilters,
  type Filters,
} from '@/lib/params/filters';
import { resolveScope } from '@/lib/services/scope';
import { catalogueModule, journeyModule, salesModule, storesModule } from '@/lib/services/modules';
import { aggregateOrders } from '@/lib/metrics/compute';
import { fixtureOrders } from '@/fixtures/business';
import { BUSINESS_BASELINE } from '@/fixtures/baselines';
import { relativeDelta } from '@/lib/metrics/compute';

const url = (qs: string) => new URL(`https://x.test/sales?${qs}`);

describe('§9.3 — parsing', () => {
  it('reads every param in the contract', () => {
    const f = parseFiltersFromUrl(
      url('start=2026-05-01&end=2026-05-31&store=00421&city=Mumbai&state=Maharashtra&tenant=trends&platform=ios&compare=same_weekday_last_week'),
    );
    expect(f.window).toEqual({ start: '2026-05-01', end: '2026-05-31' });
    expect(f.store).toBe('00421');
    expect(f.city).toBe('Mumbai');
    expect(f.state).toBe('Maharashtra');
    expect(f.tenant).toBe('trends');
    expect(f.platform).toBe('ios');
    expect(f.compare).toBe('same_weekday_last_week');
    expect(f.warnings).toEqual([]);
  });

  it('keeps a store code that leads with a zero as a string', () => {
    // §19.3 — `00421` and `421` are different stores. Any layer that treats a
    // store code as numeric silently merges them.
    expect(parseFiltersFromUrl(url('store=00421')).store).toBe('00421');
    expect(parseFiltersFromUrl(url('store=0000')).store).toBe('0000');
  });

  it('swaps a reversed range and says so', () => {
    const f = parseFiltersFromUrl(url('start=2026-05-31&end=2026-05-01'));
    expect(f.window).toEqual({ start: '2026-05-01', end: '2026-05-31' });
    expect(f.warnings.join(' ')).toMatch(/swapped/);
  });

  it('falls back to the default window on garbage rather than throwing', () => {
    for (const qs of ['start=lol&end=wat', 'start=2026-02-31&end=2026-03-01', 'start=&end=', 'end=2026-08-12']) {
      const f = parseFiltersFromUrl(url(qs));
      expect(() => f).not.toThrow();
      expect(f.window.start <= f.window.end).toBe(true);
    }
  });

  it('clamps a range that spans years, because that is always a typo', () => {
    const f = parseFiltersFromUrl(url('start=2016-01-01&end=2026-08-12'));
    expect(f.warnings.join(' ')).toMatch(/clamped/);
    expect(f.window.end).toBe('2026-08-12');
    expect(f.window.start > '2025-01-01').toBe(true);
  });

  it('rejects a compare mode that is not in the contract', () => {
    const f = parseFiltersFromUrl(url('compare=lol'));
    expect(f.compare).toBe('prev_period');
    expect(f.warnings.join(' ')).toMatch(/compare=lol/);
  });

  it('accepts every compare mode the UI offers', () => {
    for (const m of COMPARE_MODES) {
      const f = parseFiltersFromUrl(url(`compare=${m}`));
      expect(f.compare).toBe(m);
      expect(f.warnings).toEqual([]);
    }
  });

  it('rejects an unknown platform instead of filtering everything away', () => {
    const f = parseFiltersFromUrl(url('platform=windowsphone'));
    expect(f.platform).toBeUndefined();
    expect(f.warnings.join(' ')).toMatch(/platform=windowsphone/);
  });

  it('takes the first value when a param is repeated', () => {
    expect(parseFilters({ store: ['00421', '00999'] }).store).toBe('00421');
  });

  it('treats a whitespace-only value as absent', () => {
    expect(parseFilters({ store: '   ', city: '' }).store).toBeUndefined();
  });
});

/* ── round trip ──────────────────────────────────────────────────────────── */

describe('§9.3 — the URL round-trips exactly', () => {
  const cases: Filters[] = [
    { window: { start: '2026-05-01', end: '2026-05-31' }, tenant: DEFAULT_TENANT, compare: 'prev_period' },
    {
      window: { start: '2026-08-01', end: '2026-08-12' },
      store: '00421',
      tenant: DEFAULT_TENANT,
      compare: 'same_weekday_last_week',
    },
    {
      window: { start: '2026-01-01', end: '2026-01-31' },
      city: 'Mumbai',
      state: 'Maharashtra',
      platform: 'ios',
      tenant: 'ajio',
      compare: 'same_period_last_month',
    },
  ];

  for (const f of cases) {
    it(`survives ${serializeFilters(f)}`, () => {
      const back = parseFiltersFromUrl(url(serializeFilters(f)));
      expect(back.window).toEqual(f.window);
      expect(back.store).toBe(f.store);
      expect(back.city).toBe(f.city);
      expect(back.state).toBe(f.state);
      expect(back.platform).toBe(f.platform);
      expect(back.tenant).toBe(f.tenant);
      expect(back.compare).toBe(f.compare);
      expect(back.warnings).toEqual([]);
    });
  }

  it('omits the defaults so a shared link stays short', () => {
    const qs = serializeFilters(cases[0]);
    expect(qs).not.toMatch(/tenant=/);
    expect(qs).not.toMatch(/compare=/);
    // …but the parse still lands on them.
    expect(parseFiltersFromUrl(url(qs)).tenant).toBe(DEFAULT_TENANT);
    expect(parseFiltersFromUrl(url(qs)).compare).toBe('prev_period');
  });

  it('produces a stable key order, so the same view is always the same URL', () => {
    const a = serializeFilters(cases[2]);
    const b = serializeFilters({ ...cases[2] });
    expect(a).toBe(b);
  });
});

/* ── comparison windows ──────────────────────────────────────────────────── */

describe('§9.3 — compare picks a real denominator', () => {
  const w = { start: '2026-05-01', end: '2026-05-15' };

  it('prev_period is the immediately preceding span of the same length', () => {
    expect(comparisonWindow(w, 'prev_period')).toEqual({ start: '2026-04-16', end: '2026-04-30' });
  });

  it('same_weekday_last_week is exactly seven days back', () => {
    expect(comparisonWindow(w, 'same_weekday_last_week')).toEqual({ start: '2026-04-24', end: '2026-05-08' });
  });

  it('same_period_last_month is day-aligned, not minus-30-days', () => {
    // The whole point: a 1–15 May figure compares against 1–15 April, never
    // against all of April. That is the most common way growth gets overstated.
    expect(samePeriodLastMonth(w)).toEqual({ start: '2026-04-01', end: '2026-04-15' });
  });

  it('clamps a day that does not exist in the earlier month', () => {
    expect(samePeriodLastMonth({ start: '2026-03-29', end: '2026-03-31' })).toEqual({
      start: '2026-02-28',
      end: '2026-02-28',
    });
  });

  it('walks back across a year boundary', () => {
    expect(samePeriodLastMonth({ start: '2026-01-05', end: '2026-01-20' })).toEqual({
      start: '2025-12-05',
      end: '2025-12-20',
    });
  });
});

/* ── Revenue MoM ─────────────────────────────────────────────────────────── */

describe('§1 — Revenue MoM reproduces the Apr→May comparison', () => {
  it('computes +115% from the reported April and May figures', () => {
    // ₹3.29 L → ₹7.07 L. This pins the arithmetic to §1's own headline, which
    // is the number anyone checking this dashboard will have in their head.
    const mom = relativeDelta(BUSINESS_BASELINE.revenueMayMtd, BUSINESS_BASELINE.revenueApril);
    expect(mom).not.toBeNull();
    expect(mom! * 100).toBeCloseTo(114.9, 1);
    expect(Math.round(mom! * 100)).toBe(115);
  });

  it('measures the metric day-aligned, not month-to-date against a full month', async () => {
    // A 1–15 May window must be compared against 1–15 April. Comparing it
    // against all of April understates growth by roughly half, which is the
    // exact error the day-aligned window exists to prevent.
    const w = { start: '2026-05-01', end: '2026-05-15' };
    const mod = await salesModule({ window: w, tenant: DEFAULT_TENANT, compare: 'prev_period' });
    const card = mod.kpis.find((k) => k.id === 'revenue_mom')!;

    const may = aggregateOrders(fixtureOrders(w)).netRevenue;
    const aprAligned = aggregateOrders(fixtureOrders({ start: '2026-04-01', end: '2026-04-15' })).netRevenue;
    expect(card.value).toBeCloseTo(may / aprAligned - 1, 6);

    // …and specifically NOT against the whole of April.
    const aprFull = aggregateOrders(fixtureOrders({ start: '2026-04-01', end: '2026-04-30' })).netRevenue;
    expect(card.value).not.toBeCloseTo(may / aprFull - 1, 3);
  });

  it('keeps meaning month-on-month even when compare is set to something else', async () => {
    // A card named "Revenue MoM" that quietly becomes week-on-week when the
    // reader switches the comparison is worse than no card.
    const w = { start: '2026-05-01', end: '2026-05-15' };
    const values = await Promise.all(
      COMPARE_MODES.map(async (compare) => {
        const mod = await salesModule({ window: w, tenant: DEFAULT_TENANT, compare });
        return mod.kpis.find((k) => k.id === 'revenue_mom')!.value;
      }),
    );
    expect(new Set(values).size).toBe(1);
  });

  it('does move the ordinary deltas when compare changes', async () => {
    // The mirror of the test above — if nothing responded to `compare`, the
    // control would be decorative and the test above would prove nothing.
    const w = { start: '2026-05-01', end: '2026-05-15' };
    const a = await salesModule({ window: w, tenant: DEFAULT_TENANT, compare: 'prev_period' });
    const b = await salesModule({ window: w, tenant: DEFAULT_TENANT, compare: 'same_weekday_last_week' });
    const delta = (m: typeof a) => m.kpis.find((k) => k.id === 'net_revenue')!.deltaVsPrev;
    expect(delta(a)).not.toBe(delta(b));
  });
});

/* ── scoping ─────────────────────────────────────────────────────────────── */

const STORES = [
  { storeId: 's1', storeCode: '00421', storeName: 'Andheri', city: 'Mumbai', state: 'Maharashtra' },
  { storeId: 's2', storeCode: '00422', storeName: 'Bandra', city: 'Mumbai', state: 'Maharashtra' },
  { storeId: 's3', storeCode: '00500', storeName: 'Koramangala', city: 'Bengaluru', state: 'Karnataka' },
];

const base: Filters = { window: { start: '2026-05-01', end: '2026-05-15' }, tenant: DEFAULT_TENANT, compare: 'prev_period' };

describe('§9.3 — resolving a filter to a set of stores', () => {
  it('leaves the scope open when nothing is filtered', () => {
    const s = resolveScope(base, STORES);
    expect(s.storeIds).toBeNull();
    expect(s.description).toBeNull();
  });

  it('matches a store by code or by id', () => {
    expect([...resolveScope({ ...base, store: '00421' }, STORES).storeIds!]).toEqual(['s1']);
    expect([...resolveScope({ ...base, store: 's1' }, STORES).storeIds!]).toEqual(['s1']);
  });

  it('names the store it resolved to, so the header is not just a code', () => {
    expect(resolveScope({ ...base, store: '00421' }, STORES).description).toBe('Andheri (00421)');
  });

  it('warns on a code that matches nothing, rather than showing an empty page', () => {
    const s = resolveScope({ ...base, store: '99999' }, STORES);
    expect(s.storeIds!.size).toBe(0);
    expect(s.warnings.join(' ')).toMatch(/No store matches "99999"/);
  });

  it('intersects city and state rather than unioning them', () => {
    const s = resolveScope({ ...base, city: 'Mumbai', state: 'Karnataka' }, STORES);
    expect(s.storeIds!.size).toBe(0);
  });

  it('narrows by city', () => {
    expect([...resolveScope({ ...base, city: 'Mumbai' }, STORES).storeIds!].sort()).toEqual(['s1', 's2']);
  });
});

describe('§9.3 — a filter narrows the whole page, not just the table', () => {
  it('moves the sales headline and the store table together', async () => {
    const all = await salesModule(base);
    const biggest = all.data.storeMatrix[0];
    const one = await salesModule({ ...base, store: biggest.storeCode });

    expect(one.data.storeMatrix).toHaveLength(1);
    expect(one.data.storeMatrix[0].storeCode).toBe(biggest.storeCode);

    // The headline must have moved with it. A store filter that narrows the
    // table while leaving the card national is the bug this catches.
    const netOf = (m: typeof all) => m.kpis.find((k) => k.id === 'net_revenue')!.value!;
    expect(netOf(one)).toBeCloseTo(biggest.revenue, 0);
    expect(netOf(one)).toBeLessThan(netOf(all));

    // …and the header says the page is filtered.
    expect(one.scope).toContain(biggest.storeCode);
  });

  it('narrows stores_live on /stores, not only the store table', async () => {
    const all = await storesModule(base);
    const state = all.data.states[0].state;
    const one = await storesModule({ ...base, state });

    const liveOf = (m: typeof all) => m.kpis.find((k) => k.id === 'stores_live')!.value!;
    expect(liveOf(one)).toBeLessThan(liveOf(all));
    expect(liveOf(one)).toBe(one.data.rows.length);
    expect(one.data.rows.every((r) => r.state === state)).toBe(true);
  });

  it('splits the funnel by platform instead of blending it', async () => {
    const both = await journeyModule(base);
    const ios = await journeyModule({ ...base, platform: 'ios' });

    expect(both.data.byPlatform.length).toBeGreaterThan(1);
    expect(ios.data.byPlatform.map((p) => p.platform)).toEqual(['iOS']);
    // §16.7 — the split is the point: a blended rate hides one platform's
    // problem behind the other's volume.
    expect(ios.data.byPlatform[0].sessions).toBeLessThan(
      both.data.byPlatform.reduce((a, p) => a + p.sessions, 0),
    );
  });

  it('says out loud that the catalogue register stays national when scoped', async () => {
    const scoped = await catalogueModule({ ...base, city: 'Mumbai' });
    expect(scoped.warnings.join(' ')).toMatch(/register is EAN-grained and stays national/);
  });

  it('reports the unhonoured filters on app health rather than ignoring them', async () => {
    const { appHealthModule } = await import('@/lib/services/modules');
    const scoped = await appHealthModule({ ...base, store: '00421' });
    expect(scoped.warnings.join(' ')).toMatch(/no store or platform dimension/);
    expect(scoped.warnings.join(' ')).toMatch(/store=00421/);
  });

  it('survives a filter that matches nothing without producing NaN', async () => {
    const empty = await salesModule({ ...base, store: '99999' });
    expect(empty.data.storeMatrix).toEqual([]);
    for (const k of empty.kpis) {
      expect(Number.isNaN(k.value as number), `${k.id} is NaN`).toBe(false);
    }
    expect(empty.warnings.join(' ')).toMatch(/No store matches/);
  });
});

/* ── the baseline still holds unfiltered ─────────────────────────────────── */

describe('the default load is unchanged by the filter layer', () => {
  it('still reproduces the §1 trailing-28d order baseline', async () => {
    const mod = await storesModule();
    expect(mod.scope).toBeNull();
    expect(mod.kpis.find((k) => k.id === 'stores_live')!.value).toBe(BUSINESS_BASELINE.storesOnboarded);
  });
});
