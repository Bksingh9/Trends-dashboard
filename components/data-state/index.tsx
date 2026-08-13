/**
 * §9.2 — Empty, loading, stale, down, and not-instrumented are five distinct
 * visual states. All five are designed here before any chart is built, because
 * retrofitting them is how a dashboard ends up rendering a pipeline outage as a
 * zero.
 */
import { cn } from '@/lib/cn';
import type { DataSourceState } from '@/lib/connectors/types';

export function LoadingSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('animate-pulse space-y-2', className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 rounded bg-[var(--color-edge)]" style={{ width: `${92 - i * 11}%` }} />
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

export function EmptyState({ message = 'No data in this window' }: { message?: string }) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-edge)] p-6 text-center">
      <span className="label">Empty</span>
      <p className="text-sm text-[var(--text-muted)]">{message}</p>
    </div>
  );
}

export function StaleWarning({ detail, age }: { detail: string; age?: string }) {
  return (
    <div className="flex items-start gap-2 rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2">
      <span aria-hidden className="mt-0.5 text-[var(--color-warn)]">
        ▲
      </span>
      <div className="text-xs">
        <span className="font-semibold text-[var(--color-warn)]">Stale</span>
        <span className="text-[var(--text-muted)]"> — {detail}</span>
        {age && <span className="num text-[var(--text-muted)]"> ({age})</span>}
      </div>
    </div>
  );
}

export function ConnectorDown({ connector, detail }: { connector: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 rounded border border-[var(--color-alert)]/50 bg-[var(--color-alert)]/10 px-3 py-2">
      <span aria-hidden className="mt-0.5 text-[var(--color-alert)]">
        ●
      </span>
      <div className="text-xs">
        <span className="font-semibold text-[var(--color-alert)]">Connector down — {connector}</span>
        <p className="text-[var(--text-muted)]">
          {detail ?? 'Serving the last good snapshot. This is a data problem, not a business result.'}
        </p>
        <a className="text-[var(--color-ion)] underline" href="/connectors">
          Open /connectors
        </a>
      </div>
    </div>
  );
}

/**
 * §16.9 — a missing event renders as a hatched "not instrumented" step, never as
 * a zero. The distinction is the difference between "nobody did this" and "we
 * never measured it", and it is the whole reason the funnel can be trusted.
 */
export function NotInstrumented({ what, reason }: { what: string; reason?: string }) {
  return (
    <div className="rounded border border-[var(--color-edge)] p-3">
      <div className="hatch mb-2 h-6 rounded opacity-60" aria-hidden />
      <div className="text-xs">
        <span className="font-semibold text-[var(--text-muted)]">Not instrumented — {what}</span>
        <p className="text-[var(--text-muted)]">
          {reason ?? 'This event is absent from the GTM container, so there is no number to show.'}
        </p>
      </div>
    </div>
  );
}

/** §14.5 / §9.2 — every fixture-backed card renders a visible marker. No exceptions. */
export function FixtureBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'fixture-stripe inline-flex items-center gap-1 rounded border border-[var(--color-warn)]/50 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-[var(--color-warn)]',
        className,
      )}
      title="Fixture data — this connector is not configured. Not a live number."
    >
      Fixture
    </span>
  );
}

const STATE_LABEL: Record<DataSourceState, string> = {
  live: 'Live',
  cache: 'Cached',
  fixture: 'Fixture',
  stale: 'Stale',
  missing: 'Missing',
  not_instrumented: 'Not instrumented',
};

const STATE_CLASS: Record<DataSourceState, string> = {
  live: 'text-[var(--color-scan)] border-[var(--color-scan)]/40',
  cache: 'text-[var(--text-muted)] border-[var(--color-edge)]',
  fixture: 'text-[var(--color-warn)] border-[var(--color-warn)]/50',
  stale: 'text-[var(--color-warn)] border-[var(--color-warn)]/50',
  missing: 'text-[var(--color-alert)] border-[var(--color-alert)]/50',
  not_instrumented: 'text-[var(--text-muted)] border-[var(--color-edge)]',
};

export function StatePill({ state, className }: { state: DataSourceState; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-2xs uppercase tracking-wider',
        STATE_CLASS[state],
        state === 'fixture' && 'fixture-stripe',
        className,
      )}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/** A caution marker for a card whose connector passed with warnings (§6.3). */
export function CautionMarker({ reason }: { reason: string }) {
  return (
    <span
      className="cursor-help text-[var(--color-warn)]"
      title={reason}
      aria-label={`Caution: ${reason}`}
    >
      ⚠
    </span>
  );
}

/**
 * An ambiguity the UI must label rather than resolve silently — A3's order
 * status enum being the live example. Better a labelled approximation than a
 * confident wrong number.
 */
export function AmbiguityMarker({ reason }: { reason: string }) {
  return (
    <span
      className="cursor-help rounded border border-[var(--color-warn)]/50 px-1 text-2xs text-[var(--color-warn)]"
      title={reason}
      aria-label={`Ambiguous: ${reason}`}
    >
      ?
    </span>
  );
}
