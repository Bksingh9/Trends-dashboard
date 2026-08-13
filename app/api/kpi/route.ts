/** §9.3 — /api/kpi: the hub headline metrics. */
import { NextRequest } from 'next/server';
import { envelope, errorEnvelope, json, parseParams } from '@/lib/api/envelope';
import { salesModule } from '@/lib/services/modules';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = parseParams(new URL(req.url), 28);
  try {
    const mod = await salesModule(p.window);
    return json(envelope({ kpis: mod.kpis, daily: mod.data.daily }, { metrics: mod.kpis, window: p.window, warnings: [...p.warnings, ...mod.warnings] }));
  } catch (e) {
    return errorEnvelope(e, p.window);
  }
}
