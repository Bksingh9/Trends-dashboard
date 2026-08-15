/**
 * §4.11 — Help & Support analytics, from the GA4 Data API.
 *
 * Companion's help surface, on property 524294430. Three events:
 * `help_support_sheet_view`, `help_support_tap`, `help_support_call_tap`.
 *
 * ## Why the numbers here will not always match the GA4 UI exactly
 *
 * The Data API samples on large properties and the UI applies its own
 * thresholding, so two readings of the same window can differ by a percent or
 * two. The reference figures for 16 Jul – 12 Aug 2026 are 170 events across 29
 * users. A small divergence from those is expected; a large one is a finding,
 * and `reconcile()` below says which it is rather than leaving the reader to
 * guess.
 *
 * ## Why `eventCountPerUser` is not summed
 *
 * It is a ratio, and ratios do not add. Summing the per-event figures gives a
 * number that looks plausible and is meaningless. The summary recomputes it
 * from its own totals; the per-row figure is whatever GA4 reported for that row.
 */
import { getAccessToken } from '@/lib/gcp/auth';
import { config } from '@/lib/config';

export const HELP_EVENTS = [
  'help_support_sheet_view',
  'help_support_tap',
  'help_support_call_tap',
] as const;

export type HelpEventName = (typeof HELP_EVENTS)[number];

export interface HelpEventRow {
  eventName: string;
  eventCount: number;
  totalUsers: number;
  eventCountPerActiveUser: number;
  totalRevenue: number;
}

export interface HelpTimePoint {
  date: string;
  help_support_sheet_view: number;
  help_support_tap: number;
  help_support_call_tap: number;
}

export interface HelpEventsResult {
  summary: {
    eventCount: number;
    totalUsers: number;
    eventCountPerActiveUser: number;
    totalRevenue: number;
  };
  events: HelpEventRow[];
  timeSeries: HelpTimePoint[];
  propertyId: string;
  range: { startDate: string; endDate: string };
  /** `live` or `missing` — never a zero standing in for an unanswered call. */
  state: 'live' | 'missing';
  warnings: string[];
}

/**
 * Distinguishes the four failures that look identical from the outside.
 *
 * "Could not load help analytics" sends someone hunting. "The Data API is not
 * enabled on this project" is a console click, "the service account is not on
 * the property" is a GA4 Admin task, and they have different owners.
 */
export class Ga4Unavailable extends Error {
  constructor(
    message: string,
    readonly kind: 'not_configured' | 'api_disabled' | 'no_access' | 'bad_property' | 'failed',
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'Ga4Unavailable';
  }
}

interface RunReportResponse {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string }>;
  rows?: Array<{ dimensionValues?: Array<{ value: string }>; metricValues?: Array<{ value: string }> }>;
  error?: { message?: string };
}

async function runReport(body: unknown, propertyId: string): Promise<RunReportResponse> {
  const token = await getAccessToken(['https://www.googleapis.com/auth/analytics.readonly']);
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  const text = await res.text();
  if (res.status === 403 && text.includes('has not been used in project')) {
    throw new Ga4Unavailable(
      'The Google Analytics Data API is not enabled on the service account’s project.',
      'api_disabled',
      'Enable "Google Analytics Data API" in the Google Cloud console for the project owning this service account, then retry.',
    );
  }
  if (res.status === 403) {
    throw new Ga4Unavailable(
      `The service account has no access to property ${propertyId}.`,
      'no_access',
      `In GA4 Admin → Property Access Management, add the service account email with Viewer or Analyst on property ${propertyId}.`,
    );
  }
  if (res.status === 404) {
    throw new Ga4Unavailable(
      `No GA4 property ${propertyId}.`,
      'bad_property',
      'Use the numeric property id from GA4 Admin → Property Settings, not the measurement id (G-…).',
    );
  }
  if (!res.ok) {
    throw new Ga4Unavailable(
      `GA4 returned HTTP ${res.status}.`,
      'failed',
      text.slice(0, 200),
    );
  }
  return JSON.parse(text) as RunReportResponse;
}

