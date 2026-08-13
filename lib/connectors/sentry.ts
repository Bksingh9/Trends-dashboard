/**
 * §21 — Connector 7: `sentry`. P1.
 *
 * Powers crash-free rate, error volume, and release health on `/app-health`.
 *
 * Crash-free *session* rate is the headline (the metric leadership understands);
 * crash-free user rate is the one that panics people unnecessarily and lives in
 * the drilldown. Deploy markers from /releases/ overlay onto the error-volume
 * and GCP-log charts — correlating an error spike with a deploy is 80% of
 * incident triage, and it is free.
 */
import { config } from '@/lib/config';
import { freshness, range, rowVolume } from '@/lib/assertions';
import type { DateWindow } from '@/lib/format/dates';
import { fixtureAppHealth, type AppHealthRow } from '@/fixtures/business';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

const BASE = () => `https://${config.sentryOrg}.sentry.io/api/0`;

export interface SentryRelease {
  version: string;
  dateCreated: string;
  projects: string[];
}

interface SentrySessionsResponse {
  intervals: string[];
  groups: Array<{
    by: Record<string, string>;
    series: Record<string, number[]>;
    totals: Record<string, number>;
  }>;
}

export class SentryConnector extends BaseConnector<AppHealthRow, AppHealthRow> {
  readonly id = 'sentry';
  readonly displayName = 'Sentry — crash-free & release health';
  readonly freshnessSlaMinutes = 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P1' as const;
  readonly powers = ['crash_free_rate', 'release_adoption', '/app-health', 'App Health Score'];
  readonly blockedBy = '§13.6 Sentry auth token';

  isConfigured(): boolean {
    return Boolean(config.sentryAuthToken) && Boolean(config.sentryOrg);
  }

  private headers() {
    return { Authorization: `Bearer ${config.sentryAuthToken}` };
  }

  /** Enumerate once and store — used to scope the sessions and issues calls. */
  async listProjects(): Promise<Array<{ id: string; slug: string; platform: string | null }>> {
    const res = await fetch(`${BASE()}/organizations/${config.sentryOrg}/projects/`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Sentry ${res.status}: ${await res.text()}`);
    return (await res.json()) as Array<{ id: string; slug: string; platform: string | null }>;
  }

  /** Deploy markers for the release-regression RCA rule (§28.5). */
  async listReleases(): Promise<SentryRelease[]> {
    if (!this.isConfigured()) return [];
    const res = await fetch(`${BASE()}/organizations/${config.sentryOrg}/releases/`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as Array<{ version: string; dateCreated: string; projects?: Array<{ slug: string }> }>;
    return body.map((r) => ({
      version: r.version,
      dateCreated: r.dateCreated,
      projects: (r.projects ?? []).map((p) => p.slug),
    }));
  }

  protected async extract(w: DateWindow): Promise<AppHealthRow[]> {
    // §21.2 — the sessions endpoint, not issue counts. Aggregate endpoints over
    // per-issue loops: rate limits here are org-wide (§14.3).
    const url = new URL(`${BASE()}/organizations/${config.sentryOrg}/sessions/`);
    url.searchParams.append('field', 'crash_free_rate(session)');
    url.searchParams.append('field', 'sum(session)');
    url.searchParams.set('interval', '1d');
    url.searchParams.set('start', `${w.start}T00:00:00`);
    url.searchParams.set('end', `${w.end}T23:59:59`);
    for (const p of config.sentryProjects.split(',').filter(Boolean)) {
      url.searchParams.append('project', p.trim());
    }

    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Sentry ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as SentrySessionsResponse;

    return body.intervals.map((iso, i) => {
      const sessions = body.groups.reduce((a, g) => a + (g.series['sum(session)']?.[i] ?? 0), 0);
      const crashFreeSeries = body.groups
        .map((g) => g.series['crash_free_rate(session)']?.[i])
        .filter((v): v is number => typeof v === 'number');
      const crashFree = crashFreeSeries.length
        ? crashFreeSeries.reduce((a, b) => a + b, 0) / crashFreeSeries.length
        : 1;
      return {
        dateKey: iso.slice(0, 10),
        sessions,
        crashedSessions: Math.round(sessions * (1 - crashFree)),
        crashFreeRate: crashFree,
        sentryErrorCount: 0,
        apiCallCount: 0,
        apiErrorCount: 0,
        apiErrorRate: 0,
        paymentAttempts: 0,
        paymentSuccesses: 0,
        paymentSuccessRate: 0,
        gcpErrorLogCount: 0,
      };
    });
  }

  protected transform(rows: AppHealthRow[]): AppHealthRow[] {
    return rows;
  }

  protected async load(rows: AppHealthRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factAppHealthDaily } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_app_health_daily' };
    await db
      .insert(factAppHealthDaily)
      .values(
        rows.map((r) => ({
          dateKey: r.dateKey,
          sessions: r.sessions,
          crashedSessions: r.crashedSessions,
          crashFreeRate: String(r.crashFreeRate),
        })),
      )
      .onConflictDoUpdate({
        target: factAppHealthDaily.dateKey,
        set: {
          sessions: sql`excluded.sessions`,
          crashedSessions: sql`excluded.crashed_sessions`,
          crashFreeRate: sql`excluded.crash_free_rate`,
        },
      });
    return { rowsIngested: rows.length, table: 'fact_app_health_daily' };
  }

  protected fixture(w: DateWindow): AppHealthRow[] {
    return fixtureAppHealth(w);
  }

  readonly assertions: Assertion<AppHealthRow>[] = [
    freshness<AppHealthRow>({ column: 'dateKey', maxLagHours: 26, level: 'warn' }),
    rowVolume<AppHealthRow>({ tolerance: 0.7, zeroIsFail: true }),
    range<AppHealthRow>({ column: 'crashFreeRate', min: 0, max: 1, level: 'fail' }),
  ];
}

export const sentry = new SentryConnector();
