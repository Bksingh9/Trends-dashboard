/**
 * §4.10 — the series a leaderboard or a trend may be built from.
 *
 * Declared, not open. A board that could point a widget at any array in any
 * module would be a board where somebody eventually ranks stores by a column
 * that means something else, and the tile would look identical either way.
 *
 * Each entry says which module it needs, so `buildBoard` runs only those. The
 * `resolve` functions select and sort; they do not compute. Every value below
 * is a field a §5 module already produced.
 */
import type { ModuleResult } from '@/lib/services/modules';
import type {
  AppHealthData,
  CatalogueData,
  IssuesData,
  JourneyDiscoveryData,
  SalesData,
  StoresData,
} from '@/lib/services/modules';
import type { MetricValue } from '@/lib/metrics/compute';
import { daysBetween, todayIST } from '@/lib/format/dates';
import type { SeriesPoint } from './types';

export type ModuleId = 'sales' | 'stores' | 'catalogue' | 'appHealth' | 'issues' | 'discovered';

export interface BoardModules {
  sales?: ModuleResult<SalesData>;
  stores?: ModuleResult<StoresData>;
  catalogue?: ModuleResult<CatalogueData>;
  appHealth?: ModuleResult<AppHealthData>;
  issues?: ModuleResult<IssuesData>;
  discovered?: ModuleResult<JourneyDiscoveryData>;
}

export interface SeriesDef {
  id: string;
  label: string;
  /** What the reader is actually looking at, in one line. */
  description: string;
  module: ModuleId;
  kinds: Array<'leaderboard' | 'trend'>;
  unit: MetricValue['unit'];
  direction: MetricValue['direction'];
  /**
   * Points, plus anything the reader must know to read the shape correctly.
   *
   * One return type rather than points here and a caveat hook there, so a
   * resolver cannot produce a shape and leave behind the sentence that makes it
   * readable.
   */
  resolve: (m: BoardModules) => { points: SeriesPoint[]; note?: string };
}

const top = (points: SeriesPoint[], n = 10): SeriesPoint[] =>
  [...points].sort((a, b) => b.value - a.value).slice(0, n);

const bottom = (points: SeriesPoint[], n = 10): SeriesPoint[] =>
  [...points].sort((a, b) => a.value - b.value).slice(0, n);

/**
 * Drops trailing days the connector has not covered yet.
 *
 * `dateRange(w)` emits every calendar day, and a day with no rows aggregates to
 * zero — so the newest point of a trend sits on the floor until its partition
 * lands. On a page that reads as a gap. On a wall display, at four feet of
 * line, it reads as a collapse, and it is the last thing on the chart where the
 * eye goes first. Trailing empties are removed and counted; interior zeros stay,
 * because a zero in the middle of a window is a real one.
 */
function trimTrailingEmpty(points: SeriesPoint[]): { points: SeriesPoint[]; note?: string } {
  let end = points.length;
  while (end > 0 && points[end - 1].value === 0) end--;
  const trimmed = points.length - end;
  return {
    points: points.slice(0, end),
    note:
      trimmed > 0
        ? `${trimmed} most recent day${trimmed > 1 ? 's' : ''} not shown — no rows loaded yet, which is a pending run rather than a fall to zero.`
        : undefined,
  };
}

