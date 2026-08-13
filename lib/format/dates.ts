/**
 * §27.2 — Time.
 *
 * Store UTC. Render IST (`Asia/Kolkata`). Label the timezone on every date
 * control. The retail day is an IST day, which means daily aggregates group on
 * `DATE(state_date, 'Asia/Kolkata')` in BigQuery, not `DATE(state_date)`.
 *
 * This is a real 5.5-hour boundary shift: an order at 02:00 IST belongs to the
 * previous UTC day. Get it wrong and every daily number is subtly off.
 */

export const IST = 'Asia/Kolkata';
export const IST_OFFSET_MINUTES = 330;

export interface DateWindow {
  /** YYYY-MM-DD, IST */
  start: string;
  /** YYYY-MM-DD, IST */
  end: string;
}

const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The IST calendar date of an instant, as YYYY-MM-DD. The retail day key. */
export function istDateKey(d: Date | string | number = new Date()): string {
  return ymdFormatter.format(new Date(d));
}

export function todayIST(): string {
  return istDateKey(new Date());
}

/** BigQuery `_TABLE_SUFFIX` form: YYYYMMDD. */
export function bqSuffix(dateKey: string): string {
  return dateKey.replace(/-/g, '');
}

export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const toUtc = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** Inclusive list of IST date keys. */
export function dateRange(window: DateWindow): string[] {
  const out: string[] = [];
  const n = daysBetween(window.start, window.end);
  for (let i = 0; i <= n; i++) out.push(addDays(window.start, i));
  return out;
}

/** Trailing N days ending yesterday (IST) — the default analytics window. */
export function trailingWindow(days: number, endDateKey = todayIST()): DateWindow {
  const end = addDays(endDateKey, -1);
  return { start: addDays(end, -(days - 1)), end };
}

/** Same window shifted back one period — the `prev_period` comparison. */
export function previousPeriod(w: DateWindow): DateWindow {
  const span = daysBetween(w.start, w.end) + 1;
  return { start: addDays(w.start, -span), end: addDays(w.end, -span) };
}

/** Retail is strongly weekday-seasonal (§28.4) — this is the honest comparison. */
export function sameWeekdayLastWeek(w: DateWindow): DateWindow {
  return { start: addDays(w.start, -7), end: addDays(w.end, -7) };
}

const displayFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Always label the timezone — §9.2 non-negotiable. */
export function formatIST(d: Date | string | number, opts: { withTime?: boolean } = {}): string {
  const date = new Date(d);
  if (!Number.isFinite(date.getTime())) return '—';
  const day = displayFormatter.format(date);
  return opts.withTime ? `${day}, ${timeFormatter.format(date)} IST` : day;
}

export function formatDateKey(dateKey: string): string {
  return formatIST(`${dateKey}T00:00:00+05:30`);
}

/** "4 min ago" / "2 h ago" — for the freshness slot on every KPI card. */
export function relativeAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

export function minutesSince(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return (now - then) / 60_000;
}

/** The IST weekday index (0 = Sunday), for weekday-seasonal baselines. */
export function istWeekday(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekend(dateKey: string): boolean {
  const w = istWeekday(dateKey);
  return w === 0 || w === 6;
}
