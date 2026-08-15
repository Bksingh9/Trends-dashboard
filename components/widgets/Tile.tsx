/**
 * §4.10 — the tiles.
 *
 * Sized for a wall, which changes the rules. Nobody standing six feet from a
 * screen reads a footnote or hovers a tooltip, so everything a number needs in
 * order to be read correctly has to be on the tile at that size: the state
 * badge, the source, and — for anything with a target — what it is measured
 * against. A board is the easiest surface in the product on which to publish a
 * confident wrong number, and the treatment here is the only thing preventing
 * it.
 *
 * No arithmetic in this file. Every value arrives resolved from `lib/widgets`,
 * which took it from a §5 module.
 */
import { cn } from '@/lib/cn';
import { formatByUnit, formatPct, formatPp } from '@/lib/format/currency';
import { relativeAge } from '@/lib/format/dates';
import { StatePill } from '@/components/data-state';
import { WIDGET_SPAN, type ResolvedWidget } from '@/lib/widgets/types';
import type { MetricValue } from '@/lib/metrics/compute';

const SPAN_CLASS: Record<number, string> = {
  3: 'col-span-12 sm:col-span-6 xl:col-span-3',
  4: 'col-span-12 sm:col-span-6 xl:col-span-4',
  6: 'col-span-12 xl:col-span-6',
};

function deltaTone(delta: number | null | undefined, direction: MetricValue['direction']): string {
  if (delta == null || delta === 0 || direction === 'neutral') return 'text-[var(--text-muted)]';
  const good = direction === 'up_good' ? delta > 0 : delta < 0;
  return good ? 'text-[var(--color-scan)]' : 'text-[var(--color-alert)]';
}

export function Tile({ widget, onRemove }: { widget: ResolvedWidget; onRemove?: React.ReactNode }) {
  const span = WIDGET_SPAN[widget.spec.size];
  const state = widget.metric?.state ?? widget.series?.state;

  return (
    <section
      data-widget={widget.spec.id}
      data-widget-kind={widget.spec.kind}
      className={cn(
        SPAN_CLASS[span],
        'relative flex min-h-[9.5rem] flex-col rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4',
      )}
    >
      <header className="mb-2 flex items-start justify-between gap-2">
        <h3 className="label truncate">{widget.title}</h3>
        <div className="flex shrink-0 items-center gap-1.5">
          {state && <StatePill state={state} />}
          {onRemove}
        </div>
      </header>

      {widget.unavailable ? (
        // Never a zero. From across a room a zero and a missing number look
        // identical, and only one of them is news.
        <p className="flex-1 text-xs text-[var(--color-warn)]">{widget.unavailable}</p>
      ) : (
        <Body widget={widget} />
      )}

      {/* A caveat about the shape sits above the source line, not below it:
          it changes how the picture is read, and the source does not. */}
      {widget.series?.note && (
        <p className="mt-2 text-2xs text-[var(--color-warn)]">{widget.series.note}</p>
      )}

      <footer className="mt-2 truncate text-2xs text-[var(--text-muted)]">
        {widget.metric
          ? `${widget.metric.source} · ${relativeAge(widget.metric.fetchedAt)}`
          : widget.series?.source}
      </footer>
    </section>
  );
}

function Body({ widget }: { widget: ResolvedWidget }) {
  switch (widget.spec.kind) {
    case 'number':
      return <NumberBody widget={widget} />;
    case 'goal':
      return <GoalBody widget={widget} />;
    case 'gauge':
      return <GaugeBody widget={widget} />;
    case 'status':
      return <StatusBody widget={widget} />;
    case 'leaderboard':
      return <LeaderboardBody widget={widget} />;
    case 'trend':
      return <TrendBody widget={widget} />;
    case 'text':
      return <p className="flex-1 whitespace-pre-wrap text-sm text-[var(--text-primary)]">{widget.title}</p>;
    default:
      return null;
  }
}

function NumberBody({ widget }: { widget: ResolvedWidget }) {
  const m = widget.metric!;
  const delta = m.deltaVsPrev ?? null;
  return (
    <div className="flex flex-1 flex-col justify-center">
      <div className="num text-4xl leading-none text-[var(--text-primary)]">
        {formatByUnit(m.value, m.unit)}
      </div>
      {(delta != null || m.deltaPp != null) && (
        <div className={cn('mt-1.5 text-xs', deltaTone(m.deltaPp ?? delta, m.direction))}>
          {m.deltaPp != null ? formatPp(m.deltaPp) : formatPct(delta, { sign: true })}
          <span className="ml-1 text-[var(--text-muted)]">vs previous</span>
        </div>
      )}
    </div>
  );
}

/**
 * Progress toward a target — and, when no target exists, a plain number with a
 * sentence saying so rather than a bar against something invented.
 */
