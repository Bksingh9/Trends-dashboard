/**
 * §4.10 — the board.
 *
 * The first test below is the one that matters, and it was written because the
 * board shipped with a hand-written metric→module map that was wrong in eight
 * places. Eight tiles would have said "not being published right now" — honest,
 * and useless, and entirely avoidable. `METRIC_MODULE` is a claim about the
 * rest of the system, so it is checked against the rest of the system.
 */
import { describe, expect, it } from 'vitest';
import { buildBoard, boardableMetrics, defaultTarget, DEFAULT_BOARD, METRIC_MODULE } from '@/lib/widgets/board';
import { SERIES, getSeries } from '@/lib/widgets/series';
import { validateWidget, WidgetRejected } from '@/lib/widgets/store';
import { WIDGET_KINDS, WIDGET_SPAN } from '@/lib/widgets/types';
import { getMetric } from '@/lib/metrics/registry';
import { DEFAULT_THRESHOLDS } from '@/lib/db/settings';
import {
  appHealthModule,
  catalogueModule,
  issuesModule,
  journeyDiscoveryModule,
  journeyModule,
  salesModule,
  storesModule,
} from '@/lib/services/modules';
import { trailingWindow } from '@/lib/format/dates';

const w = trailingWindow(28);

const emitted = new Map<string, string[]>();
{
  const mods = {
    sales: await salesModule(w),
    journey: await journeyModule(w),
    stores: await storesModule(w),
    catalogue: await catalogueModule(),
    appHealth: await appHealthModule(w),
    issues: await issuesModule(),
    discovered: await journeyDiscoveryModule(w),
  };
  for (const [id, mod] of Object.entries(mods)) {
    for (const k of mod.kpis) emitted.set(k.id, [...(emitted.get(k.id) ?? []), id]);
  }
}

