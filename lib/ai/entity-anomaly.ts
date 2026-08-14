/**
 * Per-store and per-state anomaly detection.
 *
 * The global sweep in `anomaly.ts` compares a metric against its own history. It
 * cannot see a single store that has broken, because 270 healthy stores drown
 * one bad one — coverage falls from 94.0% to 93.8% and nothing trips. That is
 * exactly the failure the NOC needs to catch first, since a store-local problem
 * has a different owner and a different fix from a systemic one.
 *
 * So this compares each entity against **its cohort** rather than against its
 * own past: a store whose coverage sits five MADs below the median of every
 * other store is broken now, regardless of what it did last week.
 *
 * It also answers the question §28.5 actually turns on — *how concentrated* is a
 * drop — which is what separates `store_local` from `upstream_ingestion` and
 * decides which team gets called.
 */
import { robustZ, type Severity } from './anomaly';

export type EntityType = 'store' | 'state';

/**
 * The z assigned when a cohort has zero spread. Large enough to sort above any
 * real z-score and to band as `act`, finite enough to format and compare.
 */
const MAX_Z = 99;

export interface EntityObservation {
  entityId: string;
  entityLabel: string;
  /** The metric value for this entity. */
  value: number;
  /** Denominator behind the value — a 40% coverage on 3 scans is noise. */
  weight: number;
}

export interface EntityAnomaly {
  entityType: EntityType;
  entityId: string;
  entityLabel: string;
  metricId: string;
  metricLabel: string;
  value: number;
  cohortMedian: number;
  zScore: number;
  severity: Severity;
  magnitude: string;
  /** How much of the cohort-wide shortfall this one entity accounts for. */
  shareOfShortfall: number;
}

export interface EntitySweepOptions {
  metricId: string;
  metricLabel: string;
  entityType: EntityType;
  /** Direction that counts as bad. Coverage down is bad; error rate up is bad. */
  worseWhen: 'below' | 'above';
  /** Robust z threshold. Default 2.5, matching the global sweep. */
  zThreshold?: number;
  /**
   * Entities below this weight are excluded. A store with four scans can show a
   * 50% coverage that means nothing, and letting it into the ranking pushes the
   * genuinely broken stores off the top of the list.
   */
  minWeight?: number;
  unit?: 'ratio' | 'count' | 'ms' | 'inr';
}

function fmt(v: number, unit: EntitySweepOptions['unit']): string {
  if (unit === 'ratio') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'ms') return `${Math.round(v)} ms`;
  return v.toLocaleString('en-IN', { maximumFractionDigits: 1 });
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Finds entities that are outliers against their peers *right now*.
 *
 * Deliberately cohort-relative rather than history-relative. A store that has
 * always been broken never shows up in a week-over-week comparison, but it is
 * still broken, and it is still costing orders every day.
 */
export function detectEntityAnomalies(
  observations: EntityObservation[],
  opts: EntitySweepOptions,
): EntityAnomaly[] {
  const zThreshold = opts.zThreshold ?? 2.5;
  const minWeight = opts.minWeight ?? 30;

  const eligible = observations.filter((o) => o.weight >= minWeight && Number.isFinite(o.value));
  // Below about eight peers a "cohort median" is not a cohort, it is an opinion.
  if (eligible.length < 8) return [];

  const values = eligible.map((o) => o.value);
  const cohortMedian = median(values);

  // Total shortfall across the cohort, used to attribute concentration.
  const shortfallOf = (v: number) =>
    opts.worseWhen === 'below' ? Math.max(0, cohortMedian - v) : Math.max(0, v - cohortMedian);
  const totalShortfall = eligible.reduce((a, o) => a + shortfallOf(o.value) * o.weight, 0);

  const out: EntityAnomaly[] = [];
  for (const o of eligible) {
    const rawZ = robustZ(o.value, values);

    // A cohort where every peer sits at the same value has MAD 0, so robustZ
    // returns ±Infinity for anything that differs. That is the *most* anomalous
    // case available, not an unmeasurable one — discarding it as "not finite"
    // would silently drop the single clearest signal the sweep can produce.
    // Capped rather than left infinite so it sorts, formats and bands normally.
    const z = Number.isFinite(rawZ)
      ? rawZ
      : rawZ === 0
        ? 0
        : o.value < cohortMedian
          ? -MAX_Z
          : MAX_Z;

    const isBad = opts.worseWhen === 'below' ? z < -zThreshold : z > zThreshold;
    if (!isBad) continue;

    const share = totalShortfall === 0 ? 0 : (shortfallOf(o.value) * o.weight) / totalShortfall;
    const severity: Severity = Math.abs(z) > 4 ? 'act' : Math.abs(z) > 3 ? 'watch' : 'info';

    out.push({
      entityType: opts.entityType,
      entityId: o.entityId,
      entityLabel: o.entityLabel,
      metricId: opts.metricId,
      metricLabel: opts.metricLabel,
      value: o.value,
      cohortMedian,
      zScore: z,
      severity,
      shareOfShortfall: share,
      magnitude: `${o.entityLabel}: ${opts.metricLabel} at ${fmt(o.value, opts.unit)} against a cohort median of ${fmt(cohortMedian, opts.unit)} (z ${z.toFixed(1)})`,
    });
  }

  return out.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
}

