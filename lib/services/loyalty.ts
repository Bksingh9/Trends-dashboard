/**
 * Loyalty module service — ADR-001.
 *
 * Reports Loyalty-side figures only. It deliberately does not blend them into
 * Companion KPIs: a loyalty member is not a Companion user, the two GA4
 * properties count sessions differently, and any cross-property rate is
 * meaningless until the customer-id join is verified under §27.4.
 */
import { config } from '@/lib/config';
import { aggregateLoyalty, bqLoyalty, type LoyaltyDailyRow } from '@/lib/connectors/bq-loyalty';
import { metricValue, ppDelta, ratio, relativeDelta, type MetricValue } from '@/lib/metrics/compute';
import { previousPeriod, trailingWindow, type DateWindow } from '@/lib/format/dates';
import type { DataSourceState } from '@/lib/connectors/types';

export interface LoyaltyData {
  daily: Array<{ dateKey: string; enrolments: number; links: number; earned: number; redeemed: number }>;
  unmappedEvents: string[];
  enabled: boolean;
}

export async function loyaltyModule(
  w: DateWindow = trailingWindow(28),
): Promise<{ kpis: MetricValue[]; data: LoyaltyData; window: DateWindow; warnings: string[]; state: DataSourceState; sources: string[] }> {
  const result = await bqLoyalty.run(w);
  const prev = await bqLoyalty.run(previousPeriod(w));

  const agg = aggregateLoyalty(result.rows);
  const prevAgg = aggregateLoyalty(prev.rows);
  const state: DataSourceState = result.meta.source === 'fixture' ? 'fixture' : 'live';
  const meta = { state, fetchedAt: result.meta.fetchedAt };

  const kpis: MetricValue[] = [
    metricValue('loyalty_members_active', agg.activeMembers, {
      ...meta,
      deltaVsPrev: relativeDelta(agg.activeMembers, prevAgg.activeMembers),
    }),
    metricValue('loyalty_enrolments', agg.enrolments, {
      ...meta,
      deltaVsPrev: relativeDelta(agg.enrolments, prevAgg.enrolments),
    }),
    metricValue('loyalty_links', agg.linked, {
      ...meta,
      deltaVsPrev: relativeDelta(agg.linked, prevAgg.linked),
    }),
    metricValue('loyalty_points_earned', agg.pointsEarned, { ...meta }),
    metricValue('loyalty_points_redeemed', agg.pointsRedeemed, { ...meta }),
    metricValue('loyalty_redemption_rate', ratio(agg.pointsRedeemed, agg.pointsEarned), {
      ...meta,
      deltaPp: ppDelta(
        ratio(agg.pointsRedeemed, agg.pointsEarned),
        ratio(prevAgg.pointsRedeemed, prevAgg.pointsEarned),
      ),
    }),
  ];

  const byDate = new Map<string, { enrolments: number; links: number; earned: number; redeemed: number }>();
  for (const r of result.rows) {
    const cur = byDate.get(r.dateKey) ?? { enrolments: 0, links: 0, earned: 0, redeemed: 0 };
    if (r.eventName.includes('enrol') || r.eventName === 'sign_up') cur.enrolments += r.eventCount;
    if (r.eventName.includes('link')) cur.links += r.eventCount;
    if (r.eventName.includes('earn')) cur.earned += r.points;
    if (r.eventName.includes('redeem')) cur.redeemed += r.points;
    byDate.set(r.dateKey, cur);
  }

  return {
    kpis,
    data: {
      daily: [...byDate.entries()].map(([dateKey, v]) => ({ dateKey, ...v })).sort((a, b) => a.dateKey.localeCompare(b.dateKey)),
      unmappedEvents: agg.unmappedEvents,
      enabled: config.moduleLoyalty,
    },
    window: w,
    warnings: result.meta.warnings,
    state,
    sources: [result.meta.source === 'fixture' ? 'fixture: Loyalty GA4 export' : 'bq-loyalty'],
  };
}
