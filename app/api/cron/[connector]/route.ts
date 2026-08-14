/**
 * §6.4 — running one named connector, or everything, on demand.
 *
 * The *scheduled* entry point is `/api/cron/tick`, which decides what is due
 * from each connector's freshness SLA. This route is the explicit override: a
 * runbook step, a backfill over a named window, or a one-off retry from a
 * terminal. It forces the run rather than checking due-ness, because someone
 * calling it by name has already decided.
 *
 * Protected by `CRON_SECRET` so a public URL cannot run up a BigQuery bill.
 */
import { NextRequest, NextResponse } from 'next/server';
import { CONNECTORS, getConnector } from '@/lib/connectors/registry';
import { isCronAuthorised } from '@/lib/api/guards';
import { tick, windowFor } from '@/lib/connectors/scheduler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ connector: string }> }) {
  if (!isCronAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const { connector: id } = await ctx.params;
  const url = new URL(req.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  if (id === 'all') {
    // Force, not due-ness: `all` is the explicit "run the lot" a runbook asks
    // for. `tick` without `force` is what the heartbeat calls.
    const result = await tick({ force: true, window: start && end ? { start, end } : undefined });
    return NextResponse.json({ ranCount: result.ran.length, ...result });
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
