/**
 * §9.3 — /api/journeys.
 *
 * The discovered routes, ranked. Narration is deliberately not included: it
 * costs a model call per journey, and an API a dashboard polls should not spend
 * tokens on prose nobody asked for. Findings are, because those are arithmetic
 * and are what an alerting integration would want.
 */
import { NextRequest } from 'next/server';
import { envelope, errorEnvelope, json, parseParams } from '@/lib/api/envelope';
import { journeyDiscoveryModule } from '@/lib/services/modules';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = parseParams(new URL(req.url), 28);
  try {
    const mod = await journeyDiscoveryModule(p.window);
    return json(
      envelope(mod.data, {
        metrics: mod.kpis,
        window: p.window,
        warnings: [...p.warnings, ...mod.warnings],
      }),
    );
  } catch (e) {
    return errorEnvelope(e, p.window);
  }
}