export interface Concentration {
  /** Share of the total shortfall held by the worst N entities. */
  topNShare: number;
  topN: number;
  /** Entities needed to account for 80% of the shortfall. */
  entitiesFor80pc: number;
  totalEntities: number;
  /**
   * The call this analysis exists to make. `concentrated` points at a
   * store-local or regional problem; `systemic` points upstream. Getting this
   * wrong sends the wrong team.
   */
  verdict: 'concentrated' | 'systemic' | 'insufficient_data';
  explanation: string;
}

/**
 * §28.5 — `store_local` vs `upstream_ingestion` hinges entirely on this. The
 * rule engine previously used a crude "fewer than five stores are below 90%"
 * heuristic, which mistakes a broad shallow decline for a narrow deep one.
 */
export function concentration(
  observations: EntityObservation[],
  opts: { worseWhen: 'below' | 'above'; topN?: number; minWeight?: number },
): Concentration {
  const topN = opts.topN ?? 5;
  const minWeight = opts.minWeight ?? 30;
  const eligible = observations.filter((o) => o.weight >= minWeight && Number.isFinite(o.value));

  if (eligible.length < 8) {
    return {
      topNShare: 0,
      topN,
      entitiesFor80pc: 0,
      totalEntities: eligible.length,
      verdict: 'insufficient_data',
      explanation: `Only ${eligible.length} entities clear the weight floor — too few to call concentration either way.`,
    };
  }

  const med = median(eligible.map((o) => o.value));
  const shortfalls = eligible
    .map((o) => ({
      id: o.entityId,
      amount: (opts.worseWhen === 'below' ? Math.max(0, med - o.value) : Math.max(0, o.value - med)) * o.weight,
    }))
    .sort((a, b) => b.amount - a.amount);

  const total = shortfalls.reduce((a, s) => a + s.amount, 0);
  if (total === 0) {
    return {
      topNShare: 0,
      topN,
      entitiesFor80pc: 0,
      totalEntities: eligible.length,
      verdict: 'systemic',
      explanation: 'No entity is materially below the cohort median.',
    };
  }

  const topNShare = shortfalls.slice(0, topN).reduce((a, s) => a + s.amount, 0) / total;

  let cumulative = 0;
  let entitiesFor80pc = 0;
  for (const s of shortfalls) {
    cumulative += s.amount;
    entitiesFor80pc++;
    if (cumulative / total >= 0.8) break;
  }

  // Concentrated when a handful of entities carry most of the damage. The
  // threshold is deliberately high: a 60/40 split is not "a few bad stores",
  // and calling it that sends the NOC chasing individual stores while an
  // upstream mapping problem keeps spreading.
  const isConcentrated = topNShare >= 0.6 && entitiesFor80pc <= Math.max(5, eligible.length * 0.1);

  return {
    topNShare,
    topN,
    entitiesFor80pc,
    totalEntities: eligible.length,
    verdict: isConcentrated ? 'concentrated' : 'systemic',
    explanation: isConcentrated
      ? `The worst ${topN} of ${eligible.length} account for ${(topNShare * 100).toFixed(0)}% of the shortfall, and ${entitiesFor80pc} cover 80% of it — a store-local or regional problem, not a catalogue-wide one.`
      : `The shortfall is spread across ${entitiesFor80pc} of ${eligible.length} entities, with the worst ${topN} holding only ${(topNShare * 100).toFixed(0)}% — this looks upstream, not store-local.`,
  };
}

/** Roll store-level observations up to state level, weighting by volume. */
export function rollUpToStates(
  stores: Array<EntityObservation & { state: string }>,
): EntityObservation[] {
  const byState = new Map<string, { weighted: number; weight: number }>();
  for (const s of stores) {
    if (!s.state) continue;
    const cur = byState.get(s.state) ?? { weighted: 0, weight: 0 };
    // Weight by volume so a state is not swung by its smallest store.
    cur.weighted += s.value * s.weight;
    cur.weight += s.weight;
    byState.set(s.state, cur);
  }
  return [...byState.entries()].map(([state, v]) => ({
    entityId: state,
    entityLabel: state,
    value: v.weight === 0 ? 0 : v.weighted / v.weight,
    weight: v.weight,
  }));
}
