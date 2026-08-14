/**
 * §28.8 — The evaluation harness. Do not ship the AI layer without it.
 *
 * The stale-pipeline and not-instrumented cases matter most: an AI layer that
 * reports a pipeline outage as a sales collapse to Reliance leadership is worse
 * than having no AI layer at all.
 */
import { describe, expect, it } from 'vitest';
import { detectAnomalies, robustZ, type MetricHistory } from '@/lib/ai/anomaly';
import { evaluateRca } from '@/lib/ai/rca';
import { buildInsightContext, assertNoPii } from '@/lib/ai/context';
import { deterministicBrief, findFabricatedNumbers } from '@/lib/ai/brief';
import { extractCitedMetrics } from '@/lib/ai/prompts';
import { guardSql } from '@/lib/ai/sql-guard';
import { metricValue } from '@/lib/metrics/compute';
import { DEFAULT_THRESHOLDS } from '@/lib/db/settings';

const OPTS = {
  zThreshold: DEFAULT_THRESHOLDS.anomaly_z_threshold,
  wowThreshold: DEFAULT_THRESHOLDS.anomaly_wow_threshold,
};

function history(values: number[], salePeriodIdx: number[] = []) {
  return values.map((value, i) => ({
    dateKey: `2026-07-${String(i + 1).padStart(2, '0')}`,
    value,
    isSalePeriod: salePeriodIdx.includes(i),
  }));
}

function metric(id: string, label: string, current: number, values: number[], lastWeek?: number): MetricHistory {
  return {
    metricId: id,
    label,
    current,
    history: history(values),
    sameWeekdayLastWeek: lastWeek ?? values.at(-7) ?? null,
    unit: 'count',
    direction: 'up_good',
  };
}

const STEADY = [50, 48, 52, 49, 51, 47, 53, 50, 49, 51, 48, 52, 50, 49];

describe('robust z uses MAD, not σ', () => {
  it('is not blown out by a single sale-day spike', () => {
    // A single sale day would inflate σ and mask real problems for a month.
    const withSpike = [...STEADY, 400];
    const z = robustZ(30, withSpike);
    expect(Math.abs(z)).toBeGreaterThan(2.5);
  });

  it('returns 0 when the value equals a zero-variance baseline', () => {
    expect(robustZ(50, [50, 50, 50, 50, 50])).toBe(0);
  });
});

describe('scenario: orders drop 20%, payment success drop 15%', () => {
  const anomalies = detectAnomalies(
    [
      metric('orders', 'Orders', 40, STEADY, 50),
      {
        metricId: 'payment_success_rate',
        label: 'Payment success rate',
        current: 0.78,
        history: history([0.93, 0.94, 0.92, 0.93, 0.95, 0.93, 0.94, 0.93, 0.92, 0.94]),
        sameWeekdayLastWeek: 0.93,
        unit: 'ratio',
        direction: 'up_good',
      },
    ],
    OPTS,
  );

  it('flags both metrics', () => {
    const ids = anomalies.map((a) => a.metricId);
    expect(ids).toContain('orders');
    expect(ids).toContain('payment_success_rate');
  });

  it('leads with payment_path and points at /app-health', () => {
    const rca = evaluateRca({
      anomalies,
      unhealthyConnectors: [],
      gapConcentratedInFewStores: false,
      funnelRatesFlat: false,
      recentRelease: null,
      missingNewSpike: false,
    });
    expect(rca[0].rule.id).toBe('payment_path');
    expect(rca[0].rule.module).toBe('/app-health');
  });
});

