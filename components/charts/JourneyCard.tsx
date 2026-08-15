/**
 * §16.4 — one discovered journey.
 *
 * A declared funnel needs one chart. A discovered one needs a card per journey,
 * because the interesting part is not the shape of any single path but the fact
 * that there is more than one and they behave differently.
 *
 * Three things are drawn that the existing `FunnelChart` deliberately does not:
 * the shared prefix is greyed, so a fork is legible as a fork; sessions that
 * left are drawn apart from sessions that went elsewhere, because the first is
 * a hole and the second is a choice; and the step where people go instead is
 * named. A funnel that reports a drop and not its destination sends someone
 * looking for a bug in a step that is working.
 */
import { cn } from '@/lib/cn';
import { formatCount, formatINR, formatPct } from '@/lib/format/currency';
import type { DiscoveredJourney, JourneyShift } from '@/lib/metrics/journeys';

export function JourneyCard({
  journey,
  narrative,
  shift,
  narrativeIsDeterministic,
}: {
  journey: DiscoveredJourney;
  narrative?: string;
  shift?: JourneyShift;
  narrativeIsDeterministic?: boolean;
}) {
  const max = Math.max(1, ...journey.steps.map((s) => s.sessions));

  return (
    <article className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="display text-sm text-[var(--text-primary)]">{journey.label}</h3>
          <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
            {formatCount(journey.entrySessions)} sessions entered ·{' '}
            {formatPct(journey.conversion, { precision: 1 })} reached the end
            {journey.steps.length > 0 && ` · ${journey.steps.length} steps`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {shift?.isNew && (
            <span className="rounded border border-[var(--color-warn)]/50 px-1.5 py-0.5 text-2xs text-[var(--color-warn)]">
              new path
            </span>
          )}
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-2xs',
              journey.outcome === 'converts'
                ? 'border-[var(--color-scan)]/50 text-[var(--color-scan)]'
                : 'border-[var(--color-edge)] text-[var(--text-muted)]',
            )}
          >
            {journey.outcome === 'converts' ? 'ends in revenue' : 'no purchase'}
          </span>
        </div>
      </header>

      {narrative && (
        <p className="mb-3 rounded bg-[var(--color-ink)]/50 p-2.5 text-2xs leading-relaxed text-[var(--text-muted)]">
          {narrative}
          {/* Which sentences a model wrote is never guessed at — the deterministic
              one is assembled from the same numbers and says so. */}
          <span className="mt-1 block text-[var(--text-muted)]/60">
            {narrativeIsDeterministic ? 'Assembled from the figures above — no model call.' : 'Written by the model from the figures above.'}
          </span>
        </p>
      )}

      <ol className="space-y-1">
        {journey.steps.map((s, i) => {
          const width = Math.max(2, (s.sessions / max) * 100);
          const shared = i < journey.forkAt;
          return (
            <li key={`${s.event}-${i}`} className="grid grid-cols-[1fr_auto] items-center gap-3">
              <div className="relative h-8 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                <div
                  className={cn(
                    'absolute inset-y-0 left-0',
                    shared ? 'bg-[var(--text-muted)]/15' : 'bg-[var(--color-ion)]/35',
                  )}
                  style={{ width: `${width}%` }}
                />
                <div className="relative flex h-full items-center justify-between px-2">
                  <span
                    className={cn(
                      'truncate text-2xs',
                      shared ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]',
                    )}
                  >
                    {s.label}
                    {shared && <span className="ml-1.5 text-[var(--text-muted)]/70">shared</span>}
                  </span>
                  <span className="num shrink-0 pl-2 text-2xs text-[var(--text-primary)]">
                    {formatCount(s.sessions)}
                  </span>
                </div>
              </div>

              <div className="w-40 text-right text-2xs leading-tight">
                {s.retention != null && (
                  <div className={cn(s.retention < 0.5 ? 'text-[var(--color-alert)]' : 'text-[var(--text-muted)]')}>
                    {formatPct(s.retention, { precision: 1 })} carried through
                  </div>
                )}
                {/* Two separate numbers on purpose: "left the app" and "went
                    somewhere else" are different problems with different fixes. */}
                {s.exited > 0 && (
                  <div className="text-[var(--color-alert)]/80">{formatCount(s.exited)} left</div>
                )}
                {s.divertedTo.length > 0 && (
                  <div className="truncate text-[var(--text-muted)]/80">
                    {formatCount(s.divertedTo[0].sessions)} → {s.divertedTo[0].label}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--color-edge)] pt-2 text-2xs text-[var(--text-muted)]">
        {journey.worstStep && (
          <span>
            Worst step: <span className="text-[var(--text-primary)]">{journey.worstStep.label}</span> —{' '}
            {formatCount(journey.worstStep.exited)} left
          </span>
        )}
        {journey.revenueAtRisk != null && journey.revenueAtRisk > 0 && (
          <span>
            At this journey&rsquo;s own conversion rate:{' '}
            <span className="text-[var(--color-alert)]">{formatINR(journey.revenueAtRisk)}</span> not taken
          </span>
        )}
        {shift && !shift.isNew && shift.conversionDeltaPp != null && (
          <span>
            Conversion{' '}
            <span
              className={
                shift.conversionDeltaPp >= 0 ? 'text-[var(--color-scan)]' : 'text-[var(--color-alert)]'
              }
            >
              {/* `-0.0pp` is what an unrounded negative zero prints, and it
                  reads as a real decline. Rounded first, then signed. */}
              {shift.conversionDeltaPp >= -0.05 ? '+' : ''}
              {(Math.round(shift.conversionDeltaPp * 10) / 10 + 0).toFixed(1)}pp
            </span>{' '}
            vs comparison
          </span>
        )}
      </footer>
    </article>
  );
}