function GoalBody({ widget }: { widget: ResolvedWidget }) {
  const m = widget.metric!;
  const target = widget.spec.target ?? null;
  if (target == null || m.value == null) {
    return (
      <div className="flex flex-1 flex-col justify-center">
        <div className="num text-4xl leading-none text-[var(--text-primary)]">
          {formatByUnit(m.value, m.unit)}
        </div>
        <p className="mt-1.5 text-2xs text-[var(--color-warn)]">
          No target is set for this metric, so no progress is drawn.
        </p>
      </div>
    );
  }

  const pct = target === 0 ? 0 : Math.max(0, Math.min(1.2, m.value / target));
  const met = m.direction === 'down_good' ? m.value <= target : m.value >= target;
  return (
    <div className="flex flex-1 flex-col justify-center">
      <div className="num text-3xl leading-none text-[var(--text-primary)]">
        {formatByUnit(m.value, m.unit)}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-ink)]">
        <div
          className={cn('h-full', met ? 'bg-[var(--color-scan)]' : 'bg-[var(--color-warn)]')}
          style={{ width: `${Math.min(100, pct * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 text-2xs text-[var(--text-muted)]">
        target {formatByUnit(target, m.unit)} · {formatPct(pct, { precision: 0 })} of it
      </div>
    </div>
  );
}

/** A dial for a rate. Only rates: a gauge needs a ceiling that means something. */
function GaugeBody({ widget }: { widget: ResolvedWidget }) {
  const m = widget.metric!;
  const target = widget.spec.target ?? null;
  const value = m.value ?? 0;
  const ceiling = m.unit === 'ratio' ? 1 : Math.max(value, target ?? value) || 1;
  const frac = Math.max(0, Math.min(1, value / ceiling));
  // Half-circle: 180° of a 40-radius arc is ~125.6 units of stroke.
  const arc = 125.6;

  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <svg viewBox="0 0 100 56" className="w-full max-w-[11rem]" role="img" aria-label={`${widget.title} gauge`}>
        <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="var(--color-ink)" strokeWidth="8" strokeLinecap="round" />
        <path
          d="M10 50 A40 40 0 0 1 90 50"
          fill="none"
          stroke={target != null && value < target ? 'var(--color-warn)' : 'var(--color-ion)'}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${frac * arc} ${arc}`}
        />
      </svg>
      <div className="num -mt-3 text-2xl text-[var(--text-primary)]">{formatByUnit(m.value, m.unit)}</div>
      {target != null && (
        <div className="text-2xs text-[var(--text-muted)]">target {formatByUnit(target, m.unit)}</div>
      )}
    </div>
  );
}

/** Red / amber / green and the number. Nothing else — that is the point. */
function StatusBody({ widget }: { widget: ResolvedWidget }) {
  const m = widget.metric!;
  const target = widget.spec.target ?? null;
  const value = m.value;

  const tone =
    value == null || target == null
      ? 'unknown'
      : (m.direction === 'down_good' ? value <= target : value >= target)
        ? 'ok'
        : 'bad';

  const colour =
    tone === 'ok' ? 'var(--color-scan)' : tone === 'bad' ? 'var(--color-alert)' : 'var(--text-muted)';

  return (
    <div className="flex flex-1 items-center gap-4">
      <span className="h-10 w-10 shrink-0 rounded-full" style={{ backgroundColor: colour }} aria-hidden />
      <div className="min-w-0">
        <div className="num text-3xl leading-none text-[var(--text-primary)]">
          {formatByUnit(value, m.unit)}
        </div>
        <div className="mt-1 truncate text-2xs text-[var(--text-muted)]">
          {/* An unknown light is stated as unknown. A grey dot alone reads as
              "fine" to anyone glancing at it. */}
          {target == null
            ? 'No threshold set — this light cannot turn green or red.'
            : `${tone === 'ok' ? 'within' : 'outside'} target ${formatByUnit(target, m.unit)}`}
        </div>
      </div>
    </div>
  );
}

function LeaderboardBody({ widget }: { widget: ResolvedWidget }) {
  const s = widget.series!;
  if (s.points.length === 0) {
    return <p className="flex-1 text-xs text-[var(--text-muted)]">Nothing in this list right now.</p>;
  }
  const max = Math.max(...s.points.map((p) => Math.abs(p.value)), 1);

  return (
    <ol className="flex-1 space-y-1">
      {s.points.slice(0, 8).map((p, i) => (
        <li key={p.key} className="relative grid grid-cols-[1.25rem_1fr_auto] items-center gap-2 text-xs">
          <span className="num text-2xs text-[var(--text-muted)]">{i + 1}</span>
          <span className="relative min-w-0">
            <span
              className="absolute inset-y-0 left-0 rounded-sm bg-[var(--color-ion)]/15"
              style={{ width: `${(Math.abs(p.value) / max) * 100}%` }}
              aria-hidden
            />
            <span className="relative block truncate text-[var(--text-primary)]">{p.label}</span>
            {p.sub && <span className="relative block truncate text-2xs text-[var(--text-muted)]">{p.sub}</span>}
          </span>
          <span className="num shrink-0 text-[var(--text-primary)]">{formatByUnit(p.value, s.unit)}</span>
        </li>
      ))}
    </ol>
  );
}

function TrendBody({ widget }: { widget: ResolvedWidget }) {
  const s = widget.series!;
  if (s.points.length < 2) {
    return <p className="flex-1 text-xs text-[var(--text-muted)]">Not enough days to draw a line.</p>;
  }

  const values = s.points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 300;
  const h = 80;
  const d = s.points
    .map((p, i) => {
      const x = (i / (s.points.length - 1)) * w;
      const y = h - ((p.value - min) / span) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  const last = s.points[s.points.length - 1];
  return (
    <div className="flex flex-1 flex-col justify-between">
      <div className="num text-2xl leading-none text-[var(--text-primary)]">
        {formatByUnit(last.value, s.unit)}
        <span className="ml-2 text-2xs text-[var(--text-muted)]">latest · {last.label}</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="mt-2 h-16 w-full"
        role="img"
        aria-label={`${widget.title} over ${s.points.length} days`}
      >
        <path d={d} fill="none" stroke="var(--color-ion)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* The axis a sparkline usually hides. Without it the shape is legible
          and the scale is not, which is how a 2% wobble reads as a collapse. */}
      <div className="mt-1 flex justify-between text-2xs text-[var(--text-muted)]">
        <span>{formatByUnit(min, s.unit)}</span>
        <span>{formatByUnit(max, s.unit)}</span>
      </div>
    </div>
  );
}