describe('scenario: coverage drop concentrated in 3 stores', () => {
  const anomalies = detectAnomalies(
    [
      {
        metricId: 'unique_coverage',
        label: 'Unique coverage',
        current: 0.88,
        history: history([0.94, 0.94, 0.95, 0.94, 0.93, 0.94, 0.95, 0.94, 0.94, 0.93]),
        sameWeekdayLastWeek: 0.94,
        unit: 'ratio',
        direction: 'up_good',
      },
    ],
    OPTS,
  );

  it('leads with store_local, NOT upstream_ingestion', () => {
    // Confusing these sends the wrong team at the problem.
    const rca = evaluateRca({
      anomalies,
      unhealthyConnectors: [],
      gapConcentratedInFewStores: true,
      funnelRatesFlat: false,
      recentRelease: null,
      missingNewSpike: true, // even with a spike, concentration wins
    });
    expect(rca[0].rule.id).toBe('store_local');
    expect(rca.map((r) => r.rule.id)).not.toContain('upstream_ingestion');
  });

  it('leads with upstream_ingestion when the drop is broad instead', () => {
    const rca = evaluateRca({
      anomalies,
      unhealthyConnectors: [],
      gapConcentratedInFewStores: false,
      funnelRatesFlat: false,
      recentRelease: null,
      missingNewSpike: true,
    });
    expect(rca[0].rule.id).toBe('upstream_ingestion');
  });
});

describe('scenario: bq-orders stale, orders reads 0', () => {
  const anomalies = detectAnomalies([metric('orders', 'Orders', 0, STEADY, 50)], {
    ...OPTS,
    redConnectorMetrics: new Set(['orders']),
  });

  it('detects the zero-value as act severity', () => {
    const zero = anomalies.find((a) => a.metricId === 'orders');
    expect(zero?.test).toBe('zero_value');
    expect(zero?.severity).toBe('act');
  });

  it('suppresses metrics downstream of a red connector', () => {
    // Ten alerts caused by one broken pipe teaches people to ignore alerts.
    expect(anomalies.find((a) => a.metricId === 'orders')?.suppressed).toBe(true);
  });

  it('leads with pipeline_not_business and must not report a business decline', () => {
    const rca = evaluateRca({
      anomalies,
      unhealthyConnectors: ['bq-orders'],
      gapConcentratedInFewStores: false,
      funnelRatesFlat: false,
      recentRelease: null,
      missingNewSpike: false,
    });
    expect(rca[0].rule.id).toBe('pipeline_not_business');
    expect(rca[0].rule.priority).toBe('always_first');
    // The business explanations must not outrank the pipeline one.
    expect(rca.slice(1).map((r) => r.rule.id)).not.toContain('payment_path');
  });

  it('says so in the deterministic brief rather than reporting a sales collapse', () => {
    const ctx = buildInsightContext({
      window: { start: '2026-08-01', end: '2026-08-13' },
      metrics: [metricValue('orders', 0, { state: 'stale' })],
      anomalies,
      openP0: [],
      catalogueDeltas: { newMissing: 0, resolved: 0, topReasons: [] },
      storeSignals: { active: 0, dark7d: 0, compliancePct: 0, topDeclining: [], topDecliningStates: [] },
      connectorHealth: [{ id: 'bq-orders', status: 'red', lastRun: '2026-08-01' }],
      calendar: { isSalePeriod: false, saleName: null, comparabilityWarning: null },
    });
    const brief = deterministicBrief(ctx);
    expect(brief.body).toMatch(/connector/i);
    expect(brief.body).toMatch(/rather than as business results/i);
    expect(brief.body).toMatch(/Look at first: \/connectors/);
  });
});

describe('scenario: sale period, orders up 60%', () => {
  it('does not flag a sale-period spike against a sale-excluded baseline', () => {
    // Indian retail runs on sale events; a 40% spike during a sale is not an
    // anomaly, and without the calendar the model explains seasonality as an
    // incident.
    const saleAware: MetricHistory = {
      metricId: 'orders',
      label: 'Orders',
      current: 80,
      // Prior sale days sit in the history but are excluded from the baseline,
      // so the current sale day is compared against normal days only.
      history: history([50, 48, 52, 49, 80, 82, 79, 50, 49, 51, 48, 52], [4, 5, 6]),
      sameWeekdayLastWeek: 79,
      unit: 'count',
      direction: 'up_good',
    };
    const anomalies = detectAnomalies([saleAware], OPTS);
    // It may flag on z (it is genuinely above the non-sale baseline), but the
    // week-over-week comparison against last week's sale day must not fire.
    const wow = anomalies.filter((a) => a.test === 'wow');
    expect(wow).toHaveLength(0);
  });

  it('carries the comparability warning into the context', () => {
    const ctx = buildInsightContext({
      window: { start: '2026-08-08', end: '2026-08-13' },
      metrics: [],
      anomalies: [],
      openP0: [],
      catalogueDeltas: { newMissing: 0, resolved: 0, topReasons: [] },
      storeSignals: { active: 0, dark7d: 0, compliancePct: 0, topDeclining: [], topDecliningStates: [] },
      connectorHealth: [],
      calendar: {
        isSalePeriod: true,
        saleName: 'Independence Day Sale',
        comparabilityWarning: 'Sale period — period-on-period comparisons are affected',
      },
    });
    const brief = deterministicBrief(ctx);
    expect(brief.body).toMatch(/Independence Day Sale/);
  });
});

