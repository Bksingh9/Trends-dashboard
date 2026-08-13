/** §10.3 — the Scan Strip feed. 5-minute refresh cadence (§6.4). */
import { envelope, json } from '@/lib/api/envelope';
import { getScanStrip } from '@/lib/data/repository';
import { trailingWindow } from '@/lib/format/dates';

export const dynamic = 'force-dynamic';

export async function GET() {
  const strip = await getScanStrip();
  return json(
    envelope({ minutes: strip.rows, state: strip.state, source: strip.source }, { window: trailingWindow(1), warnings: strip.warnings }),
  );
}
