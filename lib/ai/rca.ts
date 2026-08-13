/**
 * §28.5 — Root-cause rule engine.
 *
 * Rule-driven candidate generation, model-written narrative. Each hint renders
 * with its supporting numbers visible and links to the module that proves or
 * disproves it.
 */
import type { Anomaly } from './anomaly';

export interface RcaRule {
  id: string;
  /** Conditions in the spec's shorthand: `metric↓`, `metric↑`, or a named state. */
  when: string[];
  hypothesis: string;
  evidence: string[];
  module: string;
  /**
   * `pipeline_not_business` carries this for a reason: given the
   * `avis_base_view` history, the most likely explanation for a sudden metric
   * collapse in this specific system is that a pipe broke. Check that before
   * anyone wakes up an engineer.
   */
  priority?: 'always_first';
}

export const RCA_RULES: RcaRule[] = [
  {
    id: 'payment_path',
    when: ['orders↓', 'payment_success_rate↓'],
    hypothesis: 'Payment or gateway failure is suppressing orders',
    evidence: ['payment_failure_rate', 'p95_latency[payment_initiate]', 'sentry payment errors'],
    module: '/app-health',
  },
  {
    id: 'catalogue_path',
    when: ['orders↓', 'scan_success_rate↓', 'unique_coverage↓'],
    hypothesis: 'Products are not scannable, so journeys end before the bag',
    evidence: ['missing_new', 'topReasons', 'store_coverage'],
    module: '/catalogue',
  },
  {
    id: 'traffic_path',
    when: ['orders↓', 'funnel rates flat'],
    hypothesis: 'Fewer people are using the app; adoption not conversion',
    evidence: ['stores_active', 'stores_dark', 'sessions', 'daily_order_compliance'],
    module: '/stores',
  },
  {
    id: 'store_local',
    when: ['unique_coverage↓', 'gap concentrated in <5 stores'],
    hypothesis: 'Store-level inventory sync issue, not a catalogue issue',
    evidence: ['store_coverage', 'store-wise missing EAN counts'],
    module: '/catalogue',
  },
  {
    id: 'upstream_ingestion',
    when: ['unique_coverage↓ broadly', 'missing_new spike'],
    hypothesis: 'Upstream catalogue ingestion or category mapping has regressed',
    evidence: ['topReasons where reason=category_not_mapped', 'absent_from_master count'],
    module: '/catalogue',
  },
  {
    id: 'rpos_dependency',
    when: ['p95_latency[apply_promotion]↑', 'checkout_rate↓'],
    hypothesis: 'RPOS promotion latency is causing cart abandonment',
    evidence: ['p95/p99 on apply_promotion', 'begin_checkout vs view_cart'],
    module: '/app-health',
  },
  {
    id: 'release_regression',
    when: ['crash_free_rate↓', 'release marker within 48h'],
    hypothesis: 'The recent release introduced a regression',
    evidence: ['crash_free by release', 'sentry errors by release', 'release_adoption'],
    module: '/app-health',
  },
  {
    id: 'pipeline_not_business',
    when: ['any metric zero-valued', 'connector red or stale'],
    hypothesis: 'This is a data pipeline failure, not a business change',
    evidence: ['connectorHealth', 'etl_run_log'],
    module: '/connectors',
    priority: 'always_first',
  },
];

export interface RcaFacts {
  anomalies: Anomaly[];
  /** Connectors currently red or stale. */
  unhealthyConnectors: string[];
  /** True when the coverage drop is concentrated in fewer than five stores. */
  gapConcentratedInFewStores: boolean;
  /** True when funnel step conversion rates are flat despite an order drop. */
  funnelRatesFlat: boolean;
  /** A release marker within the last 48 hours. */
  recentRelease: { version: string; dateCreated: string } | null;
  /** New missing-EAN count spiked against its own baseline. */
  missingNewSpike: boolean;
}

export interface RcaHit {
  rule: RcaRule;
  /** Which of the rule's `when` conditions were satisfied. */
  matched: string[];
  /** The numbers that support it — rendered alongside the hypothesis, always. */
  supporting: Array<{ label: string; value: string }>;
  confidence: 'high' | 'medium' | 'low';
}

function anomalyFor(facts: RcaFacts, metricId: string, dir?: 'up' | 'down'): Anomaly | undefined {
  return facts.anomalies.find(
    (a) => a.metricId === metricId && (!dir || a.direction === dir) && !a.suppressed,
  );
}

function fmt(a: Anomaly | undefined): string {
  if (!a) return '—';
  return a.magnitude;
}