describe('scenario: add_to_cart not instrumented', () => {
  it('reports an instrumentation gap and never a 0% add-to-bag rate', () => {
    const ctx = buildInsightContext({
      window: { start: '2026-08-01', end: '2026-08-13' },
      metrics: [
        metricValue('atc_rate', null, { state: 'not_instrumented', notInstrumentedReason: 'add_to_cart absent from GTM' }),
      ],
      anomalies: [],
      openP0: [],
      catalogueDeltas: { newMissing: 0, resolved: 0, topReasons: [] },
      storeSignals: { active: 0, dark7d: 0, compliancePct: 0, topDeclining: [], topDecliningStates: [] },
      connectorHealth: [],
      calendar: { isSalePeriod: false, saleName: null, comparabilityWarning: null },
    });
    const atc = ctx.metrics.find((m) => m.id === 'atc_rate')!;
    expect(atc.state).toBe('not_instrumented');
    expect(atc.value).toBeNull(); // never 0
  });
});

describe('scenario: everything flat', () => {
  it('says so plainly and briefly, with no manufactured drama', () => {
    const anomalies = detectAnomalies([metric('orders', 'Orders', 50, STEADY, 50)], OPTS);
    expect(anomalies).toHaveLength(0);
    const ctx = buildInsightContext({
      window: { start: '2026-08-01', end: '2026-08-13' },
      metrics: [metricValue('orders', 50)],
      anomalies,
      openP0: [],
      catalogueDeltas: { newMissing: 0, resolved: 0, topReasons: [] },
      storeSignals: { active: 200, dark7d: 4, compliancePct: 0.8, topDeclining: [], topDecliningStates: [] },
      connectorHealth: [{ id: 'bq-orders', status: 'green', lastRun: '2026-08-13' }],
      calendar: { isSalePeriod: false, saleName: null, comparabilityWarning: null },
    });
    const brief = deterministicBrief(ctx);
    expect(brief.body).toMatch(/No metric crossed its anomaly threshold/);
    expect(brief.body.length).toBeLessThan(400);
  });
});

describe('§28.7 guardrails', () => {
  it('rejects a context containing PII before it reaches the model', () => {
    expect(() => assertNoPii({ note: 'contact ravi@example.com' })).toThrow(/email address/);
    expect(() => assertNoPii({ note: 'call 9876543210' })).toThrow(/mobile number/);
    expect(() => assertNoPii({ storeCode: '00421', orders: 42 })).not.toThrow();
  });

  it('detects numbers in model output that are absent from the context', () => {
    const ctx = buildInsightContext({
      window: { start: '2026-08-01', end: '2026-08-13' },
      metrics: [metricValue('orders', 1360)],
      anomalies: [],
      openP0: [],
      catalogueDeltas: { newMissing: 0, resolved: 0, topReasons: [] },
      storeSignals: { active: 0, dark7d: 0, compliancePct: 0, topDeclining: [], topDecliningStates: [] },
      connectorHealth: [],
      calendar: { isSalePeriod: false, saleName: null, comparabilityWarning: null },
    });
    expect(findFabricatedNumbers('Orders were [orders] 1360 this window.', ctx)).toHaveLength(0);
    // A brief containing invented numbers would be read as fact by leadership.
    expect(findFabricatedNumbers('Orders were 98765 this window.', ctx).length).toBeGreaterThan(0);
  });

  it('extracts cited metric ids so citation can be asserted, not assumed', () => {
    expect(extractCitedMetrics('Coverage [unique_coverage] fell while [orders] held.')).toEqual([
      'unique_coverage',
      'orders',
    ]);
  });
});

