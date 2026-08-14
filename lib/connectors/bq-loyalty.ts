/**
 * `bq-loyalty` — Reliance One 2.0 Loyalty, from the GA4 export in
 * `fynd-jio-impetus-prod`.
 *
 * **This connector exists against §0**, which excludes Loyalty from v1. It was
 * added on explicit PM direction after the conflict was raised; see
 * `docs/decisions/ADR-001-loyalty-scope.md`.
 *
 * Two things to keep in view while reading this:
 *
 *  - The Loyalty **event taxonomy is unverified.** The spec records the property
 *    id and nothing else. Every event name below is a proposal derived from the
 *    Kiosk/Companion conventions, and the metrics are marked ambiguous until the
 *    §16.1 inventory query settles them against the real export.
 *  - Loyalty and Companion are **different populations.** This connector reports
 *    Loyalty-side figures only. It does not blend them into Companion KPIs,
 *    because that would change the meaning of numbers leadership already reads.
 */
import { config } from '@/lib/config';
import { cardinality, freshness, rowVolume } from '@/lib/assertions';
import { bqSuffix, dateRange, isWeekend, type DateWindow } from '@/lib/format/dates';
import { isBigQueryConfigured, runQuery } from '@/lib/gcp/bigquery';
import { hashSeed, makeRng } from '@/fixtures/rng';
import { BaseConnector } from './base';
import { PARAM_HELPERS } from './bq-ga4-events';
import type { Assertion, CostTier, LoadResult } from './types';

export const LOYALTY_PROPERTY_ID = '542441622';
export const LOYALTY_DEFAULT_PROJECT = 'fynd-jio-impetus-prod';

const loyaltyProject = () => process.env.BQ_LOYALTY_PROJECT || LOYALTY_DEFAULT_PROJECT;
const loyaltyDataset = () => process.env.BQ_LOYALTY_DATASET || `analytics_${LOYALTY_PROPERTY_ID}`;
const loyaltyTable = () => `\`${loyaltyProject()}.${loyaltyDataset()}.events_*\``;

/**
 * Proposed event taxonomy. Every one of these is a hypothesis until the
 * inventory query confirms it — which is why the module renders them with the
 * ambiguity visible rather than as settled fact.
 */
export const LOYALTY_EVENTS = {
  enrolment: ['rone_enrol', 'loyalty_enrol', 'sign_up'],
  linked: ['rone_link', 'loyalty_link', 'account_linked'],
  pointsEarned: ['rone_points_earned', 'loyalty_points_earned', 'earn_points'],
  pointsRedeemed: ['rone_points_redeemed', 'loyalty_points_redeemed', 'redeem_points'],
} as const;

/** §16.1, pointed at the Loyalty property — the query that settles the taxonomy. */
export const LOYALTY_EVENT_INVENTORY_SQL = () => `
SELECT event_name, COUNT(*) AS n, COUNT(DISTINCT user_pseudo_id) AS users
FROM ${loyaltyTable()}
WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
GROUP BY 1
ORDER BY n DESC
LIMIT 200
`.trim();

export const LOYALTY_DAILY_SQL = () => `
${PARAM_HELPERS}
SELECT
  PARSE_DATE('%Y%m%d', event_date) AS date_key,
  event_name,
  COUNT(*)                         AS event_count,
  COUNT(DISTINCT user_pseudo_id)   AS user_count,
  SUM(COALESCE(pi(event_params, 'points'), 0)) AS points
FROM ${loyaltyTable()}
WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
GROUP BY 1, 2
`.trim();

export interface LoyaltyDailyRow {
  dateKey: string;
  eventName: string;
  eventCount: number;
  userCount: number;
  points: number;
}

export interface LoyaltyAggregate {
  enrolments: number;
  linked: number;
  pointsEarned: number;
  pointsRedeemed: number;
  activeMembers: number;
  /** Event names seen that we could not map — the taxonomy gap, made visible. */
  unmappedEvents: string[];
}

function bucketFor(eventName: string): keyof typeof LOYALTY_EVENTS | null {
  for (const [bucket, names] of Object.entries(LOYALTY_EVENTS)) {
    if ((names as readonly string[]).includes(eventName)) return bucket as keyof typeof LOYALTY_EVENTS;
  }
  return null;
}

