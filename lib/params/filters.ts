/**
 * §9.3 — the query-param contract, in one place.
 *
 * The URL is the state. A NOC engineer who finds something must be able to send
 * the link and have the recipient see exactly what they saw — same window, same
 * store, same comparison. That only holds if every route reads the params the
 * same way, so this module is the single parser, shared by the API routes
 * (which have a `URL`) and the pages (which get Next's `searchParams` object).
 *
 * Two rules run through it:
 *
 *  1. **Never throw on a query string.** A dashboard that 500s on a stale
 *     bookmark is worse than one that says "I ignored `compare=lol` and used
 *     the previous period". Every rejection becomes a warning the page renders.
 *  2. **Round-trip exactly.** `serialize(parse(url)) === url` for any valid
 *     input, or the filter bar and the address bar will drift apart and the
 *     link someone shares will not be the view they were looking at.
 */
import { previousPeriod, sameWeekdayLastWeek, trailingWindow, type DateWindow } from '@/lib/format/dates';

export const COMPARE_MODES = ['prev_period', 'same_period_last_month', 'same_weekday_last_week'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export const COMPARE_LABELS: Record<CompareMode, string> = {
  prev_period: 'vs previous period',
  same_period_last_month: 'vs same period last month',
  // §28.4 — retail is strongly weekday-seasonal, so this is often the only
  // honest comparison for a short window.
  same_weekday_last_week: 'vs same weekday last week',
};

/**
 * §16.7 — the platforms the Companion SDK actually ships on.
 *
 * Lowercase in the URL, because a query string someone types by hand should not
 * care about the capital I in "iOS". The warehouse spells them `Android` and
 * `iOS`, so `PLATFORM_VALUES` maps one to the other in a single place rather
 * than leaving a `.toLowerCase()` at every comparison.
 */
export const PLATFORMS = ['android', 'ios'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_VALUES: Record<Platform, string> = { android: 'Android', ios: 'iOS' };

export interface Filters {
  window: DateWindow;
  store?: string;
  city?: string;
  state?: string;
  /** §0 — Trends is one tenant of the Companion platform. */
  tenant: string;
  platform?: Platform;
  compare: CompareMode;
}

export interface ParsedFilters extends Filters {
  /** Everything silently corrected, so the page can say so out loud (§14.5). */
  warnings: string[];
}

export const DEFAULT_TENANT = 'trends';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD, and a date that actually exists — `2026-02-31` is not one. */
export function isValidDateKey(v: string | null | undefined): v is string {
  if (!v || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Next hands pages `string | string[] | undefined` per key. A repeated param
 * (`?store=a&store=b`) is a bookmark someone edited by hand, and the first
 * value is the one they meant.
 */
export type RawParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const trimmed = s?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A window wider than this is almost always a typo (`2026` vs `2016`), and it
 * turns a page load into a scan of years of orders. Clamped rather than
 * rejected, so the user still gets the data they can have.
 */
const MAX_WINDOW_DAYS = 400;

export function parseFilters(raw: RawParams, defaultDays = 28): ParsedFilters {
  const warnings: string[] = [];

  const rawStart = one(raw.start);
  const rawEnd = one(raw.end);
  let window = trailingWindow(defaultDays);

  if (rawStart || rawEnd) {
    if (isValidDateKey(rawStart) && isValidDateKey(rawEnd)) {
      window = rawStart <= rawEnd ? { start: rawStart, end: rawEnd } : { start: rawEnd, end: rawStart };
      if (rawStart > rawEnd) warnings.push('start was after end — the range was swapped.');

      const span = Math.round(
        (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / 86_400_000,
      );
      if (span > MAX_WINDOW_DAYS) {
        const clamped = new Date(Date.parse(`${window.end}T00:00:00Z`) - MAX_WINDOW_DAYS * 86_400_000)
          .toISOString()
          .slice(0, 10);
        warnings.push(
          `The range spanned ${span} days, which is almost always a typo — it was clamped to the last ${MAX_WINDOW_DAYS} days (from ${clamped}).`,
        );
        window = { start: clamped, end: window.end };
      }
    } else {
      warnings.push(
        `Ignored an invalid date range (start=${rawStart ?? '—'}, end=${rawEnd ?? '—'}); using the trailing ${defaultDays} days instead.`,
      );
    }
  }

  const rawCompare = one(raw.compare);
  let compare: CompareMode = 'prev_period';
  if (rawCompare) {
    if ((COMPARE_MODES as readonly string[]).includes(rawCompare)) {
      compare = rawCompare as CompareMode;
    } else {
      warnings.push(
        `Ignored compare=${rawCompare} — it must be one of ${COMPARE_MODES.join(', ')}; using the previous period.`,
      );
    }
  }

  const rawPlatform = one(raw.platform)?.toLowerCase();
  let platform: Platform | undefined;
  if (rawPlatform) {
    if ((PLATFORMS as readonly string[]).includes(rawPlatform)) {
      platform = rawPlatform as Platform;
    } else {
      warnings.push(`Ignored platform=${rawPlatform} — it must be one of ${PLATFORMS.join(', ')}.`);
    }
  }

  return {
    window,
    // §19.3 — store codes carry leading zeros. Never normalised, never
    // Number()'d; `00421` and `421` are different stores.
    store: one(raw.store),
    city: one(raw.city),
    state: one(raw.state),
    tenant: one(raw.tenant) ?? DEFAULT_TENANT,
    platform,
    compare,
    warnings,
  };
}

export function parseFiltersFromUrl(url: URL, defaultDays = 28): ParsedFilters {
  const raw: RawParams = {};
  for (const key of ['start', 'end', 'store', 'city', 'state', 'tenant', 'platform', 'compare']) {
    const v = url.searchParams.get(key);
    if (v !== null) raw[key] = v;
  }
  return parseFilters(raw, defaultDays);
}

/**
 * The inverse of `parseFilters`. Keys are emitted in a fixed order so two
 * equivalent filter sets always produce byte-identical URLs — otherwise the
 * browser history fills with entries that differ only in param order.
 *
 * `omitDefaults` keeps a shared link short: the default tenant and comparison
 * are the ones you get anyway, and spelling them out makes every URL noisier
 * without making any of them clearer.
 */
export function serializeFilters(f: Filters, opts: { omitDefaults?: boolean } = {}): string {
  const omit = opts.omitDefaults ?? true;
  const p = new URLSearchParams();
  p.set('start', f.window.start);
  p.set('end', f.window.end);
  if (f.store) p.set('store', f.store);
  if (f.city) p.set('city', f.city);
  if (f.state) p.set('state', f.state);
  if (!omit || f.tenant !== DEFAULT_TENANT) p.set('tenant', f.tenant);
  if (f.platform) p.set('platform', f.platform);
  if (!omit || f.compare !== 'prev_period') p.set('compare', f.compare);
  return p.toString();
}

/** The window a `compare` mode points at — the one denominator every delta uses. */
export function comparisonWindow(w: DateWindow, compare: CompareMode): DateWindow {
  switch (compare) {
    case 'same_weekday_last_week':
      return sameWeekdayLastWeek(w);
    case 'same_period_last_month':
      return samePeriodLastMonth(w);
    case 'prev_period':
    default:
      return previousPeriod(w);
  }
}

/**
 * The same day-of-month range one calendar month earlier.
 *
 * Deliberately *not* "minus 30 days". A month-to-date figure compared against
 * a full previous month is the single most common way a growth number gets
 * overstated, and §1's own Apr→May comparison is day-aligned: 1–15 May against
 * 1–15 April, not against all of April.
 *
 * Days that do not exist in the earlier month clamp to its last day, so a
 * 29–31 March window compares against 28 February rather than silently
 * rolling into March.
 */
export function samePeriodLastMonth(w: DateWindow): DateWindow {
  return { start: shiftMonth(w.start), end: shiftMonth(w.end) };
}

function shiftMonth(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const targetYear = m === 1 ? y - 1 : y;
  const targetMonth = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
