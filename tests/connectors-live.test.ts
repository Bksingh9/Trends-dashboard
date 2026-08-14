/**
 * §6.4 / §14.5 — connectors as a running system, not a list of classes.
 *
 * The failure these guard against is the one that actually happened:
 * `avis_base_view` stopped reflecting new orders on 25 Jun 2026 and ran for two
 * weeks before anyone noticed, *while the pipeline reported itself as updating
 * daily*. Every individual piece was fine. What was missing was the loop —
 * something that notices a connector has not run, and something that makes the
 * cards say so.
 */
import { describe, expect, it, vi } from 'vitest';
import { CONNECTORS, connectorStatuses, getConnector } from '@/lib/connectors/registry';
import { isDue, SNAPSHOT_CONNECTORS, tick, windowFor, WINDOW_DAYS } from '@/lib/connectors/scheduler';
import { daysBetween } from '@/lib/format/dates';

describe('§6.4 — the schedule is the SLA, not a cron expression', () => {
  it('declares a freshness SLA on every connector', () => {
    for (const c of CONNECTORS) {
      expect(c.freshnessSlaMinutes, `${c.id} SLA`).toBeGreaterThan(0);
      expect(Number.isFinite(c.freshnessSlaMinutes), `${c.id} SLA is finite`).toBe(true);
    }
  });

  it('gives every connector a re-run window at least as wide as its cadence', () => {
    // Late-arriving rows are the norm: GA4 finalises daily tables up to 48h
    // late, and an order at 23:58 IST lands in tomorrow's extract. A window
    // that only covers "since the last run" loses those rows permanently,
    // because nothing ever looks at that date again.
    for (const c of CONNECTORS) {
      const days = WINDOW_DAYS[c.id];
      expect(days, `${c.id} has no declared re-run window`).toBeDefined();
      const w = windowFor(c.id);
      expect(daysBetween(w.start, w.end) + 1).toBe(days);
      // A windowed connector's re-run range must span at least one full SLA
      // period, or a day falls between two runs and is never looked at again.
      // Snapshot connectors replace a whole dimension and have no such gap.
      if (!SNAPSHOT_CONNECTORS.has(c.id)) {
        expect(days * 24 * 60, `${c.id} re-run window is narrower than its SLA`).toBeGreaterThanOrEqual(
          c.freshnessSlaMinutes,
        );
      }
    }
  });

  it('honours an explicit window for a backfill', () => {
    expect(windowFor('bq-orders', '2026-04-01', '2026-04-30')).toEqual({
      start: '2026-04-01',
      end: '2026-04-30',
    });
  });

  it('does not schedule an unconfigured connector', async () => {
    // Not a failure — a known §13 blocker. Running it to watch it fall back to
    // fixtures burns a tick and fills the log with noise that hides real
    // failures.
    const unconfigured = CONNECTORS.filter((c) => !c.isConfigured());
    expect(unconfigured.length, 'no unconfigured connector to test against').toBeGreaterThan(0);
    for (const c of unconfigured) {
      const v = await isDue(c.id);
      expect(v.due, `${c.id} should not be due`).toBe(false);
      expect(v.reason).toBe('not_configured');
    }
  });

  it('runs an unconfigured connector anyway when a human forces it', async () => {
    // The manual button. Someone who has just pasted a credential needs to see
    // it work now, not at the next heartbeat.
    const v = await isDue(CONNECTORS[0].id, { force: true });
    expect(v.due).toBe(true);
    expect(v.reason).toBe('forced');
  });

  it('returns a not-due verdict for an unknown id instead of throwing', async () => {
    const v = await isDue('does-not-exist');
    expect(v.due).toBe(false);
  });
});

describe('§6.4 — a tick is safe to fire as often as the plan allows', () => {
  it('runs nothing when nothing is due, and reports why for each', async () => {
    const r = await tick();
    expect(r.ran).toEqual([]);
    expect(r.skipped.length).toBe(CONNECTORS.length);
    for (const s of r.skipped) {
      expect(['not_configured', 'not_due', 'already_running']).toContain(s.reason);
    }
  });

  it('stays inside its wall-clock budget rather than being killed mid-run', async () => {
    // A serverless invocation killed at its limit never writes the run log,
    // leaving a row stuck at `running` that blocks every future run.
    const r = await tick({ force: true, budgetMs: 0 });
    expect(r.ran).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.skipped.length).toBe(CONNECTORS.length);
  });

  it('restricts to the named connector when asked', async () => {
    const id = CONNECTORS[0].id;
    const r = await tick({ only: [id] });
    expect(r.skipped.every((s) => s.id === id)).toBe(true);
    expect(r.ran.every((x) => x.id === id)).toBe(true);
  });

  it('reports a per-connector duration, so a slow connector is identifiable', async () => {
    const id = CONNECTORS[0].id;
    const r = await tick({ only: [id], force: true });
    for (const run of r.ran) {
      expect(run.ms).toBeGreaterThanOrEqual(0);
      expect(run.source).toBeTruthy();
    }
  });
});

