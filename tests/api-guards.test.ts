/**
 * Security and abuse-path QA for the guarded endpoints.
 *
 * The SQL guard cases here are adversarial on purpose. The regex is defence in
 * depth — the read-only database role is the real boundary (§28.6) — but a guard
 * that waves through obvious injections gives false comfort.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { guardSql, SQL_GUARD } from '@/lib/ai/sql-guard';
import { rateLimit, resetRateLimits, safeEqual } from '@/lib/api/guards';

afterEach(() => resetRateLimits());

describe('SQL guard — adversarial input', () => {
  it.each([
    ['DROP TABLE fact_orders'],
    ['drop table fact_orders'],
    ['SELECT 1; DELETE FROM fact_orders'],
    ['SELECT 1;DROP TABLE fact_orders'],
    ['UPDATE fact_orders SET net_value = 0'],
    ['INSERT INTO fact_orders VALUES (1)'],
    ['TRUNCATE fact_orders'],
    ['GRANT ALL ON fact_orders TO public'],
    ['CREATE TABLE evil (x int)'],
    ['COPY fact_orders TO \'/tmp/x\''],
    ['SELECT * FROM pg_shadow'],
    ['SELECT * FROM pg_catalog.pg_user'],
    ['SELECT * FROM information_schema.columns'],
    ['SELECT pg_read_file(\'/etc/passwd\')'],
    ['SELECT * FROM dblink(\'\', \'\')'],
    ['SELECT * FROM fact_orders UNION SELECT * FROM pg_user'],
    ['SELECT * FROM generate_series(1, 100000000)'],
    ['SELECT * FROM users'],
    ['SELECT * FROM app_setting'], // real table, deliberately not allowlisted
    ['SELECT * FROM etl_run_log'],
  ])('rejects %s', (sql) => {
    const g = guardSql(sql);
    expect(g.ok, `should have been rejected: ${sql}`).toBe(false);
    expect(g.violations.length).toBeGreaterThan(0);
  });

  it.each([
    ['SELECT store_id, orders FROM fact_store_adoption_daily LIMIT 50'],
    ['SELECT s.state, SUM(o.net_value) FROM fact_orders o JOIN dim_store s ON s.store_id = o.store_id GROUP BY 1'],
    ['WITH d AS (SELECT * FROM fact_scan_daily LIMIT 10) SELECT count(*) FROM d'],
    ['SELECT * FROM public.dim_store'],
    ['SELECT * FROM "dim_store"'],
  ])('accepts legitimate query: %s', (sql) => {
    const g = guardSql(sql);
    expect(g.ok, `should have been accepted: ${sql} — ${g.violations.join('; ')}`).toBe(true);
  });

  it('always bounds the result set, even when the model omits a LIMIT', () => {
    const g = guardSql('SELECT * FROM fact_orders');
    expect(g.sql).toMatch(/LIMIT 5000\s*$/);
  });

  it('clamps an oversized LIMIT rather than trusting it', () => {
    expect(guardSql('SELECT * FROM fact_orders LIMIT 10000000').appliedLimit).toBe(SQL_GUARD.requireLimit);
  });

  it('never targets BigQuery — generated SQL is Postgres-only', () => {
    // A generated query reaching BigQuery would bypass the byte-scanned cap.
    expect(SQL_GUARD.targetOnly).toBe('postgres');
  });

  it('names a read-only database role as the actual boundary', () => {
    expect(SQL_GUARD.dbRole).toBe('dashboard_readonly');
  });

  it('does not allow a table that merely contains an allowlisted name', () => {
    const g = guardSql('SELECT * FROM fact_orders_shadow');
    expect(g.ok).toBe(false);
  });
});

describe('constant-time secret comparison', () => {
  it('matches identical secrets', () => {
    expect(safeEqual('Bearer abc123', 'Bearer abc123')).toBe(true);
  });

  it('rejects a different secret of the same length', () => {
    expect(safeEqual('Bearer abc123', 'Bearer abc124')).toBe(false);
  });

  it('rejects a different length without throwing', () => {
    // timingSafeEqual throws on length mismatch; the wrapper must not surface
    // that as a 500, which would itself be an oracle.
    expect(() => safeEqual('short', 'much longer secret')).not.toThrow();
    expect(safeEqual('short', 'much longer secret')).toBe(false);
  });

  it('rejects an empty header against a real secret', () => {
    expect(safeEqual('', 'Bearer real-secret')).toBe(false);
  });
});

describe('rate limiting (§28.9)', () => {
  it('allows up to the limit then refuses', () => {
    for (let i = 0; i < 20; i++) {
      expect(rateLimit('user@a', { limit: 20, windowSeconds: 60 }).allowed, `call ${i}`).toBe(true);
    }
    const blocked = rateLimit('user@a', { limit: 20, windowSeconds: 60 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetInSeconds).toBeGreaterThan(0);
  });

  it('counts per user, so one runaway client cannot lock out everyone', () => {
    for (let i = 0; i < 20; i++) rateLimit('noisy@a', { limit: 20 });
    expect(rateLimit('noisy@a', { limit: 20 }).allowed).toBe(false);
    expect(rateLimit('quiet@a', { limit: 20 }).allowed).toBe(true);
  });

  it('reports the remaining budget', () => {
    expect(rateLimit('u', { limit: 3 }).remaining).toBe(2);
    expect(rateLimit('u', { limit: 3 }).remaining).toBe(1);
    expect(rateLimit('u', { limit: 3 }).remaining).toBe(0);
  });

  it('forgets old hits once the window passes', () => {
    for (let i = 0; i < 5; i++) rateLimit('w', { limit: 5, windowSeconds: 60 });
    expect(rateLimit('w', { limit: 5, windowSeconds: 60 }).allowed).toBe(false);
    // A zero-length window means every prior hit is already outside it.
    expect(rateLimit('w', { limit: 5, windowSeconds: 0 }).allowed).toBe(true);
  });
});

describe('query-param validation — a bad URL must never 500', () => {
  const parse = async (qs: string) => {
    const { parseParams } = await import('@/lib/api/envelope');
    return parseParams(new URL(`https://x/api/kpi?${qs}`), 28);
  };

  it('falls back to the default window on an unparseable date', async () => {
    const p = await parse('start=not-a-date&end=also-bad');
    expect(p.window.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.warnings.join(' ')).toMatch(/Ignored an invalid date range/);
  });

  it('rejects a well-formed but non-existent date', async () => {
    // 2026-02-31 passes a regex but is not a real day.
    const p = await parse('start=2026-02-31&end=2026-03-01');
    expect(p.warnings.join(' ')).toMatch(/Ignored an invalid date range/);
  });

  it('swaps a reversed range rather than returning an empty window', async () => {
    const p = await parse('start=2026-08-12&end=2026-08-01');
    expect(p.window).toEqual({ start: '2026-08-01', end: '2026-08-12' });
    expect(p.warnings.join(' ')).toMatch(/swapped/);
  });

  it('ignores a half-specified range', async () => {
    const p = await parse('end=2026-08-12');
    expect(p.warnings.join(' ')).toMatch(/Ignored an invalid date range/);
  });

  it('does not choke on markup or control characters in any param', async () => {
    const p = await parse('start=%3Cscript%3E&store=%27%3BDROP--&city=%00');
    expect(p.warnings.length).toBeGreaterThan(0);
    // Params are carried as opaque strings and only ever used as bound
    // parameters or in-memory filters — never interpolated into SQL.
    expect(p.store).toBe("';DROP--");
  });

  it('accepts a valid explicit range unchanged', async () => {
    const p = await parse('start=2026-07-30&end=2026-08-12');
    expect(p.window).toEqual({ start: '2026-07-30', end: '2026-08-12' });
    expect(p.warnings).toEqual([]);
  });
});
