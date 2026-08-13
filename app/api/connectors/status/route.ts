/** §4.9 — connector status and lineage. */
import { envelope, json } from '@/lib/api/envelope';
import { connectorStatuses, lineage } from '@/lib/connectors/registry';
import { recentRuns } from '@/lib/connectors/run-log';
import { trailingWindow } from '@/lib/format/dates';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [statuses, runs] = await Promise.all([connectorStatuses(), recentRuns(40)]);
  return json(envelope({ connectors: statuses, runs, lineage: lineage() }, { window: trailingWindow(1) }));
}