export function aggregateLoyalty(rows: LoyaltyDailyRow[]): LoyaltyAggregate {
  const agg: LoyaltyAggregate = {
    enrolments: 0,
    linked: 0,
    pointsEarned: 0,
    pointsRedeemed: 0,
    activeMembers: 0,
    unmappedEvents: [],
  };
  const unmapped = new Set<string>();
  let maxUsers = 0;

  for (const r of rows) {
    maxUsers = Math.max(maxUsers, r.userCount);
    const bucket = bucketFor(r.eventName);
    if (!bucket) {
      unmapped.add(r.eventName);
      continue;
    }
    if (bucket === 'enrolment') agg.enrolments += r.eventCount;
    if (bucket === 'linked') agg.linked += r.eventCount;
    if (bucket === 'pointsEarned') agg.pointsEarned += r.points;
    if (bucket === 'pointsRedeemed') agg.pointsRedeemed += r.points;
  }

  agg.activeMembers = maxUsers;
  // Surfaced rather than swallowed: an unmapped event is the taxonomy
  // proposal being wrong, and that is exactly what needs to be seen.
  agg.unmappedEvents = [...unmapped].sort();
  return agg;
}

export class BqLoyaltyConnector extends BaseConnector<LoyaltyDailyRow, LoyaltyDailyRow> {
  readonly id = 'bq-loyalty';
  readonly displayName = 'BigQuery — Reliance One Loyalty';
  readonly freshnessSlaMinutes = 48 * 60;
  readonly costTier: CostTier = 'expensive';
  readonly priority = 'P2' as const;
  readonly powers = ['/loyalty', 'loyalty_members_active', 'loyalty_points_earned'];
  readonly blockedBy =
    'MODULE_LOYALTY + a service account with read access to fynd-jio-impetus-prod (a different GCP project — see ADR-001)';

  isConfigured(): boolean {
    return config.moduleLoyalty && isBigQueryConfigured() && Boolean(process.env.BQ_LOYALTY_DATASET);
  }

  /** Settles the proposed taxonomy against the real export. */
  async inventoryEvents(w: DateWindow): Promise<Array<{ event_name: string; n: number; users: number }>> {
    const res = await runQuery<{ event_name: string; n: number; users: number }>({
      query: LOYALTY_EVENT_INVENTORY_SQL(),
      params: { suffix_start: bqSuffix(w.start), suffix_end: bqSuffix(w.end) },
      types: { suffix_start: 'STRING', suffix_end: 'STRING' },
      connector: this.id,
    });
    return res.rows;
  }

  protected async extract(w: DateWindow): Promise<LoyaltyDailyRow[]> {
    const res = await runQuery<{
      date_key: string;
      event_name: string;
      event_count: number;
      user_count: number;
      points: number;
    }>({
      query: LOYALTY_DAILY_SQL(),
      params: { suffix_start: bqSuffix(w.start), suffix_end: bqSuffix(w.end) },
      types: { suffix_start: 'STRING', suffix_end: 'STRING' },
      connector: this.id,
    });
    return res.rows.map((r) => ({
      dateKey: r.date_key,
      eventName: r.event_name,
      eventCount: Number(r.event_count),
      userCount: Number(r.user_count),
      points: Number(r.points ?? 0),
    }));
  }

  protected transform(rows: LoyaltyDailyRow[]): LoyaltyDailyRow[] {
    return rows;
  }

  /**
   * Read-through for now. Loyalty has no mart in §7 — adding one is a schema
   * decision that should follow the taxonomy being confirmed, not precede it.
   */
  protected async load(rows: LoyaltyDailyRow[]): Promise<LoadResult> {
    return { rowsIngested: rows.length, table: '(none — read-through until the taxonomy is confirmed)' };
  }

  protected fixture(w: DateWindow): LoyaltyDailyRow[] {
    const out: LoyaltyDailyRow[] = [];
    for (const dateKey of dateRange(w)) {
      const rng = makeRng(hashSeed(`loyalty:${dateKey}`));
      const seasonal = isWeekend(dateKey) ? 1.3 : 0.9;
      const members = Math.round(2600 * seasonal * (0.9 + rng() * 0.2));
      const push = (eventName: string, count: number, points = 0) =>
        out.push({
          dateKey,
          eventName,
          eventCount: count,
          userCount: Math.round(count * 0.86),
          points,
        });
      push('rone_enrol', Math.round(members * 0.07));
      push('rone_link', Math.round(members * 0.21));
      push('rone_points_earned', Math.round(members * 0.44), Math.round(members * 12.5));
      push('rone_points_redeemed', Math.round(members * 0.09), Math.round(members * 3.1));
      // One deliberately unmapped event, so the taxonomy-gap panel has
      // something real to show rather than always appearing empty.
      push('rone_tier_upgraded', Math.round(members * 0.012));
    }
    return out;
  }

  readonly assertions: Assertion<LoyaltyDailyRow>[] = [
    freshness<LoyaltyDailyRow>({ column: 'dateKey', maxLagHours: 48, level: 'warn' }),
    rowVolume<LoyaltyDailyRow>({ tolerance: 0.7, zeroIsFail: true }),
    cardinality<LoyaltyDailyRow>({ column: 'eventName', minDistinct: 2, level: 'warn' }),
  ];
}

export const bqLoyalty = new BqLoyaltyConnector();
