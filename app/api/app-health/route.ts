/** §9.3 — /api/app-health. */
import { NextRequest } from 'next/server';
import { envelope, errorEnvelope, json, parseParams } from '@/lib/api/envelope';
import { appHealthModule } from '@/lib/services/modules';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = parseParams(new URL(req.url), 28);
  try {
    const mod = await appHealthModule(p.window);
    return json(envelope({ daily: mod.data.daily, latency: mod.data.latency, score: mod.data.score }, { metrics: mod.kpis, window: p.window, warnings: [...p.warnings, ...mod.warnings] }));
  } catch (e) {
    return errorEnvelope(e, p.window);
  }
}
