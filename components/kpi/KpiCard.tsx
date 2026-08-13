/**
 * §9.2 — Every KPI card takes `source`, `grain`, `fetchedAt`, `state`. The
 * component must not render without them, which is enforced by the type: they
 * are required fields on `MetricValue`, and `MetricValue` is the only accepted
 * prop shape.
 *
 * This is how "data honesty is not optional" (rule 2) is made structural rather
 * than a matter of remembering.
 */
import { cn } from '@/lib/cn';
import { formatByUnit, formatPct, formatPp } from '@/lib/format/currency';
import { relativeAge } from '@/lib/format/dates';
import type { MetricValue } from '@/lib/metrics/compute';
import { AmbiguityMarker, CautionMarker, NotInstrumented, StatePill } from '@/components/data-state';

export interface KpiCardProps {
  metric: MetricValue;
  /** Optional comparison label, e.g. "vs same weekday last week". */
  compareLabel?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  href?: string;
}

function deltaTone(delta: number | null, direction: MetricValue['direction']): string {
  if (delta == null || delta === 0 || direction === 'neutral') return 'text-[var(--text-muted)]';
  const good = direction === 'up_good' ? delta > 0 : delta < 0;
  return good ? 'text-[var(--color-scan)]' : 'text-[var(--color-alert)]';
}

export function KpiCard({ metric, compareLabel, size = 'md', className, href }: KpiCardProps) {
  if (metric.state === 'not_instrumented') {
    return (
      <div className={cn('rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4', className)}>
        <div className="label mb-2">{metric.label}</div>
        <NotInstrumented what={metric.label} reason={metric.notInstrumentedReason} />
      </div>
    );
  }

  const valueSize = size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-lg' : 'text-xl';
  // For a rate, the honest unit for a change is percentage points, not a
  // percentage of a percentage.
  const isRate = metric.unit === 'ratio';
  const delta = (isRate ? metric.deltaPp : metric.deltaVsPrev) ?? null;
  const deltaText = delta == null ? null : isRate ? formatPp(delta) : formatPct(delta, { sign: true });

  const Wrapper = href ? 'a' : 'div';

  return (
    <Wrapper
      {...(href ? { href } : {})}
      className={cn(
        'group flex min-w-0 flex-col justify-between rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4',
        href && 'transition-colors hover:border-[var(--color-ion)]/60',
        metric.state === 'fixture' && 'fixture-stripe',
        className,
      )}
    >
      {/* min-height keeps values aligned across a row when a label wraps to two
          lines — a ragged KPI strip is harder to scan at a glance. */}
      <div className="mb-3 flex min-h-8 items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="label">{metric.label}</span>
          {metric.ambiguous && metric.caveat && <AmbiguityMarker reason={metric.caveat} />}
          {!metric.ambiguous && metric.caveat && <CautionMarker reason={metric.caveat} />}
        </div>
        <StatePill state={metric.state} />
      </div>

      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <span
          className={cn('num font-medium', valueSize)}
          title={`${metric.formula}${metric.value == null ? ' — no value available' : ''}`}
        >
          {formatByUnit(metric.value, metric.unit)}
        </span>
        {deltaText && (
          <span className={cn('num text-sm', deltaTone(delta, metric.direction))}>{deltaText}</span>
        )}
      </div>

      {compareLabel && delta != null && (
        <div className="mt-0.5 text-2xs text-[var(--text-muted)]">{compareLabel}</div>
      )}

      {/* Mandatory lineage. Every number carries its source, grain, and
          last-refreshed time (rule 2, §6.3, §14.5). */}
      <dl className="mt-3 space-y-0.5 border-t border-[var(--color-edge)] pt-2 text-2xs text-[var(--text-muted)]">
        <div className="flex justify-between gap-2">
          <dt className="shrink-0">Source</dt>
          {/* min-w-0 is what lets `truncate` actually truncate: without it the
              flex item refuses to shrink below its content width and drags the
              whole card past the viewport on a phone. */}
          <dd className="min-w-0 truncate text-right" title={metric.source}>
            {metric.source}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Grain</dt>
          <dd className="num">{metric.grain}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Refreshed</dt>
          <dd className="num">{relativeAge(metric.fetchedAt)}</dd>
        </div>
      </dl>
    </Wrapper>
  );
}

/** The header strip: a row of KPI cards, all sharing one window. */
export function KpiStrip({
  metrics,
  compareLabel,
  className,
}: {
  metrics: MetricValue[];
  compareLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5',
        className,
      )}
    >
      {metrics.map((m) => (
        <KpiCard key={m.id} metric={m} compareLabel={compareLabel} />
      ))}
    </div>
  );
}