describe('§4.9 — the board reflects the scheduler, not a separate opinion', () => {
  it('reads the same SLA the scheduler does', async () => {
    const statuses = await connectorStatuses();
    for (const s of statuses) {
      expect(s.freshnessSlaMinutes).toBe(getConnector(s.id)!.freshnessSlaMinutes);
    }
  });

  it('counts down to the next due time rather than showing a fixed cron slot', async () => {
    const statuses = await connectorStatuses();
    for (const s of statuses) {
      expect(s.nextDueInMinutes).toBeGreaterThanOrEqual(0);
      expect(s.nextDueInMinutes).toBeLessThanOrEqual(s.freshnessSlaMinutes);
    }
  });

  it('shows an unconfigured connector as a known blocker, not a failure', async () => {
    const statuses = await connectorStatuses();
    for (const s of statuses.filter((x) => !x.configured)) {
      expect(s.health).toBe('grey');
      expect(s.running).toBe(false);
    }
  });

  it('has a heartbeat cadence at least as tight as the tightest SLA', async () => {
    // The heartbeat in vercel.json is */15. If a connector ever declares an SLA
    // under 15 minutes, that schedule silently stops being able to meet it.
    const { readFileSync } = await import('node:fs');
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const tickCron = vercel.crons.find((c: { path: string }) => c.path.startsWith('/api/cron/tick'));
    expect(tickCron, 'no heartbeat cron configured').toBeDefined();

    const everyMinutes = Number(/^\*\/(\d+)/.exec(tickCron.schedule)?.[1] ?? Infinity);
    const shortestSla = Math.min(...CONNECTORS.map((c) => c.freshnessSlaMinutes));
    expect(everyMinutes).toBeLessThanOrEqual(shortestSla);
  });
});

/* ── the loop that was missing ───────────────────────────────────────────── */

describe('§14.5 — a stale mart never renders as live', () => {
  it('reports stale, not live, when the connector is past its SLA', async () => {
    // The `avis_base_view` shape: the table exists, the query succeeds, and the
    // rows stopped moving two weeks ago. A successful SELECT proves the table
    // is there, not that anything is still filling it.
    const { freshnessOf } = await import('@/lib/data/repository');

    const now = Date.now();
    const stale = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: new Date(now - 14 * 86_400_000).toISOString(),
      status: 'success' as const,
      error: null,
      seeded: false,
      runId: 1,
      startedAt: new Date(now - 14 * 86_400_000).toISOString(),
    }));
    expect(stale.state).toBe('stale');
    expect(stale.warnings.join(' ')).toMatch(/past its .* freshness SLA/);
    expect(stale.warnings.join(' ')).toMatch(/14 d/);
  });

  it('reports live when the connector completed inside its SLA', async () => {
    const { freshnessOf } = await import('@/lib/data/repository');
    const now = Date.now();
    const fresh = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: new Date(now - 60_000).toISOString(),
      status: 'success' as const,
      error: null,
      seeded: false,
      runId: 1,
      startedAt: new Date(now - 120_000).toISOString(),
    }));
    expect(fresh.state).toBe('live');
    expect(fresh.warnings).toEqual([]);
  });

  it('reports stale when the connector has never completed a run', async () => {
    const { freshnessOf } = await import('@/lib/data/repository');
    const never = await freshnessOf(['bq-orders'], async () => null);
    expect(never.state).toBe('stale');
    expect(never.warnings.join(' ')).toMatch(/no completed run on record/);
  });

  it('says the mart is on its last good snapshot after a failed run', async () => {
    // §6.3 — a hard assertion failure leaves the mart untouched. The rows are
    // valid; they are just not current, and the page has to say which.
    const { freshnessOf } = await import('@/lib/data/repository');
    const now = Date.now();
    const failed = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: new Date(now - 60_000).toISOString(),
      status: 'fail' as const,
      error: 'row_volume: 40% below the trailing median',
      seeded: false,
      runId: 1,
      startedAt: new Date(now - 120_000).toISOString(),
    }));
    expect(failed.state).toBe('stale');
    expect(failed.warnings.join(' ')).toMatch(/last good snapshot/);
    expect(failed.warnings.join(' ')).toMatch(/row_volume/);
  });

  it('is a no-op for a mart with no connector behind it', async () => {
    const { freshnessOf } = await import('@/lib/data/repository');
    expect(await freshnessOf([], async () => null)).toEqual({ state: 'live', warnings: [] });
  });
});

