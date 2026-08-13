/**
 * §4.1 — Hub service.
 *
 * The hub answers one question: is Companion healthy today, and if not, where?
 * Six health lights, one per domain, each naming the single worst contributing
 * metric underneath. That naming is the point — a red light with no reason is
 * just anxiety.
 */
import { getThresholds } from '@/lib/db/settings';
import { connectorStatuses } from '@/lib/connectors/registry';
import { trailingWindow, addDays, todayIST } from '@/lib/format/dates';
import type { MetricValue } from '@/lib/metrics/compute';
import { detectAnomalies, type Anomaly, type MetricHistory } from '@/lib/ai/anomaly';
import { evaluateRca, type RcaHit } from '@/lib/ai/rca';
import { buildInsightContext, type InsightContext } from '@/lib/ai/context';
import {
  appHealthModule,
  catalogueModule,
  issuesModule,
  journeyModule,
  salesModule,
  storesModule,
} from './modules';
import { getScanStrip } from '@/lib/data/repository';
import { aggregateOrders } from '@/lib/metrics/compute';
import { getOrders } from '@/lib/data/repository';

export type Light = 'green' | 'amber' | 'red' | 'grey';

export interface HealthLight {
  domain: string;
  href: string;
  light: Light;
  /** The single worst contributing metric, named. */
  worst: { label: string; value: string; why: string } | null;
}

export interface HubData {
  lights: HealthLight[];
  headline: MetricValue[];
  scanStrip: Awaited<ReturnType<typeof getScanStrip>>;
  anomalies: Anomaly[];
  rca: RcaHit[];
  context: InsightContext;
  topRisks: Array<{ title: string; detail: string; href: string; severity: 'act' | 'watch' | 'info' }>;
  fixtureCount: number;
  totalCards: number;
}

function pct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

