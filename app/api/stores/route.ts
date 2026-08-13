/** §9.3 — /api/stores. Supports store-, city- and state-level filtering. */
import { NextRequest } from 'next/server';
import { envelope, errorEnvelope, json, parseParams } from '@/lib/api/envelope';
import { storesModule } from '@/lib/services/modules';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = parseParams(new URL(req.url), 28);
  try {
    const mod = await storesModule(p.window);
    let rows = mod.data.rows;
    if (p.store) rows = rows.filter((r) => r.storeId === p.store || r.storeCode === p.store);
    if (p.city) rows = rows.filter((r) => r.city.toLowerCase() === p.city!.toLowerCase());
    if (p.state) rows = rows.filter((r) => r.state.toLowerCase() === p.state!.toLowerCase());
    return json(
      envelope(
        { rows, states: mod.data.states, darkWorklist: mod.data.darkWorklist, cohort: mod.data.cohort },
        { metrics: mod.kpis, window: p.window, warnings: [...p.warnings, ...mod.warnings] },
      ),
    );
  } catch (e) {
    return errorEnvelope(e, p.window);
  }
}