describe('§28.6 SQL guard', () => {
  it('accepts a bounded SELECT over allowlisted tables', () => {
    const g = guardSql('SELECT store_id, SUM(orders) FROM fact_store_adoption_daily GROUP BY 1 LIMIT 10');
    expect(g.ok).toBe(true);
    expect(g.appliedLimit).toBe(10);
  });

  it.each([
    ['DELETE FROM fact_orders', /Forbidden/],
    ['SELECT * FROM pg_user', /Forbidden|allowlist/],
    ['SELECT 1; DROP TABLE fact_orders', /Forbidden/],
    ['SELECT * FROM information_schema.tables', /Forbidden|allowlist/],
    ['SELECT * FROM secret_table', /allowlist/],
  ])('rejects %s', (sql, pattern) => {
    const g = guardSql(sql);
    expect(g.ok).toBe(false);
    expect(g.violations.join(' ')).toMatch(pattern);
  });

  it('adds a LIMIT when none is present and clamps an oversized one', () => {
    expect(guardSql('SELECT * FROM dim_store').sql).toMatch(/LIMIT 5000/);
    expect(guardSql('SELECT * FROM dim_store LIMIT 999999').appliedLimit).toBe(5000);
  });

  it('allows CTE names without treating them as unknown tables', () => {
    const g = guardSql(
      'WITH recent AS (SELECT * FROM fact_orders LIMIT 100) SELECT count(*) FROM recent LIMIT 1',
    );
    expect(g.ok).toBe(true);
  });

  it('strips markdown fences a model may emit', () => {
    const g = guardSql('```sql\nSELECT 1 FROM dim_store\n```');
    expect(g.sql).not.toMatch(/```/);
  });
});

describe('per-store and per-state sweep — what the global detector cannot see', () => {
  const cohort = (n: number, value: number, weight = 500) =>
    Array.from({ length: n }, (_, i) => ({
      entityId: `s${i}`,
      entityLabel: `Store ${i}`,
      value,
      weight,
      state: i < n / 2 ? 'Maharashtra' : 'Delhi',
    }));

  it('finds one broken store that 270 healthy ones would drown', async () => {
    const { detectEntityAnomalies } = await import('@/lib/ai/entity-anomaly');
    const stores = [
      ...cohort(40, 0.94),
      { entityId: 'broken', entityLabel: 'Trends, Broken Mall', value: 0.42, weight: 800, state: 'Delhi' },
    ];
    const found = detectEntityAnomalies(stores, {
      metricId: 'store_coverage', metricLabel: 'Coverage', entityType: 'store',
      worseWhen: 'below', unit: 'ratio',
    });
    expect(found[0].entityId).toBe('broken');
    expect(found[0].severity).toBe('act');
    // The global mean barely moves — 40 stores at 94% and one at 42% averages
    // to 92.7%, which no history-based z-score would flag.
    const mean = stores.reduce((a, s) => a + s.value, 0) / stores.length;
    expect(mean).toBeGreaterThan(0.92);
  });

  it('ignores a low-volume store whose percentage is statistically meaningless', async () => {
    const { detectEntityAnomalies } = await import('@/lib/ai/entity-anomaly');
    const found = detectEntityAnomalies(
      [...cohort(40, 0.94), { entityId: 'tiny', entityLabel: 'Tiny', value: 0.25, weight: 4, state: 'Delhi' }],
      { metricId: 'store_coverage', metricLabel: 'Coverage', entityType: 'store', worseWhen: 'below', unit: 'ratio' },
    );
    // 1 of 4 scans failing is not a finding; letting it rank would push real
    // breakages off the top of the list.
    expect(found.map((f) => f.entityId)).not.toContain('tiny');
  });

  it('refuses to call a cohort of fewer than eight entities', async () => {
    const { detectEntityAnomalies } = await import('@/lib/ai/entity-anomaly');
    expect(
      detectEntityAnomalies([...cohort(5, 0.94), { entityId: 'x', entityLabel: 'X', value: 0.2, weight: 500, state: 'D' }], {
        metricId: 'store_coverage', metricLabel: 'Coverage', entityType: 'store', worseWhen: 'below', unit: 'ratio',
      }),
    ).toEqual([]);
  });

  it('calls a few deep failures concentrated, sending it to store_local', async () => {
    const { concentration } = await import('@/lib/ai/entity-anomaly');
    const c = concentration(
      [...cohort(40, 0.95), ...Array.from({ length: 3 }, (_, i) => ({
        entityId: `bad${i}`, entityLabel: `Bad ${i}`, value: 0.3, weight: 900, state: 'Delhi',
      }))],
      { worseWhen: 'below' },
    );
    expect(c.verdict).toBe('concentrated');
    expect(c.explanation).toMatch(/store-local or regional/);
  });

  it('calls a broad shallow decline systemic, sending it upstream', async () => {
    const { concentration } = await import('@/lib/ai/entity-anomaly');
    // Every store down a little is an ingestion problem, not 40 store problems.
    const spread = Array.from({ length: 40 }, (_, i) => ({
      entityId: `s${i}`, entityLabel: `Store ${i}`, value: 0.95 - (i % 20) * 0.012, weight: 500, state: 'MH',
    }));
    const c = concentration(spread, { worseWhen: 'below' });
    expect(c.verdict).toBe('systemic');
    expect(c.explanation).toMatch(/upstream/);
  });

  it('rolls stores up to states weighted by volume, not by store count', async () => {
    const { rollUpToStates } = await import('@/lib/ai/entity-anomaly');
    const states = rollUpToStates([
      { entityId: 'a', entityLabel: 'A', value: 0.5, weight: 1000, state: 'Delhi' },
      { entityId: 'b', entityLabel: 'B', value: 1.0, weight: 10, state: 'Delhi' },
    ]);
    const delhi = states.find((s) => s.entityId === 'Delhi')!;
    // An unweighted mean would say 75%; the state is really running at ~50%.
    expect(delhi.value).toBeLessThan(0.52);
    expect(delhi.weight).toBe(1010);
  });
});

describe('a cohort with zero spread must not silence the sweep', () => {
  it('flags an outlier even when every peer is identical (MAD = 0)', async () => {
    const { detectEntityAnomalies } = await import('@/lib/ai/entity-anomaly');
    // robustZ returns ±Infinity here. Treating that as "unmeasurable" would
    // discard the clearest signal the sweep can produce.
    const found = detectEntityAnomalies(
      [
        ...Array.from({ length: 20 }, (_, i) => ({
          entityId: `s${i}`, entityLabel: `Store ${i}`, value: 0.94, weight: 500,
        })),
        { entityId: 'broken', entityLabel: 'Broken', value: 0.42, weight: 500 },
      ],
      { metricId: 'store_coverage', metricLabel: 'Coverage', entityType: 'store', worseWhen: 'below', unit: 'ratio' },
    );
    expect(found).toHaveLength(1);
    expect(found[0].entityId).toBe('broken');
    expect(found[0].severity).toBe('act');
    // Finite so it sorts, formats and bands like any other score.
    expect(Number.isFinite(found[0].zScore)).toBe(true);
  });

  it('does not flag entities sitting exactly at a zero-spread median', async () => {
    const { detectEntityAnomalies } = await import('@/lib/ai/entity-anomaly');
    const found = detectEntityAnomalies(
      Array.from({ length: 20 }, (_, i) => ({
        entityId: `s${i}`, entityLabel: `Store ${i}`, value: 0.94, weight: 500,
      })),
      { metricId: 'store_coverage', metricLabel: 'Coverage', entityType: 'store', worseWhen: 'below', unit: 'ratio' },
    );
    expect(found).toEqual([]);
  });
});