const num = (v: string | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** The dimension filter, shared by both reports so they cannot drift apart. */
const helpFilter = {
  filter: {
    fieldName: 'eventName',
    inListFilter: { values: [...HELP_EVENTS] },
  },
};

export async function fetchHelpEvents(opts: {
  startDate?: string;
  endDate?: string;
  propertyId?: string;
} = {}): Promise<HelpEventsResult> {
  const propertyId = opts.propertyId || config.ga4PropertyId;
  const startDate = opts.startDate || '28daysAgo';
  const endDate = opts.endDate || 'yesterday';
  const warnings: string[] = [];

  if (!propertyId) {
    throw new Ga4Unavailable('No GA4 property is configured.', 'not_configured', 'Set GA4_PROPERTY_ID.');
  }

  // Two reports rather than one grouped by both dimensions: totals broken down
  // by event *and* date would have to be re-aggregated here to get per-event
  // user counts, and users do not sum across days — the same person on two days
  // is one user, and adding the rows would double-count them.
  const [byEvent, byDate] = await Promise.all([
    runReport(
      {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'eventName' }],
        metrics: [
          { name: 'eventCount' },
          { name: 'totalUsers' },
          { name: 'eventCountPerUser' },
          { name: 'totalRevenue' },
        ],
        dimensionFilter: helpFilter,
        limit: 100,
      },
      propertyId,
    ),
    runReport(
      {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'date' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: helpFilter,
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: 5000,
      },
      propertyId,
    ),
  ]);

  const events: HelpEventRow[] = (byEvent.rows ?? []).map((r) => ({
    eventName: r.dimensionValues?.[0]?.value ?? 'unknown',
    eventCount: num(r.metricValues?.[0]?.value),
    totalUsers: num(r.metricValues?.[1]?.value),
    eventCountPerActiveUser: num(r.metricValues?.[2]?.value),
    totalRevenue: num(r.metricValues?.[3]?.value),
  }));
  events.sort((a, b) => b.eventCount - a.eventCount);

  // A property-level total, so `totalUsers` counts distinct people across the
  // three events rather than the sum of three overlapping figures.
  const totals = await runReport(
    {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }, { name: 'totalRevenue' }],
      dimensionFilter: helpFilter,
    },
    propertyId,
  );
  const t = totals.rows?.[0]?.metricValues ?? [];
  const eventCount = num(t[0]?.value);
  const totalUsers = num(t[1]?.value);
  const totalRevenue = num(t[2]?.value);

  const byDay = new Map<string, HelpTimePoint>();
  for (const r of byDate.rows ?? []) {
    const raw = r.dimensionValues?.[0]?.value ?? '';
    // GA4 returns YYYYMMDD; every other date in this codebase is YYYY-MM-DD.
    const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
    const name = r.dimensionValues?.[1]?.value ?? '';
    const point =
      byDay.get(date) ??
      ({
        date,
        help_support_sheet_view: 0,
        help_support_tap: 0,
        help_support_call_tap: 0,
      } satisfies HelpTimePoint);
    if (name in point) (point as unknown as Record<string, number>)[name] = num(r.metricValues?.[0]?.value);
    byDay.set(date, point);
  }
  const timeSeries = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  if (events.length === 0) {
    warnings.push(
      `No help events in ${startDate} → ${endDate}. The property is readable, so this is a real zero rather than a missing feed — unless the events were renamed.`,
    );
  }
  const seen = new Set(events.map((e) => e.eventName));
  const absent = HELP_EVENTS.filter((e) => !seen.has(e));
  if (absent.length > 0 && events.length > 0) {
    // Not the same as zero: an event with no rows may never have been
    // instrumented, and §16.9 is explicit that the two must not be conflated.
    warnings.push(`No rows at all for: ${absent.join(', ')}. Check these are firing before reading a zero into it.`);
  }

  return {
    summary: {
      eventCount,
      totalUsers,
      // Recomputed, not summed: eventCountPerUser is a ratio and ratios do not
      // add. Summing the three rows gives a plausible, meaningless number.
      eventCountPerActiveUser: totalUsers > 0 ? eventCount / totalUsers : 0,
      totalRevenue,
    },
    events,
    timeSeries,
    propertyId,
    range: { startDate, endDate },
    state: 'live',
    warnings,
  };
}

/**
 * Compares a reading against the figures observed in the GA4 UI.
 *
 * The Data API samples and the UI thresholds, so small divergence is expected
 * and large divergence is a finding. Stating which is the whole job — a
 * dashboard that silently disagrees with the tool people already trust loses
 * to that tool every time.
 */
export function reconcile(
  observed: { eventCount: number; totalUsers: number },
  reference = { eventCount: 170, totalUsers: 29, window: '16 Jul – 12 Aug 2026' },
): string {
  const drift = reference.eventCount === 0 ? 0 : (observed.eventCount - reference.eventCount) / reference.eventCount;
  const pct = Math.abs(drift * 100).toFixed(1);
  if (Math.abs(drift) <= 0.05) {
    return `Within ${pct}% of the ${reference.eventCount} events the GA4 UI showed for ${reference.window}.`;
  }
  return `${pct}% ${drift > 0 ? 'above' : 'below'} the ${reference.eventCount} events the GA4 UI showed for ${reference.window} — a different window, or a real change.`;
}
