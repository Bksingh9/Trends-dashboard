/** §8 / §28 — the daily brief, anomalies and RCA hints, on demand. */
import { NextRequest } from 'next/server';
import { envelope, errorEnvelope, json } from '@/lib/api/envelope';
import { hubData } from '@/lib/services/hub';
import { deterministicBrief, generateDailyBrief, isAiConfigured } from '@/lib/ai/brief';
import { postDailyDigest } from '@/lib/alerts';
import { trailingWindow } from '@/lib/format/dates';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const w = trailingWindow(28);
  try {
    const hub = await hubData();
    const brief = isAiConfigured() ? await generateDailyBrief(hub.context) : deterministicBrief(hub.context);

    // §8.5 — post the brief plus any act-severity anomalies each morning.
    if (new URL(req.url).searchParams.get('post') === 'slack') {
      const actItems = hub.anomalies.filter((a) => a.severity === 'act' && !a.suppressed).map((a) => a.magnitude);
      await postDailyDigest(brief.body, actItems);
    }

    return json(
      envelope(
        { brief, anomalies: hub.anomalies, rca: hub.rca, context: hub.context },
        { window: w, warnings: brief.warnings },
      ),
    );
  } catch (e) {
    return errorEnvelope(e, w);
  }
}
