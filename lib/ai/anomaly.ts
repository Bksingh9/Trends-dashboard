/**
 * §28.4 — Anomaly detection. Deterministic. No model involved.
 *
 * The principle from §28.1: statistics decide what is anomalous, rules decide
 * what the candidate causes are, and the model only turns that into language.
 * Never let the model decide what is anomalous.
 */
import type { MetricValue } from '@/lib/metrics/compute';

export type Severity = 'info' | 'watch' | 'act';
export type Direction = 'up' | 'down';

export interface AnomalyPoint {
  dateKey: string;
  value: number;
  isSalePeriod?: boolean;
}

export interface Anomaly {
  metricId: string;
  label: string;
  direction: Direction;
  zScore: number | null;
  /** Which test fired: robust_z | wow | level_shift | zero_value | threshold. */
  test: string;
  severity: Severity;
  magnitude: string;
  current: number;
  baseline: number | null;
  ruleHits: string[];
  /** Set when the metric's connector is red — suppressed downstream (§28.4). */
  suppressed?: boolean;
  suppressionReason?: string;
}

/**
 * MAD rather than standard deviation: a single sale day would inflate σ and mask
 * real problems for the following month.
 *
 * 0.6745 makes MAD comparable to σ for normally distributed data.
 */
export function robustZ(x: number, history: number[]): number {
  if (history.length === 0) return 0;
  const med = median(history);
  const mad = median(history.map((h) => Math.abs(h - med)));
  if (mad === 0) return x === med ? 0 : Number.POSITIVE_INFINITY;
  return (0.6745 * (x - med)) / mad;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface DetectOptions {
  zThreshold: number;
  wowThreshold: number;
  /** Metrics whose collapse is always `act` severity. */
  p0Metrics?: string[];
  /** Connector health, so a pipeline break suppresses its downstream metrics. */
  redConnectorMetrics?: Set<string>;
  /** Threshold breaches from /settings, evaluated deterministically. */
  thresholdBreaches?: Array<{ metricId: string; observed: number; target: number; label: string }>;
}

const DEFAULT_P0_METRICS = [
  'orders',
  'egmv',
  'net_revenue',
  'unique_coverage',
  'payment_success_rate',
  'crash_free_rate',
];

export interface MetricHistory {
  metricId: string;
  label: string;
  current: number;
  /** Newest last, excluding today. */
  history: AnomalyPoint[];
  /** Same weekday, one week ago. */
  sameWeekdayLastWeek: number | null;
  unit: MetricValue['unit'];
  direction: MetricValue['direction'];
}

export function detectAnomalies(metrics: MetricHistory[], opts: DetectOptions): Anomaly[] {
  const out: Anomaly[] = [];
  const p0 = new Set(opts.p0Metrics ?? DEFAULT_P0_METRICS);

  for (const m of metrics) {
    // Retail runs on sale events; a 40% order spike during a sale is not an
    // anomaly. Exclude sale days from the baseline entirely.
    const baseline = m.history.filter((h) => !h.isSalePeriod).map((h) => h.value);
    if (baseline.length < 5) continue;

    const z = robustZ(m.current, baseline);
    const med = median(baseline);
    const dir: Direction = m.current >= med ? 'up' : 'down';
    const hits: Anomaly[] = [];

    // 1. Zero-value — almost always a pipeline break, not a business event.
    if (m.current === 0 && baseline.some((b) => b > 0)) {
      hits.push({
        metricId: m.metricId,
        label: m.label,
        direction: 'down',
        zScore: Number.isFinite(z) ? z : null,
        test: 'zero_value',
        severity: 'act',
        magnitude: `${m.label} read zero against a non-zero history (median ${fmt(med)})`,
        current: 0,
        baseline: med,
        ruleHits: [],
      });
    }

    // 2. Robust z against the trailing 28d.
    if (Math.abs(z) > opts.zThreshold && m.current !== 0) {
      hits.push({
        metricId: m.metricId,
        label: m.label,
        direction: dir,
        zScore: z,
        test: 'robust_z',
        severity: Math.abs(z) > 3 ? 'watch' : 'info',
        magnitude: `${m.label} ${dir === 'up' ? 'up' : 'down'} to ${fmt(m.current)} vs 28d median ${fmt(med)} (z ${z.toFixed(1)})`,
        current: m.current,
        baseline: med,
        ruleHits: [],
      });
    }

    // 3. Same-weekday week-over-week — retail is strongly weekday-seasonal.
    if (m.sameWeekdayLastWeek != null && m.sameWeekdayLastWeek !== 0) {
      const wow = m.current / m.sameWeekdayLastWeek - 1;
      if (Math.abs(wow) > opts.wowThreshold) {
        hits.push({
          metricId: m.metricId,
          label: m.label,
          direction: wow > 0 ? 'up' : 'down',
          zScore: Number.isFinite(z) ? z : null,
          test: 'wow',
          severity: 'info',
          magnitude: `${m.label} ${wow > 0 ? '+' : ''}${(wow * 100).toFixed(0)}% vs same weekday last week`,
          current: m.current,
          baseline: m.sameWeekdayLastWeek,
          ruleHits: [],
        });
      }
    }

    // 4. Level shift — 3 consecutive same-direction days with z > 1.5. Catches
    // slow degradation that daily tests miss entirely.
    const recent = m.history.slice(-3).map((h) => h.value);
    if (recent.length === 3) {
      const zs = recent.map((v) => robustZ(v, baseline.slice(0, -3)));
      const allUp = zs.every((s) => s > 1.5);
      const allDown = zs.every((s) => s < -1.5);
      if (allUp || allDown) {
        hits.push({
          metricId: m.metricId,
          label: m.label,
          direction: allUp ? 'up' : 'down',
          zScore: zs[2],
          test: 'level_shift',
          severity: 'watch',
          magnitude: `${m.label} has held ${allUp ? 'above' : 'below'} baseline for 3 consecutive days`,
          current: m.current,
          baseline: med,
          ruleHits: [],
        });
      }
    }

    // Keep the most severe hit per metric per test type.
    for (const h of hits) {
      if (p0.has(m.metricId) && h.test === 'zero_value') h.severity = 'act';
      out.push(h);
    }
  }

  // 5. Threshold breaches — deterministic, always fire.
  for (const b of opts.thresholdBreaches ?? []) {
    out.push({
      metricId: b.metricId,
      label: b.label,
      direction: b.observed < b.target ? 'down' : 'up',
      zScore: null,
      test: 'threshold',
      severity: p0.has(b.metricId) ? 'act' : 'watch',
      magnitude: `${b.label} at ${fmt(b.observed)} against target ${fmt(b.target)}`,
      current: b.observed,
      baseline: b.target,
      ruleHits: [],
    });
  }

  return suppress(out, opts.redConnectorMetrics ?? new Set());
}

/**
 * Suppression, so the layer stays trustworthy.
 *
 * Ten alerts caused by one broken pipe teaches people to ignore alerts — so
 * everything downstream of a red connector is suppressed and one connector alert
 * is raised instead.
 */
export function suppress(anomalies: Anomaly[], redConnectorMetrics: Set<string>): Anomaly[] {
  const bySeverity = { info: 0, watch: 1, act: 2 } as const;
  const best = new Map<string, Anomaly>();

  for (const a of anomalies) {
    if (redConnectorMetrics.has(a.metricId)) {
      a.suppressed = true;
      a.suppressionReason = 'Upstream connector is red — see /connectors';
    }
    const key = a.metricId;
    const existing = best.get(key);
    // No repeat alert on the same metric unless severity increases.
    if (!existing || bySeverity[a.severity] > bySeverity[existing.severity]) best.set(key, a);
  }
  return [...best.values()].sort((a, b) => bySeverity[b.severity] - bySeverity[a.severity]);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1 && n !== 0) return `${(n * 100).toFixed(1)}%`;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 1 });
}