export const SERIES: SeriesDef[] = [
  {
    id: 'stores.top_by_revenue',
    label: 'Top stores by revenue',
    description: 'Net revenue over the window, best first.',
    module: 'stores',
    kinds: ['leaderboard'],
    unit: 'inr',
    direction: 'up_good',
    resolve: (m) => ({
      points: top(
        (m.stores?.data.rows ?? []).map((r) => ({
          key: r.storeId,
          label: r.storeName || r.storeCode,
          value: r.revenue28d,
          sub: `${r.city}${r.state ? `, ${r.state}` : ''}`,
        })),
      ),
    }),
  },
  {
    id: 'stores.lowest_scan_success',
    label: 'Worst scan success by store',
    description: 'The stores where scanning fails most — usually a catalogue gap, sometimes a device.',
    module: 'stores',
    kinds: ['leaderboard'],
    unit: 'ratio',
    direction: 'up_good',
    resolve: (m) => ({
      points: bottom(
        (m.stores?.data.rows ?? [])
          // A store with no scans has no rate, and a null rendered as 0% would
          // put a working store at the top of a "worst" list.
          .filter((r) => r.scanSuccessRate != null && r.scans28d > 0)
          .map((r) => ({
            key: r.storeId,
            label: r.storeName || r.storeCode,
            value: r.scanSuccessRate!,
            sub: `${r.scans28d.toLocaleString('en-IN')} scans`,
          })),
      ),
    }),
  },
  {
    id: 'stores.dark',
    label: 'Dark stores',
    description: 'Live stores with no Companion order recently — the NOC worklist.',
    module: 'stores',
    kinds: ['leaderboard'],
    unit: 'days',
    direction: 'down_good',
    resolve: (m) => ({
      points: top(
        (m.stores?.data.darkWorklist ?? []).map((r) => ({
          key: r.storeId,
          label: r.storeName || r.storeCode,
          value: r.daysSinceLastOrder ?? 0,
          sub: `${r.city} · last order ${r.lastOrderDate ?? 'never'}`,
        })),
      ),
    }),
  },
  {
    id: 'sales.daily_revenue',
    label: 'Revenue by day',
    description: 'Net revenue across the window.',
    module: 'sales',
    kinds: ['trend'],
    unit: 'inr',
    direction: 'up_good',
    resolve: (m) =>
      trimTrailingEmpty(
        (m.sales?.data.daily ?? []).map((d) => ({
          key: d.dateKey,
          label: d.dateKey.slice(5),
          value: d.netRevenue,
        })),
      ),
  },
  {
    id: 'sales.daily_orders',
    label: 'Orders by day',
    description: 'Confirmed Companion orders across the window.',
    module: 'sales',
    kinds: ['trend'],
    unit: 'count',
    direction: 'up_good',
    resolve: (m) =>
      trimTrailingEmpty(
        (m.sales?.data.daily ?? []).map((d) => ({
          key: d.dateKey,
          label: d.dateKey.slice(5),
          value: d.orders,
        })),
      ),
  },
  {
    id: 'sales.top_states',
    label: 'Top states by revenue',
    description: 'Where the revenue is, rolled up from stores.',
    module: 'sales',
    kinds: ['leaderboard'],
    unit: 'inr',
    direction: 'up_good',
    resolve: (m) => ({
      points: top(
        (m.sales?.data.stateMatrix ?? []).map((s) => ({
          key: s.state,
          label: s.state,
          value: s.revenue,
          sub: `${s.stores} stores · ${s.orders.toLocaleString('en-IN')} orders`,
        })),
      ),
    }),
  },
  {
    id: 'catalogue.daily_coverage',
    label: 'Catalogue coverage by day',
    description: 'Unique-EAN coverage from the hourly sync report.',
    module: 'catalogue',
    kinds: ['trend'],
    unit: 'ratio',
    direction: 'up_good',
    resolve: (m) => ({
      // Days the bot never reported are absent from the mart entirely, so there
      // is nothing to trim — but a null coverage must not become a 0% point.
      points: (m.catalogue?.data.daily ?? [])
        .filter((d) => d.uniqueCoverage != null)
        .map((d) => ({ key: d.dateKey, label: d.dateKey.slice(5), value: Number(d.uniqueCoverage) })),
    }),
  },
  {
    id: 'catalogue.top_gaps',
    label: 'Most-scanned missing EANs',
    description: 'Open gaps ranked by how often staff hit them — the fix-first list.',
    module: 'catalogue',
    kinds: ['leaderboard'],
    unit: 'count',
    direction: 'down_good',
    resolve: (m) => ({
      points: top(
        (m.catalogue?.data.gaps ?? [])
          .filter((g) => g.status !== 'resolved' && g.status !== 'wontfix')
          .map((g) => ({
            key: g.ean,
            // §19.3 — the EAN is a string. Leading zeros are load-bearing and a
            // numeric render would drop them.
            label: g.ean,
            value: g.scanCount,
            sub: g.suspectedReason ?? `${g.storesAffected} stores`,
          })),
      ),
    }),
  },
  {
    id: 'discovered.worst_journeys',
    label: 'Journeys losing the most sessions',
    description: 'Discovered routes ranked by sessions that left the app outright (ADR-005).',
    module: 'discovered',
    kinds: ['leaderboard'],
    unit: 'count',
    direction: 'down_good',
    resolve: (m) => ({
      points: (m.discovered?.data.journeys ?? []).map((j) => ({
        key: j.id,
        label: j.label,
        value: j.impact,
        sub: j.worstStep ? `at ${j.worstStep.label}` : undefined,
      })),
    }),
  },
  {
    id: 'appHealth.p95_latency',
    label: 'p95 latency by endpoint',
    description: 'Slowest endpoints over the window.',
    module: 'appHealth',
    kinds: ['leaderboard'],
    unit: 'ms',
    direction: 'down_good',
    resolve: (m) => {
      // One row per endpoint: the mart is per day per endpoint, and a
      // leaderboard listing the same endpoint fourteen times is not a
      // leaderboard. Worst observed day wins, which is the number an on-call
      // engineer cares about.
      const worst = new Map<string, SeriesPoint>();
      for (const r of m.appHealth?.data.latency ?? []) {
        const p95 = Number(r.p95Ms ?? 0);
        const existing = worst.get(r.endpoint);
        if (!existing || p95 > existing.value) {
          worst.set(r.endpoint, { key: r.endpoint, label: r.endpoint, value: p95, sub: r.dateKey });
        }
      }
      return { points: top([...worst.values()]) };
    },
  },
  {
    id: 'issues.open_p0',
    label: 'Open P0 and P1 issues',
    description: 'The escalation list, oldest first.',
    module: 'issues',
    kinds: ['leaderboard'],
    unit: 'days',
    direction: 'down_good',
    resolve: (m) => ({
      points: top(
        (m.issues?.data.rows ?? [])
          .filter((i) => !i.resolvedAt && (i.priority === 'P0' || i.priority === 'P1'))
          .map((i) => ({
            key: i.issueKey,
            label: `${i.issueKey} — ${i.title}`,
            // Age in days. `daysBetween` is a calendar helper, not a metric —
            // the issues mart carries no age column, and adding one would be a
            // §5 change rather than a board one.
            value: Math.max(0, daysBetween(i.createdAt.slice(0, 10), todayIST())),
            sub: `${i.priority} · ${i.status}`,
          })),
      ),
    }),
  },
];

export function getSeries(id: string): SeriesDef | undefined {
  return SERIES.find((s) => s.id === id);
}
