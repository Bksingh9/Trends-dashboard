/** §9.3 — /api/funnel. Uninstrumented steps carry is_instrumented=false, never zero. */
import { NextRequest } from 'next/server';
import { envelope, errorEnvelope, json, parseParams } from '@/lib/api/envelope';
import { journeyModule } from '@/lib/services/modules';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = parseParams(new URL(req.url), 28);
  try {
    const mod = await journeyModule(p.window);
    return json(envelope(mod.data, { metrics: mod.kpis, window: p.window, warnings: [...p.warnings, ...mod.warnings] }));
  } catch (e) {
    return errorEnvelope(e, p.window);
  }
}
