/** §4.3 — Journey & Funnel. */
import Link from 'next/link';
import { journeyModule } from '@/lib/services/modules';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { DropoffRanking, FunnelChart } from '@/components/charts/FunnelChart';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { formatCount, formatPct } from '@/lib/format/currency';
import { trailingWindow } from '@/lib/format/dates';
import { getScanStrip } from '@/lib/data/repository';
import { ScanStrip } from '@/components/charts/ScanStrip';

export const dynamic = 'force-dynamic';

export default async function JourneyPage() {
  const [mod, strip] = await Promise.all([journeyModule(trailingWindow(28)), getScanStrip()]);
  const { steps, dropoff, byPlatform, instrumentationGaps } = mod.data;

  const platformCols: Column<(typeof byPlatform)[number]>[] = [
    { key: 'p', header: 'Platform', render: (r) => r.platform },
    { key: 's', header: 'Sessions', numeric: true, render: (r) => formatCount(r.sessions) },
    { key: 'pu', header: 'Purchases', numeric: true, render: (r) => formatCount(r.purchases) },
    { key: 'c', header: 'Conversion', numeric: true, render: (r) => formatPct(r.conversion, { precision: 2 }) },
  ];

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Journey"
        question="Where does the journey from open → scan → bag → pay → de-tag break down?"
        window={mod.window}
        sources={mod.sources}
        warnings={mod.warnings}
      />

      <ScanStrip data={strip.rows} state={strip.state} liveness={strip.state === 'fixture' ? 'fixture' : 'intraday'} compact />

      <KpiStrip metrics={mod.kpis} compareLabel="vs previous period" />

      {instrumentationGaps.length > 0 && (
        <section className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 p-4">
          <h2 className="label mb-1 text-[var(--color-warn)]">Instrumentation gaps</h2>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            These render as gaps, never as zeros. Each is a sprint ticket waiting to be written
            (§5.2, §16.9).
          </p>
          <ul className="space-y-2">
            {instrumentationGaps.map((g) => (
              <li key={g.step} className="text-xs">
                <code className="num rounded bg-[var(--color-ink)] px-1">{g.step}</code>{' '}
                <span className="text-[var(--text-muted)]">— {g.note}</span>
              </li>
            ))}
          </ul>
          <Link href="/journey/events" className="mt-3 inline-block text-2xs text-[var(--color-ion)] underline">
            Full event dictionary and instrumentation backlog →
          </Link>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <FunnelChart steps={steps} />
        <DropoffRanking steps={dropoff} />
      </div>

      <DataTable
        caption="Funnel by platform"
        columns={platformCols}
        rows={byPlatform}
        rowKey={(r) => r.platform}
        sourceNote={mod.sources[0]}
        maxHeight={240}
      />
    </div>
  );
}
