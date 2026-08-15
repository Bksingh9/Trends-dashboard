/**
 * §16.4 — Journeys, discovered.
 *
 * `/journey` measures the eleven steps somebody wrote down. This page starts
 * from what sessions actually did and reports the routes it finds, ranked by
 * how many people leave. Nothing on it is chosen by hand: not the steps, not
 * the order, not which journey leads.
 *
 * The two pages are kept apart rather than merged. Where they disagree — a
 * route carrying real traffic that the declared funnel cannot see — the
 * disagreement is the finding, and merging them would hide it.
 */
import Link from 'next/link';
import { journeyDiscoveryModule } from '@/lib/services/modules';
import { narrateJourneys } from '@/lib/ai/journey-narrative';
import { isAiConfigured } from '@/lib/ai/brief';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { JourneyCard } from '@/components/charts/JourneyCard';
import { ModuleHeader } from '@/components/table/DataTable';
import { FilterBar } from '@/components/filters/FilterBar';
import { getFilterOptions } from '@/lib/services/filter-options';
import { formatCount, formatINR, formatPct } from '@/lib/format/currency';
import { parseFilters, type RawParams } from '@/lib/params/filters';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export default async function DiscoveredJourneysPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const filters = parseFilters(await searchParams, 28);
  const [mod, options] = await Promise.all([journeyDiscoveryModule(filters), getFilterOptions()]);
  const { journeys, shifts, findings, tailSessions, totalSessions, eventsSeen } = mod.data;

  // Narration happens after the ranking, never before it — the model is given
  // journeys that are already ordered and cannot reorder them.
  const narratives = await narrateJourneys(journeys, findings, shifts);
  const narrativeBy = new Map(narratives.map((n) => [n.journeyId, n]));
  const shiftBy = new Map(shifts.map((s) => [s.id, s]));

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Journeys, discovered"
        question="What routes do people actually take, and where do they leave?"
        window={mod.window}
        compareLabel={mod.compareLabel}
        sources={mod.sources}
        warnings={mod.warnings}
      >
        <p className="mt-3 max-w-3xl text-xs text-[var(--text-muted)]">
          These are found by reading whole session paths out of the GA4 export and walking them as a
          tree — no step list, no target funnel. A route becomes its own journey when it carries at
          least a quarter of the traffic its heaviest sibling does. Ranked by how many sessions leave
          the app outright, which is not the same as how many stop following a given sequence.{' '}
          <Link href="/journey" className="text-[var(--color-ion)] underline">
            The declared funnel
          </Link>{' '}
          is still on /journey, and where the two disagree the disagreement is worth reading.
        </p>
      </ModuleHeader>

      <FilterBar
        window={mod.window}
        stores={options.stores}
        cities={options.cities}
        states={options.states}
        showPlatform
      />

      <KpiStrip metrics={mod.kpis} compareLabel={mod.compareLabel} />

      {journeys.length === 0 ? (
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-6">
          <h2 className="label mb-1">No journeys to show</h2>
          <p className="max-w-2xl text-xs text-[var(--text-muted)]">
            `fact_journey_path` is empty for this window. That is a connector that has not run, not a
            finding about user behaviour — the difference matters, so nothing is drawn.{' '}
            <Link href="/connectors" className="text-[var(--color-ion)] underline">
              Check bq-ga4-journeys
            </Link>
            .
          </p>
        </section>
      ) : (
        <>
          {findings.length > 0 && (
            <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
              <h2 className="label mb-1">What the numbers say</h2>
              <p className="mb-3 text-2xs text-[var(--text-muted)]">
                Produced by arithmetic before any model was called, and unchanged if none is
                configured. {isAiConfigured() ? 'The model wrote the prose on the cards below.' : 'No model is configured, so every sentence below is assembled from these same figures.'}
              </p>
              <ul className="space-y-2">
                {findings.map((f, i) => (
                  <li key={`${f.journeyId}-${i}`} className="flex gap-2.5 text-xs">
                    <span
                      className={cn(
                        'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-2xs',
                        f.severity === 'high'
                          ? 'bg-[var(--color-alert)]/15 text-[var(--color-alert)]'
                          : f.severity === 'medium'
                            ? 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]'
                            : 'bg-[var(--color-edge)] text-[var(--text-muted)]',
                      )}
                    >
                      {f.severity}
                    </span>
                    <span>
                      <span className="text-[var(--text-primary)]">{f.headline}</span>{' '}
                      <span className="text-[var(--text-muted)]">— {f.detail}</span>
                      {f.revenueAtRisk != null && f.revenueAtRisk > 0 && (
                        <span className="text-[var(--color-alert)]"> {formatINR(f.revenueAtRisk)} at stake.</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            {journeys.map((j) => {
              const n = narrativeBy.get(j.id);
              return (
                <JourneyCard
                  key={j.id}
                  journey={j}
                  narrative={n?.body}
                  narrativeIsDeterministic={n?.deterministic}
                  shift={shiftBy.get(j.id)}
                />
              );
            })}
          </div>
        </>
      )}

      {/* The tail is stated rather than quietly excluded: it is real traffic on
          paths too rare to store individually, and a coverage figure with no
          denominator is a coverage figure nobody can check. */}
      <p className="text-2xs text-[var(--text-muted)]">
        {formatCount(totalSessions)} sessions in this window across {eventsSeen} distinct events.{' '}
        {tailSessions > 0
          ? `${formatCount(tailSessions)} of them (${formatPct(tailSessions / Math.max(1, totalSessions), { precision: 1 })}) took paths rare enough to be stored as a single "(other)" bucket rather than individually — real traffic, not missing data.`
          : 'Every session in this window took a path common enough to be stored individually.'}
      </p>
    </div>
  );
}
