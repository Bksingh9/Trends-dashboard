/**
 * §9.3 / §4.11 — GET /api/analytics/help-events
 *
 * The GA4 call happens here and only here. The service-account key is read from
 * the server environment and never reaches a response body, a prop, or an RSC
 * payload — which is the whole reason this endpoint exists rather than the
 * browser talking to `analyticsdata.googleapis.com` directly.
 *
 * A failure returns 200 with `state: "missing"` and a named remedy, not a 500.
 * The four ways this can fail — API not enabled, account not on the property,
 * wrong property id, no credential — have four different owners, and a status
 * code cannot tell them apart.
 */
import { NextRequest } from 'next/server';
import { fetchHelpEvents, Ga4Unavailable } from '@/lib/ga4/help-events';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** GA4 accepts `NdaysAgo`, `yesterday`, `today` or `YYYY-MM-DD`. Anything else is rejected. */
const DATE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const startDate = url.searchParams.get('startDate') ?? '28daysAgo';
  const endDate = url.searchParams.get('endDate') ?? 'yesterday';

  if (!DATE.test(startDate) || !DATE.test(endDate)) {
    return Response.json(
      {
        state: 'missing',
        error: 'Invalid date',
        remedy: 'Use YYYY-MM-DD, "today", "yesterday" or "NdaysAgo".',
        range: { startDate, endDate },
      },
      { status: 400 },
    );
  }

  try {
    const data = await fetchHelpEvents({ startDate, endDate });
    return Response.json(data, {
      // A wall display polls this. Sixty seconds is fresh enough for a support
      // metric and keeps a room full of screens off the API quota.
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (e) {
    if (e instanceof Ga4Unavailable) {
      return Response.json({
        state: 'missing',
        kind: e.kind,
        error: e.message,
        remedy: e.remedy,
        range: { startDate, endDate },
        summary: null,
        events: [],
        timeSeries: [],
      });
    }
    return Response.json({
      state: 'missing',
      kind: 'failed',
      error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      remedy: 'Unexpected failure — check the server logs.',
      range: { startDate, endDate },
      summary: null,
      events: [],
      timeSeries: [],
    });
  }
}
