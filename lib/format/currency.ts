/**
 * §27.3 — Currency. Indian numbering everywhere.
 *
 * ₹10.2 L, ₹3.29 Cr — not $1.02M, not ₹1,020,000. Leadership reads lakh and
 * crore. Never floats for money in the warehouse; these formatters are for
 * display only.
 */

const LAKH = 100_000;
const CRORE = 10_000_000;

export interface INROptions {
  /** Collapse to lakh/crore. Default true — this is what leadership reads. */
  compact?: boolean;
  /** Decimal places in compact mode. Default 2. */
  precision?: number;
  /** Render the ₹ symbol. Default true. */
  symbol?: boolean;
}

/** Indian digit grouping: 1,02,00,000 rather than 10,200,000. */
export function groupIndian(n: number): string {
  const neg = n < 0;
  const [intPart, decPart] = Math.abs(n).toFixed(2).split('.');
  let out: string;
  if (intPart.length <= 3) {
    out = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    out = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  const withDec = decPart === '00' ? out : `${out}.${decPart}`;
  return neg ? `-${withDec}` : withDec;
}

export function formatINR(value: number | null | undefined, opts: INROptions = {}): string {
  const { compact = true, precision = 2, symbol = true } = opts;
  if (value == null || !Number.isFinite(value)) return '—';
  const sym = symbol ? '₹' : '';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (!compact) return `${sign}${sym}${groupIndian(abs)}`;

  if (abs >= CRORE) return `${sign}${sym}${trim(abs / CRORE, precision)} Cr`;
  if (abs >= LAKH) return `${sign}${sym}${trim(abs / LAKH, precision)} L`;
  if (abs >= 1000) return `${sign}${sym}${trim(abs / 1000, 1)} K`;
  return `${sign}${sym}${trim(abs, abs % 1 === 0 ? 0 : precision)}`;
}

function trim(n: number, precision: number): string {
  return n
    .toFixed(precision)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

/**
 * Plain integers with Indian grouping — orders, scans, EAN counts.
 *
 * Small non-integers keep their decimals. Some `count` metrics are really rates
 * ("orders per active store per day" runs at 0.24), and rounding those to the
 * nearest integer prints a real measured value as 0 — which is precisely the
 * reading this dashboard is built to make impossible.
 */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value !== 0 && Math.abs(value) < 1) return value.toFixed(2);
  if (!Number.isInteger(value) && Math.abs(value) < 100) return value.toFixed(1);
  return groupIndian(Math.round(value)).replace(/\.00$/, '');
}

/** Ratios stored 0..1 rendered as percentages. */
export function formatPct(
  value: number | null | undefined,
  opts: { precision?: number; sign?: boolean } = {},
): string {
  const { precision = 1, sign = false } = opts;
  if (value == null || !Number.isFinite(value)) return '—';
  const pct = value * 100;
  const s = sign && pct > 0 ? '+' : '';
  return `${s}${pct.toFixed(precision)}%`;
}

/** Percentage-point deltas — the honest unit for a change in a rate. */
export function formatPp(value: number | null | undefined, precision = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const pp = value * 100;
  return `${pp > 0 ? '+' : ''}${pp.toFixed(precision)} pp`;
}

export function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

/** Dispatch on the unit carried by a metric definition (§5). */
export function formatByUnit(
  value: number | null | undefined,
  unit: 'count' | 'inr' | 'ratio' | 'ms' | 'score' | 'days',
): string {
  switch (unit) {
    case 'inr':
      return formatINR(value);
    case 'ratio':
      return formatPct(value);
    case 'ms':
      return formatMs(value);
    case 'score':
      return value == null || !Number.isFinite(value) ? '—' : value.toFixed(1);
    case 'days':
      return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)} d`;
    case 'count':
    default:
      return formatCount(value);
  }
}
