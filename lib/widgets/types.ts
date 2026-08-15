/**
 * §4.10 — the widget model.
 *
 * A wall board is the one surface where a number appears with no page around it
 * to qualify it. Nobody standing six feet from a screen reads a footnote, and
 * nobody clicks a tooltip. That makes the board the easiest place in the whole
 * product to publish a confident wrong number, so two rules are structural
 * rather than conventional:
 *
 * 1. **A widget cannot compute.** It renders a `MetricValue` that a §5 module
 *    already produced. There is no arithmetic in this directory and none in the
 *    components — a widget that could compute would be a metric definition
 *    living outside `lib/metrics/`, which §5 forbids for exactly this reason.
 * 2. **A widget cannot outrank its metric's state.** Provenance and the
 *    fixture / stale / missing marker travel with the value and are drawn on
 *    every tile. A stale number on a NOC wall is how `avis_base_view` went
 *    unnoticed for two weeks.
 */
import type { DataSourceState } from '@/lib/connectors/types';
import type { MetricValue } from '@/lib/metrics/compute';

export type WidgetKind =
  /** One big figure with its comparison. The Geckoboard default. */
  | 'number'
  /** Progress toward a target, where a target actually exists. */
  | 'goal'
  /** A dial between a floor and a ceiling — for rates with a known good band. */
  | 'gauge'
  /** A ranked list: stores, gaps, journeys. */
  | 'leaderboard'
  /** A line over the window. */
  | 'trend'
  /** Red / amber / green against a threshold, and nothing else. */
  | 'status'
  /** Free text — a shift note, an escalation path, a link. */
  | 'text';

export const WIDGET_KINDS: WidgetKind[] = [
  'number',
  'goal',
  'gauge',
  'leaderboard',
  'trend',
  'status',
  'text',
];

/** Two columns wide, three, or four — the board grid is twelve. */
export type WidgetSize = 'sm' | 'md' | 'lg';

export const WIDGET_SPAN: Record<WidgetSize, number> = { sm: 3, md: 4, lg: 6 };

export interface WidgetSpec {
  id: string;
  kind: WidgetKind;
  /** A §5 metric id, for number / goal / gauge / status. */
  metricId?: string;
  /** A declared series id, for leaderboard / trend. */
  seriesId?: string;
  /** Overrides the metric's own label. Blank means use the metric's. */
  title?: string;
  /**
   * The target a goal or status is measured against.
   *
   * Read from `app_setting` where the metric has one there, so a threshold
   * changed on /settings moves the board too rather than leaving two numbers
   * disagreeing about what "good" is.
   */
  target?: number | null;
  size: WidgetSize;
  order: number;
}

/** A point in a leaderboard or a trend. Values only — no formatting decisions. */
export interface SeriesPoint {
  key: string;
  label: string;
  value: number;
  /** Rendered under the label where present — a city, a state, a date. */
  sub?: string;
}

export interface ResolvedSeries {
  points: SeriesPoint[];
  unit: MetricValue['unit'];
  source: string;
  state: DataSourceState;
  /** Higher-is-better decides which end of a leaderboard is the good end. */
  direction: MetricValue['direction'];
  /** Something the reader must know to read the shape correctly. */
  note?: string;
}

/**
 * A widget with everything needed to draw it, and nothing that would let it
 * decide anything. `unavailable` is a first-class outcome: a widget pointing at
 * a metric that no longer exists renders as a stated gap, never as a zero.
 */
export interface ResolvedWidget {
  spec: WidgetSpec;
  title: string;
  metric?: MetricValue;
  series?: ResolvedSeries;
  /** Set when the widget cannot be drawn. The tile says this, in words. */
  unavailable?: string;
}