export async function hubData(): Promise<HubData> {
  const t = await getThresholds();
  const [sales, journey, stores, catalogue, appHealth, issues, strip, connectors] = await Promise.all([
    salesModule(trailingWindow(28)),
    journeyModule(trailingWindow(28)),
    storesModule(trailingWindow(28)),
    catalogueModule(),
    appHealthModule(trailingWindow(28)),
    issuesModule(),
    getScanStrip(),
    connectorStatuses(),
  ]);

  const get = (mod: { kpis: MetricValue[] }, id: string) => mod.kpis.find((k) => k.id === id) ?? null;

  const coverage = get(catalogue, 'unique_coverage');
  const crashFree = get(appHealth, 'crash_free_rate');
  const score = get(appHealth, 'app_health_score');
  const paymentSuccess = get(journey, 'payment_success_rate');
  const p0 = get(issues, 'p0_open');
  const dark = get(stores, 'stores_dark');
  const compliance = get(stores, 'daily_order_compliance');
  const orders = get(sales, 'orders');
  const egmv = get(sales, 'egmv');
  const activeStores = get(stores, 'stores_active');
  const sessionConv = get(journey, 'session_conversion');

  const band = (v: number | null, target: number, amberAt = 0.95): Light => {
    if (v == null) return 'grey';
    if (v >= target) return 'green';
    if (v >= target * amberAt) return 'amber';
    return 'red';
  };

  const lights: HealthLight[] = [
    {
      domain: 'Business',
      href: '/sales',
      light: orders?.value == null ? 'grey' : (orders.deltaVsPrev ?? 0) < -0.2 ? 'red' : (orders.deltaVsPrev ?? 0) < -0.1 ? 'amber' : 'green',
      worst: orders
        ? {
            label: 'Orders vs previous period',
            value: orders.deltaVsPrev == null ? '—' : `${(orders.deltaVsPrev * 100).toFixed(0)}%`,
            why: 'Order volume against the previous 28-day window',
          }
        : null,
    },
    {
      domain: 'Journey',
      href: '/journey',
      light: band(sessionConv?.value ?? null, 0.025, 0.8),
      worst: sessionConv
        ? { label: 'Session→purchase', value: pct(sessionConv.value), why: 'End-to-end conversion of a session into an order' }
        : null,
    },
    {
      domain: 'Stores',
      href: '/stores',
      light: band(compliance?.value ?? null, 0.7, 0.8),
      worst: dark
        ? {
            label: 'Dark stores (7d)',
            value: String(dark.value ?? '—'),
            why: 'Live stores with zero orders in the last 7 days',
          }
        : null,
    },
    {
      domain: 'Catalogue',
      href: '/catalogue',
      light: band(coverage?.value ?? null, t.coverage_target, 0.97),
      worst: coverage
        ? {
            label: 'Unique coverage',
            value: pct(coverage.value),
            why: `Against the ${(t.coverage_target * 100).toFixed(0)}% target`,
          }
        : null,
    },
    {
      domain: 'App',
      href: '/app-health',
      light:
        score?.value == null ? 'grey' : score.value >= 90 ? 'green' : score.value >= 75 ? 'amber' : 'red',
      worst: crashFree
        ? {
            label: 'Crash-free sessions',
            value: pct(crashFree.value),
            why: `Against the ${(t.crash_free_target * 100).toFixed(1)}% target`,
          }
        : null,
    },
    {
      domain: 'Issues',
      href: '/issues',
      light:
        p0?.value == null ? 'grey' : p0.value === 0 ? 'green' : p0.value < t.p0_ceiling / 2 ? 'amber' : 'red',
      worst: p0 ? { label: 'Open P0', value: String(p0.value ?? '—'), why: `Ceiling ${t.p0_ceiling}` } : null,
    },
  ];

  const headline = [orders, egmv, paymentSuccess, coverage, crashFree, activeStores].filter(
    (m): m is MetricValue => m != null,
  );

  // Anomaly detection needs history, so build a 28-day series per headline metric.
  const histories = await buildHistories();
  const redConnectors = new Set(
    connectors.filter((c) => c.health === 'red').flatMap((c) => c.powers),
  );
  const anomalies = detectAnomalies(histories, {
    zThreshold: t.anomaly_z_threshold,
    wowThreshold: t.anomaly_wow_threshold,
    redConnectorMetrics: redConnectors,
    thresholdBreaches: [
      ...(coverage?.value != null && coverage.value < t.coverage_target
        ? [{ metricId: 'unique_coverage', observed: coverage.value, target: t.coverage_target, label: 'Unique coverage' }]
        : []),
      ...(crashFree?.value != null && crashFree.value < t.crash_free_target
        ? [{ metricId: 'crash_free_rate', observed: crashFree.value, target: t.crash_free_target, label: 'Crash-free sessions' }]
        : []),
    ],
  });

  const storeCov = catalogue.data.storeCoverage;
  const worstStores = storeCov.filter((s) => (s.coverage ?? 1) < 0.9);
  const rca = evaluateRca({
    anomalies,
    unhealthyConnectors: connectors.filter((c) => c.health === 'red').map((c) => c.id),
    gapConcentratedInFewStores: worstStores.length > 0 && worstStores.length < 5,
    funnelRatesFlat: anomalies.filter((a) => a.metricId.endsWith('_rate')).length === 0,
    recentRelease: appHealth.data.releases.at(-1)
      ? { version: appHealth.data.releases.at(-1)!.label, dateCreated: appHealth.data.releases.at(-1)!.dateKey }
      : null,
    missingNewSpike: (catalogue.kpis.find((k) => k.id === 'missing_new')?.value ?? 0) > 60,
  });

  const context = buildInsightContext({
    window: { start: addDays(todayIST(), -28), end: todayIST() },
    metrics: [...sales.kpis, ...journey.kpis, ...stores.kpis, ...catalogue.kpis, ...appHealth.kpis, ...issues.kpis],
    anomalies,
    openP0: issues.data.rows
      .filter((i) => i.priority === 'P0' && i.status !== 'Done')
      .slice(0, 10)
      .map((i) => ({
        key: i.issueKey,
        title: i.title,
        ageDays: Math.round((Date.now() - Date.parse(i.createdAt)) / 86_400_000),
        workstream: i.workstream,
        owner: i.assignee,
      })),
    catalogueDeltas: {
      newMissing: catalogue.kpis.find((k) => k.id === 'missing_new')?.value ?? 0,
      resolved: catalogue.kpis.find((k) => k.id === 'missing_resolved')?.value ?? 0,
      topReasons: catalogue.data.reasons.slice(0, 5).map((r) => ({ reason: r.reason, count: r.count })),
    },
    storeSignals: {
      active: (activeStores?.value ?? 0) as number,
      dark7d: (dark?.value ?? 0) as number,
      compliancePct: (compliance?.value ?? 0) as number,
      topDeclining: stores.data.darkWorklist
        .slice(0, 5)
        .map((s) => ({ storeCode: s.storeCode, deltaPct: -1 })),
      topDecliningStates: stores.data.states
        .slice()
        .sort((a, b) => a.storesActive / Math.max(1, a.storesLive) - b.storesActive / Math.max(1, b.storesLive))
        .slice(0, 5)
        .map((s) => ({ state: s.state, deltaPct: s.storesDark / Math.max(1, s.storesLive) })),
    },
    connectorHealth: connectors.map((c) => ({
      id: c.id,
      status: c.health,
      lastRun: c.lastRunAt ?? 'never',
    })),
    calendar: {
      // Independence Day Sale falls in this window — without this the model
      // would confidently explain seasonality as an incident (§28.2).
      isSalePeriod: isSalePeriod(todayIST()),
      saleName: isSalePeriod(todayIST()) ? 'Independence Day Sale' : null,
      comparabilityWarning: isSalePeriod(todayIST())
        ? 'Sale period — period-on-period comparisons are affected'
        : null,
    },
  });

  const topRisks = [
    ...connectors
      .filter((c) => c.health === 'red')
      .map((c) => ({
        title: `${c.displayName} is failing`,
        detail: c.lastError ?? 'Assertion gate failed — mart not updated',
        href: '/connectors',
        severity: 'act' as const,
      })),
    ...anomalies
      .filter((a) => a.severity === 'act' && !a.suppressed)
      .map((a) => ({ title: a.label, detail: a.magnitude, href: '/insights', severity: 'act' as const })),
    ...issues.data.rows
      .filter((i) => i.priority === 'P0' && i.status !== 'Done')
      .slice(0, 3)
      .map((i) => ({
        title: `${i.issueKey} — ${i.title}`,
        detail: `${i.workstream}${i.assignee ? ` · ${i.assignee}` : ' · unowned'}`,
        href: '/issues',
        severity: 'watch' as const,
      })),
  ].slice(0, 3);

  const allCards = [...sales.kpis, ...journey.kpis, ...stores.kpis, ...catalogue.kpis, ...appHealth.kpis, ...issues.kpis];

  return {
    lights,
    headline,
    scanStrip: strip,
    anomalies,
    rca,
    context,
    topRisks,
    fixtureCount: allCards.filter((k) => k.state === 'fixture').length,
    totalCards: allCards.length,
  };
}

