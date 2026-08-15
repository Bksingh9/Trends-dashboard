/**
 * §16.4 — journey discovery.
 *
 * Most of what follows guards one class of mistake: counting a fork as a
 * failure. The first working version of this module reported "85% drop at
 * Search" for a journey whose sessions had simply taken the scanner instead.
 * Every number in that sentence was arithmetically correct and the sentence was
 * false, which is the worst kind of dashboard output — it would have sent
 * somebody to debug a search screen that was working.
 */
import { describe, expect, it } from 'vitest';
import {
  compareJourneys,
  discoverJourneys,
  eventLabel,
  journeyFindings,
  type EventNode,
  type JourneyPath,
} from '@/lib/metrics/journeys';
import { deterministicNarrative } from '@/lib/ai/journey-narrative';
import { fixtureEventNodes, fixtureJourneyPaths } from '@/fixtures/journeys';
import { trailingWindow } from '@/lib/format/dates';

const path = (steps: string, sessions: number, converted = 0, revenue = 0): JourneyPath => ({
  steps: steps.split('>'),
  sessions,
  convertedSessions: converted,
  revenue,
  medianSeconds: 60,
});

const node = (event: string, sessions: number, revenueSessions = 0, revenue = 0): EventNode => ({
  event,
  sessions,
  events: sessions,
  revenueSessions,
  revenue,
});

/**
 * A deliberate fork: 1,000 sessions start, 400 go to the scanner, 300 to
 * search, and 300 do nothing at all. Small enough to check by hand.
 */
const FORKED: JourneyPath[] = [
  path('start', 300), // arrived and stopped
  path('start>scan>buy', 250, 250, 50_000),
  path('start>scan', 150),
  path('start>search>view', 200),
  path('start>search', 100),
];
const FORKED_NODES = [node('start', 1000), node('scan', 400), node('buy', 250, 250, 50_000), node('search', 300), node('view', 200)];

describe('the tree is exact, not modelled', () => {
  it('counts every path that shares a prefix at that prefix', () => {
    const [main] = discoverJourneys(FORKED, FORKED_NODES, { branchThreshold: 0.5 });
    expect(main.steps[0].sessions).toBe(1000);
    // 250 + 150 took the scanner. Not 1000 × P(scan|start), which would be the
    // same number here only by coincidence of the fixture.
    expect(main.steps[1].sessions).toBe(400);
    expect(main.steps[2].sessions).toBe(250);
  });

  it('returns nothing at all rather than an empty shape when there is no data', () => {
    expect(discoverJourneys([], [])).toEqual([]);
    expect(discoverJourneys([], FORKED_NODES)).toEqual([]);
  });

  it('produces no NaN or Infinity on a single one-step path', () => {
    const [only] = discoverJourneys([path('start', 5)], [node('start', 5)]);
    expect(only.conversion).toBe(1);
    expect(Number.isFinite(only.impact)).toBe(true);
    expect(only.worstStep).toBeNull();
  });
});

describe('a fork is not a drop', () => {
  const journeys = discoverJourneys(FORKED, FORKED_NODES, { branchThreshold: 0.5 });

  it('finds both routes, not just the heaviest', () => {
    expect(journeys.length).toBe(2);
    expect(journeys.map((j) => j.steps.map((s) => s.event).join('>')).sort()).toEqual([
      'start>scan>buy',
      'start>search>view',
    ]);
  });

  it('separates sessions that left from sessions that went elsewhere', () => {
    const main = journeys.find((j) => j.id === 'start>scan>buy')!;
    const scan = main.steps[1];
    // 1,000 reached start: 400 scanned, 300 searched, 300 did nothing.
    expect(scan.sessions).toBe(400);
    expect(scan.diverted).toBe(300);
    expect(scan.exited).toBe(300);
    expect(scan.divertedTo[0].event).toBe('search');
  });

  it('never charges the shared prefix’s exits to one branch', () => {
    // Both journeys pass through `start`. The 300 who stopped there belong to
    // neither exclusively, so neither may claim them as its own worst step.
    const branch = journeys.find((j) => j.id === 'start>search>view')!;
    expect(branch.worstStep?.event).not.toBe('search');
    expect(branch.impact).toBeLessThan(300);
  });

  it('measures a branch from its fork, not from the front door', () => {
    const branch = journeys.find((j) => j.id === 'start>search>view')!;
    // 300 searched, of whom 200 went on to view.
    expect(branch.entrySessions).toBe(300);
    expect(branch.forkAt).toBe(1);
    expect(branch.steps[0].shared).toBe(true);
    expect(branch.steps[1].shared).toBe(false);
    expect(branch.conversion).toBeCloseTo(200 / 300, 5);
  });

  it('names the two journeys differently', () => {
    // Both begin at `start`; naming from step 0 produced two identical labels.
    const labels = journeys.map((j) => j.label);
    expect(new Set(labels).size).toBe(2);
  });
});