describe('§14.5 — a seeded mart is fixture data, whatever is in Postgres', () => {
  it('reports fixture, not live, when the last run was a seed', async () => {
    // Seeding puts fixture rows in a real table. The row count and the query
    // success prove nothing about provenance, so the flag on the run is the
    // only thing between a seeded mart and a page claiming to be live.
    const { freshnessOf } = await import('@/lib/data/repository');
    const r = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: new Date().toISOString(),
      status: 'success' as const,
      error: null,
      seeded: true,
    }));
    expect(r.state).toBe('fixture');
    expect(r.warnings.join(' ')).toMatch(/seeded from fixtures/);
  });

  it('lets fixture outrank stale, because "not real" matters more than "old"', async () => {
    const { freshnessOf } = await import('@/lib/data/repository');
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const r = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: old,
      status: 'success' as const,
      error: null,
      seeded: true,
    }));
    // Calling a fixture "stale" implies it was ever current.
    expect(r.state).toBe('fixture');
  });
});

/* ── the load path, exercised ────────────────────────────────────────────── */

describe('§27.5 — every connector can actually load', () => {
  it('gives all but the deferred connectors a fixture to load', () => {
    // A connector with no fixture has never executed its own `load()`. The
    // first production run would then also be the first test of the idempotent
    // upsert, on real data, with nothing to compare against.
    //
    // ga4-api and amplitude are deferred by §13.8 and §24 respectively — they
    // are named here so the exemption is a decision rather than an oversight,
    // and so adding a fifteenth connector without a fixture fails this test.
    const deferred = new Set(['ga4-api', 'amplitude']);
    const w = { start: '2026-08-01', end: '2026-08-02' };

    for (const c of CONNECTORS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (c as any).fixture(w) as unknown[];
      if (deferred.has(c.id)) {
        expect(rows.length, `${c.id} is listed as deferred but now has a fixture`).toBe(0);
      } else {
        expect(rows.length, `${c.id} has no fixture, so its load path is untested`).toBeGreaterThan(0);
      }
    }
  });

  it('refuses to seed a production mart', async () => {
    // Fixture rows in a production mart cannot be told apart from real ones at
    // the row level afterwards. There is no honest way to un-mix them.
    const prev = process.env.NODE_ENV;
    try {
      vi.stubEnv('NODE_ENV', 'production');
      await expect(CONNECTORS[0].seed({ start: '2026-08-01', end: '2026-08-02' })).rejects.toThrow(
        /Refusing to seed/,
      );

      // …and the escape hatch is deliberately awkward to type, because
      // reaching for it should be a decision rather than a reflex.
      vi.stubEnv('ALLOW_FIXTURE_SEED', 'i-understand');
      await expect(CONNECTORS[0].seed({ start: '2026-08-01', end: '2026-08-02' })).resolves.toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(prev);
    }
  });

  it('runs the assertion gate over seeded rows too', async () => {
    // A fixture that cannot pass its own connector's assertions is a broken
    // fixture, and skipping the gate here would defer that discovery to the
    // first real load — the same problem seeding exists to solve.
    const w = { start: '2026-08-01', end: '2026-08-02' };
    const orders = getConnector('bq-orders')!;
    const result = await orders.seed(w);
    expect(result.assertions, 'seed ran no assertions').toBeDefined();
    expect(result.assertions!.length).toBeGreaterThan(0);
  });

  it('marks the seeded run so the serving layer can never call it live', async () => {
    const w = { start: '2026-08-01', end: '2026-08-02' };
    await getConnector('sentry')!.seed(w);
    const run = await (await import('@/lib/connectors/run-log')).lastRunFor('sentry');
    expect(run?.seeded).toBe(true);
    // …and the metadata says so in words, not just a flag.
    expect(run?.status === 'success' || run?.status === 'warn').toBe(true);
  });
});
