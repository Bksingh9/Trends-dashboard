/** §9.3 — /api/catalogue. */
import { NextRequest } from 'next/server';
import { envelope, errorEnvelope, json, parseParams } from '@/lib/api/envelope';
import { catalogueModule } from '@/lib/services/modules';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = parseParams(new URL(req.url), 14);
  try {
    const mod = await catalogueModule(p.window);
    return json(
      envelope(
        { daily: mod.data.daily, reasons: mod.data.reasons, ageBuckets: mod.data.ageBuckets, storeCoverage: mod.data.storeCoverage },
        { metrics: mod.kpis, window: p.window, warnings: mod.warnings },
      ),
    );
  } catch (e) {
    return errorEnvelope(e, p.window);
  }
}
