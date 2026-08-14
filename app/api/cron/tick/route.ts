/**
 * §6.4 — the heartbeat.
 *
 * One scheduled entry point. It does not decide what to run; `lib/connectors/
 * scheduler` does, from each connector's declared freshness SLA. That is
 * deliberate: a cron expression per connector drifts away from the SLA shown on
 * `/connectors` until the two disagree and nobody can say which is the truth.
 *
 * Fire it as often as the hosting plan allows. Running it more often than
 * anything is due is cheap — the tick reads the run log, finds nothing due, and
 * returns. Running it less often means the shortest SLA silently becomes the
 * heartbeat interval, which the response reports so it is visible rather than
 * inferred.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorised } from '@/lib/api/guards';
import { CONNECTORS } from '@/lib/connectors/registry';
import { tick } from '@/lib/connectors/scheduler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!isCronAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const url = new URL(req.url);
  const only = url.searchParams.get('only')?.split(',').filter(Boolean);
  const force = url.searchParams.get('force') === '1';

  const result = await tick({ only, force });

  // The shortest SLA in the registry is the cadence this endpoint must be
  // called at to be meaningful. Reported rather than assumed, so a schedule
  // that has fallen behind the SLAs is visible in the response itself.
  const shortestSlaMinutes = Math.min(...CONNECTORS.map((c) => c.freshnessSlaMinutes));

  return NextResponse.json({
    ...result,
    shortestSlaMinutes,
    note: `Call this at least every ${shortestSlaMinutes} minutes, or the tightest freshness SLA cannot be met.`,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
