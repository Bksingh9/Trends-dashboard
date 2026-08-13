/**
 * §9.3 — API conventions.
 *
 * Every response carries per-metric provenance, the window with its timezone,
 * and any warnings. A consumer can always tell whether a number is live, cached,
 * fixture, stale, or missing.
 */
import { NextResponse } from 'next/server';
import type { MetricValue } from '@/lib/metrics/compute';
import type { DateWindow } from '@/lib/format/dates';
import { trailingWindow } from '@/lib/format/dates';

export interface MetricMeta {
  source: string;
  grain: string;
  fetchedAt: string;
  state: 'live' | 'cache' | 'fixture' | 'stale' | 'missing' | 'not_instrumented';
}

export interface Envelope<T> {
  data: T;
  meta: {
    metrics: Record<string, MetricMeta>;
    window: { start: string; end: string; timezone: 'Asia/Kolkata' };
    warnings: string[];
  };
}

export function envelope<T>(
  data: T,
  opts: { metrics?: MetricValue[]; window: DateWindow; warnings?: string[] },
): Envelope<T> {
  return {
    data,
    meta: {
      metrics: Object.fromEntries(
        (opts.metrics ?? []).map((m) => [
          m.id,
          { source: m.source, grain: m.grain, fetchedAt: m.fetchedAt, state: m.state },
        ]),
      ),
      window: { start: opts.window.start, end: opts.window.end, timezone: 'Asia/Kolkata' },
      warnings: opts.warnings ?? [],
    },
  };
}

export function json<T>(body: Envelope<T>, init?: ResponseInit) {
  return NextResponse.json(body, init);
}

/** §9.3 — the standard query params, shared across every route. */
export interface StandardParams {
  window: DateWindow;
  /** Surfaced in the envelope so a silently-corrected range is still visible. */
  warnings: string[];
  store?: string;
  city?: string;
  state?: string;
  tenant: string;
  platform?: string;
  compare: 'prev_period' | 'same_period_last_month' | 'same_weekday_last_week';
}

/** YYYY-MM-DD, and a date that actually exists — `2026-02-31` is not one. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateKey(v: string | null): v is string {
  if (!v || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function parseParams(url: URL, defaultDays = 28): StandardParams {
  const rawStart = url.searchParams.get('start');
  const rawEnd = url.searchParams.get('end');
  const warnings: string[] = [];

  // Never 500 on a query string. A malformed date falls back to the default
  // window with a warning in the envelope, because a dashboard that crashes on
  // a bad bookmark is worse than one that says "I used the default window".
  let window = trailingWindow(defaultDays);
  if (rawStart || rawEnd) {
    if (isValidDateKey(rawStart) && isValidDateKey(rawEnd)) {
      window = rawStart <= rawEnd ? { start: rawStart, end: rawEnd } : { start: rawEnd, end: rawStart };
      if (rawStart > rawEnd) warnings.push('start was after end — the range was swapped');
    } else {
      warnings.push(
        `Ignored invalid date range (start=${rawStart ?? '—'}, end=${rawEnd ?? '—'}); using the trailing ${defaultDays} days`,
      );
    }
  }

  return {
    window,
    warnings,
    store: url.searchParams.get('store') ?? undefined,
    city: url.searchParams.get('city') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    tenant: url.searchParams.get('tenant') ?? 'trends',
    platform: url.searchParams.get('platform') ?? undefined,
    compare: (url.searchParams.get('compare') as StandardParams['compare']) ?? 'prev_period',
  };
}

/** A route never throws to the client — it reports the failure as data. */
export function errorEnvelope(e: unknown, window: DateWindow) {
  return NextResponse.json(
    {
      data: null,
      meta: {
        metrics: {},
        window: { ...window, timezone: 'Asia/Kolkata' as const },
        warnings: [`Request failed: ${e instanceof Error ? e.message : String(e)}`],
      },
    },
    { status: 500 },
  );
}
