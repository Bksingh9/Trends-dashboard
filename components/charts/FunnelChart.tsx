'use client';

/**
 * §4.3 — The funnel, in the app's own journey order.
 *
 * Absolute counts plus step-to-step conversion. An uninstrumented step renders
 * hatched and labelled, never as zero (§16.9) — that distinction is the reason
 * the funnel can be trusted at all.
 */
import { cn } from '@/lib/cn';
import { formatCount, formatPct } from '@/lib/format/currency';

export interface FunnelStepPoint {
  step: string;
  label: string;
  count: number | null;
  /** Conversion from the previous step. Null at the head, or when uninstrumented. */
  conversion: number | null;
  isInstrumented: boolean;
}

export function FunnelChart({
  steps,
  className,
}: {
  steps: FunnelStepPoint[];
  className?: string;
}) {
  const max = Math.max(1, ...steps.map((s) => s.count ?? 0));

  return (
    <figure className={cn('rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4', className)}>
      <figcaption className="mb-4">
        <span className="label">Journey funnel</span>
        <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
          open Companion → scan → add to bag → pay → invoice / de-tag
        </p>
      </figcaption>

      <ol className="space-y-1.5">
        {steps.map((s, i) => {
          const width = s.count == null ? 100 : Math.max(2, (s.count / max) * 100);
          const worstDrop = s.conversion != null && s.conversion < 0.5;
          return (
            <li key={s.step} className="grid grid-cols-[1fr_auto] items-center gap-3">
              <div className="relative h-9 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                <div
                  className={cn(
                    'absolute inset-y-0 left-0 transition-[width]',
                    s.isInstrumented ? 'bg-[var(--color-ion)]/35' : 'hatch opacity-50',
                  )}
                  style={{ width: `${width}%` }}
                />
                <div className="relative flex h-full items-center justify-between px-3">
                  <span className="text-xs">
                    <span className="text-[var(--text-muted)]">{i + 1}.</span> {s.label}
                    {!s.isInstrumented && (
                      <span
                        className="ml-2 rounded border border-[var(--color-edge)] px-1 text-2xs text-[var(--text-muted)]"
                        title="This event is absent from the GTM container. There is no number to show — it is not zero."
                      >
                        not instrumented
                      </span>
                    )}
                  </span>
                  <span className="num text-sm">
                    {s.isInstrumented ? formatCount(s.count) : '—'}
                  </span>
                </div>
              </div>
              <div className="w-20 text-right">
                {s.conversion != null ? (
                  <span
                    className={cn(
                      'num text-xs',
                      worstDrop ? 'text-[var(--color-warn)]' : 'text-[var(--text-muted)]',
                    )}
                    title={`Conversion from the previous step`}
                  >
                    {formatPct(s.conversion)}
                  </span>
                ) : (
                  <span className="text-2xs text-[var(--text-muted)]">{i === 0 ? 'entry' : '—'}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-2xs text-[var(--text-muted)]">
        Source: fact_funnel_daily (bq-ga4-events) · counts are events; conversion is step n+1 ÷ step n
      </p>
    </figure>
  );
}

/**
 * §4.3 — step-to-step drop-off, ranked worst first. This is the chart that
 * drives sprint priorities.
 */
export function DropoffRanking({
  steps,
  className,
}: {
  steps: Array<{ from: string; to: string; dropoff: number | null; instrumented: boolean }>;
  className?: string;
}) {
  const ranked = steps
    .filter((s) => s.instrumented && s.dropoff != null)
    .sort((a, b) => (b.dropoff ?? 0) - (a.dropoff ?? 0));

  return (
    <figure className={cn('rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4', className)}>
      <figcaption className="mb-3">
        <span className="label">Drop-off, worst first</span>
        <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
          Where the journey leaks most. Sprint priorities come from this ordering.
        </p>
      </figcaption>
      <ul className="space-y-2">
        {ranked.map((s) => (
          <li key={`${s.from}-${s.to}`} className="grid grid-cols-[1fr_3rem] items-center gap-3">
            <div>
              <div className="mb-1 text-xs">
                {s.from} <span className="text-[var(--text-muted)]">→</span> {s.to}
              </div>
              <div className="h-1.5 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                <div
                  className="h-full bg-[var(--color-alert)]/70"
                  style={{ width: `${(s.dropoff ?? 0) * 100}%` }}
                />
              </div>
            </div>
            <span className="num text-right text-xs">{formatPct(s.dropoff)}</span>
          </li>
        ))}
        {ranked.length === 0 && (
          <li className="text-xs text-[var(--text-muted)]">
            No instrumented step pairs to rank.
          </li>
        )}
      </ul>
    </figure>
  );
}
