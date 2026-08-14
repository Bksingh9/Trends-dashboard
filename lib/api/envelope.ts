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
import { isValidDateKey, parseFiltersFromUrl, type ParsedFilters } from '@/lib/params/filters';

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

/**
 * §9.3 — the standard query params.
 *
 * The parser lives in `lib/params/filters` because the pages need it too, and
 * an API that validates `compare` while a page does not is how a shared link
 * stops showing what the sender was looking at.
 */
export type StandardParams = ParsedFilters;

export { isValidDateKey };

export function parseParams(url: URL, defaultDays = 28): StandardParams {
  return parseFiltersFromUrl(url, defaultDays);
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
