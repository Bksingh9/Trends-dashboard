/**
 * §6.4 — the scheduled ETL entry point, plus the manual re-run button on
 * `/connectors` (§4.9).
 *
 * Protected by `CRON_SECRET` so a public URL cannot trigger a BigQuery scan.
 */
import { NextRequest, NextResponse } from 'next/server';
import { CONNECTORS, getConnector } from '@/lib/connectors/registry';
import { isCronAuthorised } from '@/lib/api/guards';
import { trailingWindow, type DateWindow } from '@/lib/format/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** §6.4 — refresh cadence per connector, in the window each run should cover. */
const WINDOW_DAYS: Record<string, number> = {
  'bq-orders': 2, // 60-min incremental covers today and yesterday (§15.7)
  'bq-ga4-events': 3, // re-run the previous two days to pick up finalised tables
  'slack-catalogue-report': 3,
  'sheets-store-master': 1,
  'bq-catalogue-master': 1,
  sentry: 7,
  jira: 1,
  'ga4-api': 2,
  'api-latency': 2,
  'gcp-logging': 2,
  'slack-alerts': 2,
  'test-ean-canary': 14,
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ connector: string }> }) {
  if (!isCronAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const { connector: id } = await ctx.params;
  const url = new URL(req.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  if (id === 'all') {
    const results = [];
    // Sequential: several connectors share the same GCP quota and the same
    // Slack rate-limit bucket (§14.3).
    for (const c of CONNECTORS) {
      const w = windowFor(c.id, start, end);
      const r = await c.run(w);
      results.push({ connector: c.id, ok: r.ok, rows: r.meta.rowCount, source: r.meta.source, warnings: r.meta.warnings });
    }
    return NextResponse.json({ ran: results.length, results });
  }

  const connector = getConnector(id);
  if (!connector) {
    return NextResponse.json(
      { error: `Unknown connector "${id}"`, known: CONNECTORS.map((c) => c.id) },
      { status: 404 },
    );
  }

  const result = await connector.run(windowFor(id, start, end));
  return NextResponse.json({
    connector: id,
    ok: result.ok,
    meta: result.meta,
    assertions: result.assertions ?? [],
    error: result.error ?? null,
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ connector: string }> }) {
  return POST(req, ctx);
}

function windowFor(id: string, start: string | null, end: string | null): DateWindow {
  if (start && end) return { start, end };
  return trailingWindow(WINDOW_DAYS[id] ?? 2);
}