describe('outcome is read from revenue, not from a list of event names', () => {
  it('marks a journey ending on a revenue-carrying event as converting', () => {
    const journeys = discoverJourneys(FORKED, FORKED_NODES, { branchThreshold: 0.5 });
    expect(journeys.find((j) => j.id === 'start>scan>buy')!.outcome).toBe('converts');
    expect(journeys.find((j) => j.id === 'start>search>view')!.outcome).toBe('abandons');
  });

  it('finds a second checkout flow under a different event name', () => {
    // The thing a hardcoded `purchase` would silently exclude. `order_placed`
    // is not in any list in this codebase; it converts because it took money.
    const paths = [path('start>order_placed', 100, 100, 20_000), path('start', 50)];
    const nodes = [node('start', 150), node('order_placed', 100, 100, 20_000)];
    expect(discoverJourneys(paths, nodes)[0].outcome).toBe('converts');
  });

  it('reports no revenue at risk when nothing on the journey ever converted', () => {
    // An invented rate is worse than an absent number: it would put a rupee
    // figure on screen that no measurement supports.
    const journeys = discoverJourneys(FORKED, FORKED_NODES, { branchThreshold: 0.5 });
    expect(journeys.find((j) => j.id === 'start>search>view')!.revenueAtRisk).toBeNull();
    expect(journeys.find((j) => j.id === 'start>scan>buy')!.revenueAtRisk).not.toBeNull();
  });
});

describe('ranking answers "where is the hole"', () => {
  it('ranks by sessions that left, not by how popular the path is', () => {
    const paths = [
      // Busy and healthy: almost everyone carries through.
      path('a>b>c', 900, 900, 90_000),
      path('a>b', 20),
      // Quiet and broken: most of the people who get here stop dead.
      path('a>x', 300),
      path('a>x>y', 60),
    ];
    const nodes = [node('a', 1280), node('b', 920), node('c', 900, 900, 90_000), node('x', 360), node('y', 60)];
    const [worst] = discoverJourneys(paths, nodes, { branchThreshold: 0.3 });
    expect(worst.id).toBe('a>x>y');
  });
});

describe('comparison against the previous window', () => {
  it('reports an unseen journey as new rather than comparing it to nothing', () => {
    const current = discoverJourneys(FORKED, FORKED_NODES, { branchThreshold: 0.5 });
    const shifts = compareJourneys(current, []);
    expect(shifts.every((s) => s.isNew)).toBe(true);
    expect(shifts.every((s) => s.conversionDeltaPp === null)).toBe(true);
  });

  it('names the step whose retention moved most', () => {
    const before = discoverJourneys(FORKED, FORKED_NODES, { branchThreshold: 0.5 });
    // Halve the scan→buy carry-through and nothing else.
    const worse = FORKED.map((p) =>
      p.steps.join('>') === 'start>scan>buy' ? { ...p, sessions: 125 } : p,
    );
    const after = discoverJourneys(worse, FORKED_NODES, { branchThreshold: 0.5 });
    const shift = compareJourneys(after, before).find((s) => s.id === 'start>scan>buy')!;
    expect(shift.isNew).toBe(false);
    expect(shift.movedStep?.event).toBe('buy');
    expect(shift.movedStep!.deltaPp).toBeLessThan(0);
  });
});

describe('findings are produced before any model is called', () => {
  const journeys = discoverJourneys(FORKED, FORKED_NODES, { branchThreshold: 0.5 });

  it('never says a drop happened where sessions merely forked', () => {
    const findings = journeyFindings(journeys);
    for (const f of findings) {
      // The exact wording of the original bug. If a finding ever reads
      // "N% drop at Search" again while those sessions went to the scanner,
      // this catches it.
      expect(f.detail).toMatch(/did nothing further|took another route|route that did not exist|Retention into/);
    }
  });

  it('quotes only numbers that exist in the journey', () => {
    const findings = journeyFindings(journeys);
    const f = findings.find((x) => x.detail.includes('did nothing further'));
    expect(f).toBeDefined();
    const j = journeys.find((x) => x.id === f!.journeyId)!;
    expect(f!.detail).toContain(j.impact.toLocaleString('en-IN'));
  });

  it('assembles a narrative with no model configured', () => {
    // The whole page must survive an expired API key with its numbers intact.
    for (const j of journeys) {
      const body = deterministicNarrative(j);
      expect(body.length).toBeGreaterThan(40);
      expect(body).not.toContain('undefined');
      expect(body).not.toContain('NaN');
    }
  });
});

describe('the fixture exercises what the fixture is for', () => {
  const w = trailingWindow(28);
  const paths = fixtureJourneyPaths(w);
  const nodes = fixtureEventNodes(w);

  it('branches, so the discovery engine is not tested on a straight line', () => {
    // A fixture built only from FUNNEL_STEPS has exactly one path, and would
    // make this module look like it works while never exercising a fork.
    expect(discoverJourneys(paths, nodes).length).toBeGreaterThan(1);
  });

  it('is deterministic across calls', () => {
    expect(fixtureJourneyPaths(w)).toEqual(paths);
  });

  it('keeps node totals consistent with the paths that imply them', () => {
    const fromPaths = new Map<string, number>();
    for (const p of paths) {
      for (const step of p.steps) fromPaths.set(step, (fromPaths.get(step) ?? 0) + p.sessions);
    }
    for (const n of nodes) expect(n.sessions).toBe(fromPaths.get(n.event));
  });

  it('never manufactures data for the step §16.9 records as uninstrumented', () => {
    // A6 — invoice/de-tag has never been confirmed to fire. A fixture that
    // invented it would make the dashboard claim to measure the one step it is
    // supposed to report as invisible.
    expect(nodes.map((n) => n.event)).not.toContain('invoice_detag');
  });
});

describe('labels', () => {
  it('degrades an unknown event to something readable rather than to a wrong step', () => {
    expect(eventLabel('add_to_cart')).toBe('Added to bag');
    expect(eventLabel('some_new_event')).toBe('Some new event');
  });
});
