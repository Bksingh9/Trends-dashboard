/** §9.3 — /api/issues. */
import { NextRequest } from 'next/server';
import { envelope, errorEnvelope, json, parseParams } from '@/lib/api/envelope';
import { issuesModule } from '@/lib/services/modules';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = parseParams(new URL(req.url), 28);
  try {
    const mod = await issuesModule();
    return json(envelope(mod.data, { metrics: mod.kpis, window: p.window, warnings: [...p.warnings, ...mod.warnings] }));
  } catch (e) {
    return errorEnvelope(e, p.window);
  }
}
