'use client';

/**
 * One configured source.
 *
 * Shows the masked credential, when it was last tested and what that test said.
 * A source whose last test failed stays visible and stays enabled — the blocker
 * is usually on the other side (a sheet not yet shared, a bot not yet invited),
 * and hiding or disabling it would lose the credential someone already pasted.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { StoredSource } from '@/lib/credentials/store';
import type { SourceType } from '@/lib/credentials/source-types';
import { deleteSourceAction, toggleSourceAction } from '@/app/(dash)/connectors/sources/actions';
import { relativeAge } from '@/lib/format/dates';
import { cn } from '@/lib/cn';

export function SourceCard({
  source,
  type,
  overridesEnv = false,
}: {
  source: StoredSource;
  type?: SourceType;
  /**
   * Computed on the server. `process.env` cannot be indexed by a variable in a
   * client bundle — Next inlines only literal `NEXT_PUBLIC_*` lookups, so doing
   * it here threw at render and took the whole page to a 500.
   */
  overridesEnv?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [, startTransition] = useTransition();

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const tested = source.lastTestedAt;
  const dot = !source.enabled
    ? 'bg-[var(--color-edge)]'
    : source.lastTestOk === true
      ? 'bg-[var(--color-scan)]'
      : source.lastTestOk === false
        ? 'bg-[var(--color-alert)]'
        : 'bg-[var(--color-warn)]';

  return (
    <div
      data-source-card={source.type}
      className={cn(
        'rounded border border-[var(--color-edge)] bg-[var(--surface)] p-3',
        !source.enabled && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', dot)} />
            <span className="truncate text-xs text-[var(--text-primary)]">{source.name}</span>
            {!source.enabled && <span className="text-2xs text-[var(--text-muted)]">disabled</span>}
          </div>
          <div className="mt-0.5 text-2xs text-[var(--text-muted)]">{type?.label ?? source.type}</div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => toggleSourceAction(source.sourceId, !source.enabled))}
            className="rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-2xs hover:border-[var(--color-ion)] disabled:opacity-50"
          >
            {source.enabled ? 'disable' : 'enable'}
          </button>
          {confirming ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => deleteSourceAction(source.sourceId))}
              className="rounded border border-[var(--color-alert)] px-1.5 py-0.5 text-2xs text-[var(--color-alert)]"
            >
              really delete?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-2xs text-[var(--text-muted)] hover:border-[var(--color-alert)]"
            >
              delete
            </button>
          )}
        </div>
      </div>

      {/* Masked only — the plaintext is never sent to a browser. */}
      {Object.entries(source.secretPreview).length > 0 && (
        <dl className="mt-2 space-y-0.5">
          {Object.entries(source.secretPreview).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 text-2xs">
              <dt className="text-[var(--text-muted)]">{type?.fields.find((f) => f.key === k)?.label ?? k}</dt>
              <dd className="num truncate text-[var(--text-primary)]">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {Object.entries(source.config).filter(([, v]) => v).length > 0 && (
        <dl className="mt-1.5 space-y-0.5 border-t border-[var(--color-edge)] pt-1.5">
          {Object.entries(source.config)
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 text-2xs">
                <dt className="text-[var(--text-muted)]">{type?.fields.find((f) => f.key === k)?.label ?? k}</dt>
                <dd className="num truncate text-[var(--text-primary)]">{v}</dd>
              </div>
            ))}
        </dl>
      )}

      <div className="mt-2 border-t border-[var(--color-edge)] pt-1.5 text-2xs">
        {tested ? (
          <span className={source.lastTestOk ? 'text-[var(--color-scan)]' : 'text-[var(--color-alert)]'}>
            {source.lastTestOk ? '✓' : '✕'} {source.lastTestDetail ?? ''}{' '}
            <span className="text-[var(--text-muted)]">· tested {relativeAge(tested)}</span>
          </span>
        ) : (
          <span className="text-[var(--text-muted)]">Never tested.</span>
        )}
      </div>

      {/* Two credentials for the same thing is a situation someone must be able
          to see, not discover during an incident. */}
      {overridesEnv && (
        <p className="mt-1.5 text-2xs text-[var(--color-warn)]">
          Overriding an environment variable that is also set.
        </p>
      )}
    </div>
  );
}
