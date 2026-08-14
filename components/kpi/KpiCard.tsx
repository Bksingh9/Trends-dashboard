/**
 * §9.2 — Every KPI card takes `source`, `grain`, `fetchedAt`, `state`. The
 * component must not render without them, which is enforced by the type: they
 * are required fields on `MetricValue`, and `MetricValue` is the only accepted
 * prop shape.
 *
 * This is how "data honesty is not optional" (rule 2) is made structural rather
 * than a matter of remembering.
 *
 * On the visual treatment: the state badge and a single edge accent carry the
 * data state. An earlier version also striped the whole card surface, which made
 * every number sit on a busy background and read worse — and a KPI you have to
 * work to read is not a more honest KPI, just a noisier one. §10.4's restraint
 * rule applies to the honesty signals too: colour encodes state, and one signal
 * per state is enough.
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

/** One quiet edge accent per state, instead of a full-surface treatment. */
const STATE_ACCENT: Record<MetricValue['state'], string> = {
  live: 'before:bg-transparent',
  cache: 'before:bg-[var(--color-edge)]',
  fixture: 'before:bg-[var(--color-warn)]/55',
  stale: 'before:bg-[var(--color-warn)]',
  missing: 'before:bg-[var(--color-alert)]/70',
  not_instrumented: 'before:bg-[var(--color-edge)]',
};

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
      data-metric-id={metric.id}
      data-state={metric.state}
      className={cn(
        'group relative flex min-w-0 flex-col overflow-hidden rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4',
        // The state accent: a 2px bar down the leading edge. Present enough to
        // scan a grid for non-live cards, quiet enough to leave the number alone.
        'before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-[""]',
        STATE_ACCENT[metric.state],
        href && 'transition-colors hover:border-[var(--color-ion)]/60',
        className,
      )}
    >
      <div className="mb-2 flex min-h-8 items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="label leading-tight">{metric.label}</span>
          {metric.ambiguous && metric.caveat && <AmbiguityMarker reason={metric.caveat} />}
          {!metric.ambiguous && metric.caveat && <CautionMarker reason={metric.caveat} />}
        </div>
        {/* The badge is the primary state signal, so only non-live states show
            one — a grid of "LIVE" pills would be pure chrome. */}
        {metric.state !== 'live' && <StatePill state={metric.state} className="shrink-0" />}
      </div>

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={cn('num font-medium tracking-tight', valueSize)}
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

      {/* Mandatory lineage (rule 2, §6.3, §14.5) — every number carries its
          source, grain and last-refreshed time. Compact two lines rather than a
          three-row table: the provenance has to be present and checkable, not
          to outweigh the number it describes. */}
      <dl className="mt-auto flex flex-col gap-0.5 pt-3 text-2xs text-[var(--text-muted)]">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <dt data-provenance="source" className="sr-only">
            Source
          </dt>
          <dd className="min-w-0 truncate" title={metric.source}>
            {metric.source}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt data-provenance="grain" className="sr-only">
            Grain
          </dt>
          <dd className="num shrink-0">{metric.grain}</dd>
          <span aria-hidden className="text-[var(--color-edge)]">
            ·
          </span>
          <dt data-provenance="refreshed" className="sr-only">
            Refreshed
          </dt>
          <dd className="num truncate">{relativeAge(metric.fetchedAt)}</dd>
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
