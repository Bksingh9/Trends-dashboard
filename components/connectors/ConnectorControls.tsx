'use client';

/**
 * §4.9 — the live controls on the connector board.
 *
 * Two behaviours that make the page operational rather than a report:
 *
 *  1. **It refreshes itself.** A connector board that was true when the tab was
 *     opened is worse than no board — the NOC leaves it up on a wall display,
 *     and a stale green light is exactly the failure mode `/connectors` exists
 *     to prevent (`avis_base_view` reported itself healthy for two weeks).
 *  2. **It can act.** Seeing a red connector and having no way to retry it means
 *     filing a ticket to ask someone to redeploy.
 *
 * Polling rather than a socket: this is a dozen rows of JSON on an internal
 * dashboard, and a WebSocket buys nothing here but a reconnect state machine.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { refreshAllDue, refreshConnector, type RefreshOutcome } from '@/app/(dash)/connectors/actions';
import { cn } from '@/lib/cn';

const POLL_MS = 30_000;

/** The auto-refresh header: last checked, live countdown, pause. */
export function LiveRefresh({ generatedAt }: { generatedAt: string }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [age, setAge] = useState(0);
  const [pending, startTransition] = useTransition();
  // Held in a ref so the interval below never re-subscribes on every tick.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    setAge(0);
    const id = setInterval(() => {
      setAge((a) => {
        const next = a + 1;
        if (!pausedRef.current && next * 1000 >= POLL_MS) {
          // `router.refresh()` re-runs the server component with fresh data and
          // keeps scroll position — a full reload would throw a wall display
          // back to the top of the page every thirty seconds.
          startTransition(() => router.refresh());
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [router, generatedAt]);

  return (
    <div data-live-refresh className="flex items-center gap-2 text-2xs text-[var(--text-muted)]">
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          paused ? 'bg-[var(--color-edge)]' : 'bg-[var(--color-scan)]',
          !paused && !pending && 'animate-pulse',
        )}
        aria-hidden
      />
      <span className="num" data-refresh-age>
        {pending ? 'refreshing…' : `checked ${age}s ago`}
      </span>
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        aria-pressed={paused}
        className="rounded border border-[var(--color-edge)] px-1.5 py-0.5 hover:border-[var(--color-ion)]"
      >
        {paused ? 'resume' : 'pause'}
      </button>
      <button
        type="button"
        onClick={() => startTransition(() => router.refresh())}
        className="rounded border border-[var(--color-edge)] px-1.5 py-0.5 hover:border-[var(--color-ion)]"
      >
        refresh now
      </button>
    </div>
  );
}

/** Per-row re-run. Reports the outcome inline — a spinner that resolves to nothing is not feedback. */
export function RunButton({ id, configured, blockedBy }: { id: string; configured: boolean; blockedBy?: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [outcome, setOutcome] = useState<RefreshOutcome | null>(null);

  const run = useCallback(async () => {
    setState('running');
    setOutcome(null);
    try {
      const r = await refreshConnector(id);
      setOutcome(r);
      router.refresh();
    } finally {
      setState('idle');
    }
  }, [id, router]);

  if (!configured) {
    return (
      <span className="text-2xs text-[var(--text-muted)]" title={blockedBy ?? 'Not configured'}>
        blocked
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={run}
        disabled={state === 'running'}
        data-run-connector={id}
        className={cn(
          'rounded border px-1.5 py-0.5 text-2xs',
          state === 'running'
            ? 'border-[var(--color-edge)] text-[var(--text-muted)]'
            : 'border-[var(--color-edge)] text-[var(--color-ion)] hover:border-[var(--color-ion)]',
        )}
      >
        {state === 'running' ? 'running…' : 'run now'}
      </button>
      {outcome && (
        <span
          data-run-outcome
          className={cn(
            'max-w-[16rem] text-right text-2xs',
            outcome.ok ? 'text-[var(--color-scan)]' : 'text-[var(--color-alert)]',
          )}
        >
          {outcome.message}
        </span>
      )}
    </div>
  );
}

/** Runs everything past its SLA — the same decision the heartbeat makes. */
export function RunAllDueButton() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-run-all-due
        disabled={state === 'running'}
        onClick={async () => {
          setState('running');
          setMessage(null);
          try {
            const r = await refreshAllDue();
            setMessage(r.message);
            router.refresh();
          } finally {
            setState('idle');
          }
        }}
        className="rounded border border-[var(--color-edge)] px-2 py-1 text-2xs text-[var(--color-ion)] hover:border-[var(--color-ion)] disabled:text-[var(--text-muted)]"
      >
        {state === 'running' ? 'running…' : 'Run everything due'}
      </button>
      {message && <span className="text-2xs text-[var(--text-muted)]">{message}</span>}
    </div>
  );
}