export function evaluateRca(facts: RcaFacts): RcaHit[] {
  const hits: RcaHit[] = [];

  const zeroValued = facts.anomalies.filter((a) => a.test === 'zero_value');
  const pipelineBroken = facts.unhealthyConnectors.length > 0 || zeroValued.length > 0;

  // always_first: a pipeline failure is checked before any business explanation.
  if (pipelineBroken) {
    hits.push({
      rule: RCA_RULES.find((r) => r.id === 'pipeline_not_business')!,
      matched: [
        ...(zeroValued.length ? ['any metric zero-valued'] : []),
        ...(facts.unhealthyConnectors.length ? ['connector red or stale'] : []),
      ],
      supporting: [
        { label: 'Unhealthy connectors', value: facts.unhealthyConnectors.join(', ') || 'none' },
        { label: 'Zero-valued metrics', value: zeroValued.map((a) => a.metricId).join(', ') || 'none' },
      ],
      confidence: 'high',
    });
  }

  const ordersDown = anomalyFor(facts, 'orders', 'down');
  const paymentDown = anomalyFor(facts, 'payment_success_rate', 'down');
  const scanDown = anomalyFor(facts, 'scan_success_rate', 'down');
  const coverageDown = anomalyFor(facts, 'unique_coverage', 'down');
  const checkoutDown = anomalyFor(facts, 'checkout_rate', 'down');
  const latencyUp = anomalyFor(facts, 'p95_latency', 'up');
  const crashDown = anomalyFor(facts, 'crash_free_rate', 'down');

  if (ordersDown && paymentDown) {
    hits.push({
      rule: RCA_RULES.find((r) => r.id === 'payment_path')!,
      matched: ['orders↓', 'payment_success_rate↓'],
      supporting: [
        { label: 'Orders', value: fmt(ordersDown) },
        { label: 'Payment success', value: fmt(paymentDown) },
      ],
      confidence: 'high',
    });
  }

  if (ordersDown && scanDown && coverageDown) {
    hits.push({
      rule: RCA_RULES.find((r) => r.id === 'catalogue_path')!,
      matched: ['orders↓', 'scan_success_rate↓', 'unique_coverage↓'],
      supporting: [
        { label: 'Orders', value: fmt(ordersDown) },
        { label: 'Scan success', value: fmt(scanDown) },
        { label: 'Coverage', value: fmt(coverageDown) },
      ],
      confidence: 'high',
    });
  }

  if (ordersDown && facts.funnelRatesFlat) {
    hits.push({
      rule: RCA_RULES.find((r) => r.id === 'traffic_path')!,
      matched: ['orders↓', 'funnel rates flat'],
      supporting: [
        { label: 'Orders', value: fmt(ordersDown) },
        { label: 'Funnel rates', value: 'flat — conversion unchanged, volume down' },
      ],
      confidence: 'medium',
    });
  }

  // store_local and upstream_ingestion are deliberately mutually exclusive:
  // concentration is what tells them apart, and confusing them sends the wrong
  // team at the problem.
  if (coverageDown && facts.gapConcentratedInFewStores) {
    hits.push({
      rule: RCA_RULES.find((r) => r.id === 'store_local')!,
      matched: ['unique_coverage↓', 'gap concentrated in <5 stores'],
      supporting: [
        { label: 'Coverage', value: fmt(coverageDown) },
        { label: 'Concentration', value: 'fewer than 5 stores account for the drop' },
      ],
      confidence: 'high',
    });
  } else if (coverageDown && facts.missingNewSpike) {
    hits.push({
      rule: RCA_RULES.find((r) => r.id === 'upstream_ingestion')!,
      matched: ['unique_coverage↓ broadly', 'missing_new spike'],
      supporting: [
        { label: 'Coverage', value: fmt(coverageDown) },
        { label: 'New missing EANs', value: 'spiked against baseline' },
      ],
      confidence: 'medium',
    });
  }

  if (latencyUp && checkoutDown) {
    hits.push({
      rule: RCA_RULES.find((r) => r.id === 'rpos_dependency')!,
      matched: ['p95_latency[apply_promotion]↑', 'checkout_rate↓'],
      supporting: [
        { label: 'p95 latency', value: fmt(latencyUp) },
        { label: 'Checkout rate', value: fmt(checkoutDown) },
      ],
      confidence: 'medium',
    });
  }

  if (crashDown && facts.recentRelease) {
    hits.push({
      rule: RCA_RULES.find((r) => r.id === 'release_regression')!,
      matched: ['crash_free_rate↓', 'release marker within 48h'],
      supporting: [
        { label: 'Crash-free', value: fmt(crashDown) },
        { label: 'Release', value: `${facts.recentRelease.version} on ${facts.recentRelease.dateCreated.slice(0, 10)}` },
      ],
      confidence: 'high',
    });
  }

  // always_first stays first regardless of what else matched.
  return hits.sort((a, b) => {
    if (a.rule.priority === 'always_first') return -1;
    if (b.rule.priority === 'always_first') return 1;
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.confidence] - rank[b.confidence];
  });
}