/** Independence Day Sale and EOSS windows — sale flags matter for comparability. */
export function isSalePeriod(dateKey: string): boolean {
  const md = dateKey.slice(5);
  return (md >= '08-08' && md <= '08-18') || (md >= '06-25' && md <= '07-15');
}

async function buildHistories(): Promise<MetricHistory[]> {
  const w = trailingWindow(35);
  const orders = await getOrders(w);
  const byDate = new Map<string, typeof orders.rows>();
  for (const o of orders.rows) {
    const list = byDate.get(o.orderDate) ?? [];
    list.push(o);
    byDate.set(o.orderDate, list);
  }
  const dates = [...byDate.keys()].sort();
  const series = dates.map((d) => {
    const a = aggregateOrders(byDate.get(d) ?? []);
    return { dateKey: d, orders: a.orders, egmv: a.egmv };
  });
  if (series.length < 8) return [];

  const current = series.at(-1)!;
  const history = series.slice(0, -1).map((s) => ({
    dateKey: s.dateKey,
    value: s.orders,
    isSalePeriod: isSalePeriod(s.dateKey),
  }));
  const lastWeek = series.at(-8);

  return [
    {
      metricId: 'orders',
      label: 'Orders',
      current: current.orders,
      history,
      sameWeekdayLastWeek: lastWeek?.orders ?? null,
      unit: 'count',
      direction: 'up_good',
    },
    {
      metricId: 'egmv',
      label: 'e-GMV',
      current: current.egmv,
      history: series.slice(0, -1).map((s) => ({
        dateKey: s.dateKey,
        value: s.egmv,
        isSalePeriod: isSalePeriod(s.dateKey),
      })),
      sameWeekdayLastWeek: lastWeek?.egmv ?? null,
      unit: 'inr',
      direction: 'up_good',
    },
  ];
}