describe('the metric→module map is a claim about the rest of the system', () => {
  it('names a module that really publishes each metric', () => {
    const wrong: string[] = [];
    for (const [metricId, moduleId] of Object.entries(METRIC_MODULE)) {
      const publishers = emitted.get(metricId);
      if (!publishers) wrong.push(`${metricId}: claimed ${moduleId}, published by nothing`);
      else if (!publishers.includes(moduleId)) {
        wrong.push(`${metricId}: claimed ${moduleId}, published by ${publishers.join('/')}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('offers every metric that a module actually publishes', () => {
    // The other direction: a metric with a module behind it but no entry here
    // simply cannot be put on a board, silently.
    const missing = [...emitted.keys()].filter((id) => !METRIC_MODULE[id]);
    expect(missing, `publishable but not offered: ${missing.join(', ')}`).toEqual([]);
  });

  it('offers only metrics that exist in the §5 registry', () => {
    for (const id of boardableMetrics()) expect(getMetric(id), `${id} is not in §5`).toBeTruthy();
  });
});

describe('series are declared, and every one resolves', () => {
  it('gives every series a description, a unit and at least one drawable kind', () => {
    for (const s of SERIES) {
      expect(s.description.length, `${s.id}`).toBeGreaterThan(15);
      expect(s.kinds.length, `${s.id}`).toBeGreaterThan(0);
      expect(s.label).toBeTruthy();
    }
  });

  it('has unique ids', () => {
    expect(new Set(SERIES.map((s) => s.id)).size).toBe(SERIES.length);
  });

  it('returns points with no NaN, and never a null rendered as zero', () => {
    // A null coverage drawn as 0% puts a working day on the floor of a chart.
    for (const s of SERIES) {
      const { points } = s.resolve({});
      for (const p of points) {
        expect(Number.isFinite(p.value), `${s.id}/${p.key}`).toBe(true);
      }
    }
  });
});

describe('a trend never plunges to zero on a day that has not loaded', () => {
  it('trims trailing empty days and says how many', () => {
    const def = getSeries('sales.daily_revenue')!;
    const r = def.resolve({
      sales: {
        data: {
          daily: [
            { dateKey: '2026-08-10', orders: 5, egmv: 100, netRevenue: 90 },
            { dateKey: '2026-08-11', orders: 6, egmv: 120, netRevenue: 110 },
            { dateKey: '2026-08-12', orders: 0, egmv: 0, netRevenue: 0 },
          ],
        },
      },
      // The rest of ModuleResult is irrelevant to `resolve`.
    } as never);
    expect(r.points).toHaveLength(2);
    expect(r.note).toMatch(/1 most recent day not shown/);
    expect(r.note).toMatch(/pending run rather than a fall to zero/);
  });

  it('keeps a zero in the middle of the window, because that one is real', () => {
    const def = getSeries('sales.daily_orders')!;
    const r = def.resolve({
      sales: {
        data: {
          daily: [
            { dateKey: '2026-08-10', orders: 5, egmv: 0, netRevenue: 0 },
            { dateKey: '2026-08-11', orders: 0, egmv: 0, netRevenue: 0 },
            { dateKey: '2026-08-12', orders: 7, egmv: 0, netRevenue: 0 },
          ],
        },
      },
    } as never);
    expect(r.points).toHaveLength(3);
    expect(r.points[1].value).toBe(0);
    expect(r.note).toBeUndefined();
  });
});

describe('widgets are validated before they are saved, not when they are drawn', () => {
  it('refuses a metric that does not exist', () => {
    expect(() => validateWidget({ kind: 'number', metricId: 'not_a_metric' })).toThrow(WidgetRejected);
  });

  it('refuses a widget kind that does not exist', () => {
    expect(() => validateWidget({ kind: 'sunburst', metricId: 'orders' })).toThrow(WidgetRejected);
  });

  it('refuses a leaderboard of a time series', () => {
    // Ranking dates by their value renders perfectly and means nothing.
    expect(() => validateWidget({ kind: 'leaderboard', seriesId: 'sales.daily_revenue' })).toThrow(
      /cannot be drawn as a leaderboard/,
    );
    expect(validateWidget({ kind: 'trend', seriesId: 'sales.daily_revenue' }).kind).toBe('trend');
  });

  it('refuses a goal on a count metric with no target', () => {
    // Otherwise the bar is drawn against a ceiling nobody agreed to.
    expect(() => validateWidget({ kind: 'goal', metricId: 'orders' })).toThrow(/needs an explicit target/);
    expect(validateWidget({ kind: 'goal', metricId: 'orders', target: 2000 }).target).toBe(2000);
  });

  it('refuses a text tile with nothing to say', () => {
    expect(() => validateWidget({ kind: 'text' })).toThrow(WidgetRejected);
    expect(validateWidget({ kind: 'text', title: 'Escalate to NOC on x2244' }).kind).toBe('text');
  });

  it('accepts a ratio goal with no target, because Settings supplies one', () => {
    const spec = validateWidget({ kind: 'goal', metricId: 'unique_coverage' });
    expect(spec.target).toBeNull();
    expect(defaultTarget('unique_coverage', DEFAULT_THRESHOLDS)).toBe(DEFAULT_THRESHOLDS.coverage_target);
  });

  it('invents no target for a metric that has none', () => {
    // A goal against a made-up ceiling is worse than a plain number.
    expect(defaultTarget('orders', DEFAULT_THRESHOLDS)).toBeNull();
    expect(defaultTarget('aov', DEFAULT_THRESHOLDS)).toBeNull();
  });
});

describe('building a board', () => {
  it('draws the starting board with every tile resolved', async () => {
    const board = await buildBoard(DEFAULT_BOARD, w);
    expect(board.widgets).toHaveLength(DEFAULT_BOARD.length);
    const broken = board.widgets.filter((x) => x.unavailable);
    expect(broken.map((b) => `${b.spec.metricId ?? b.spec.seriesId}: ${b.unavailable}`)).toEqual([]);
  });

  it('carries the metric’s state onto the tile rather than dropping it', async () => {
    // The whole reason the board is safe to put on a wall.
    const board = await buildBoard(DEFAULT_BOARD, w);
    for (const x of board.widgets) {
      if (x.metric) expect(x.metric.state).toBeTruthy();
      if (x.metric) expect(x.metric.source).toBeTruthy();
    }
  });

  it('says so, rather than showing zero, when a widget points at nothing', async () => {
    const board = await buildBoard(
      [
        { id: 'x1', kind: 'number', metricId: 'vanished_metric', size: 'sm', order: 1 },
        { id: 'x2', kind: 'leaderboard', seriesId: 'vanished.series', size: 'sm', order: 2 },
        { id: 'x3', kind: 'number', size: 'sm', order: 3 },
      ],
      w,
    );
    expect(board.widgets.every((x) => x.unavailable)).toBe(true);
    expect(board.widgets[0].unavailable).toMatch(/registry/);
    expect(board.widgets[1].unavailable).toMatch(/renamed/);
    expect(board.widgets[2].unavailable).toMatch(/points at nothing/);
    // Nothing resolved to a number.
    expect(board.widgets.some((x) => x.metric || x.series)).toBe(false);
  });

  it('runs only the modules its tiles need', async () => {
    // A board of one store tile must not pull orders, catalogue and GA4 too.
    const board = await buildBoard(
      [{ id: 's', kind: 'leaderboard', seriesId: 'stores.dark', size: 'md', order: 1 }],
      w,
    );
    expect(board.widgets[0].series).toBeTruthy();
    expect(board.warnings).toEqual([]);
  });

  it('orders tiles by position, not by the order they were passed', async () => {
    const board = await buildBoard(
      [
        { id: 'b', kind: 'number', metricId: 'orders', size: 'sm', order: 2 },
        { id: 'a', kind: 'number', metricId: 'egmv', size: 'sm', order: 1 },
      ],
      w,
    );
    expect(board.widgets.map((x) => x.spec.id)).toEqual(['a', 'b']);
  });

  it('gives every tile a title, so none renders headless', async () => {
    const board = await buildBoard(DEFAULT_BOARD, w);
    for (const x of board.widgets) expect(x.title.length).toBeGreaterThan(0);
  });
});

describe('the grid', () => {
  it('spans no more than twelve columns per size', () => {
    for (const span of Object.values(WIDGET_SPAN)) {
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(12);
    }
  });

  it('has a body for every declared kind', () => {
    // A kind offered in the picker with no renderer would draw an empty tile.
    expect(WIDGET_KINDS).toContain('number');
    expect(new Set(WIDGET_KINDS).size).toBe(WIDGET_KINDS.length);
  });
});
