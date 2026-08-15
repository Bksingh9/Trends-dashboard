'use client';

/**
 * §4.10 — adding a tile.
 *
 * The picker offers §5 metrics and declared series, and nothing else. It is not
 * a query builder on purpose: a board where somebody can point a tile at an
 * arbitrary column is a board where a tile eventually shows a number whose
 * definition nobody can look up. Every option here has a formula, a source and
 * a caveat in the registry, and the tile inherits all three.
 *
 * Which widget kinds an option supports is decided by the option, not by the
 * person. A leaderboard of a daily time series ranks dates — nonsense that
 * renders perfectly well, which is the worst kind.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { addWidgetAction, removeWidgetAction, type BoardOutcome } from '@/app/(dash)/board/actions';
import type { WidgetKind, WidgetSize } from '@/lib/widgets/types';

const FIELD =
  'w-full rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--color-ion)] focus:outline-none';

export interface PickerOption {
  id: string;
  kind: 'metric' | 'series';
  label: string;
  description: string;
  domain: string;
  kinds: WidgetKind[];
  /** Shown so nobody adds a tile whose caveat they have not read. */
  caveat?: string;
}

export function AddWidgetButton({ options, disabled }: { options: PickerOption[]; disabled?: string }) {
  const [open, setOpen] = useState(false);
  if (disabled) {
    return <span className="text-2xs text-[var(--color-warn)]">{disabled}</span>;
  }
  return (
    <>
      <button
        type="button"
        data-add-widget
        onClick={() => setOpen(true)}
        className="rounded border border-[var(--color-ion)] px-2.5 py-1 text-xs text-[var(--color-ion)] hover:bg-[var(--color-ion)]/10"
      >
        + Add a tile
      </button>
      {open && <Picker options={options} onClose={() => setOpen(false)} />}
    </>
  );
}

function Picker({ options, onClose }: { options: PickerOption[]; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<PickerOption | null>(null);
  const [kind, setKind] = useState<WidgetKind>('number');
  const [size, setSize] = useState<WidgetSize>('sm');
  const [target, setTarget] = useState('');
  const [outcome, setOutcome] = useState<BoardOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      // Underscores in ids are matched as spaces, so typing "unique coverage"
      // finds `unique_coverage`. Somebody searching for a metric types its
      // name, not its identifier.
      const haystack = `${o.label} ${o.description} ${o.id} ${o.domain}`
        .toLowerCase()
        .replace(/[_.]/g, ' ');
      return haystack.includes(q.replace(/[_.]/g, ' '));
    });
  }, [options, query]);

  const byDomain = matches.reduce<Record<string, PickerOption[]>>((acc, o) => {
    (acc[o.domain] ??= []).push(o);
    return acc;
  }, {});

  const choose = (o: PickerOption) => {
    setChosen(o);
    setKind(o.kinds[0]);
    setOutcome(null);
  };

  const save = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const r = await addWidgetAction({
        kind,
        metricId: chosen.kind === 'metric' ? chosen.id : undefined,
        seriesId: chosen.kind === 'series' ? chosen.id : undefined,
        size,
        target: target.trim() === '' ? null : Number(target),
      });
      setOutcome(r);
      if (r.ok) {
        startTransition(() => router.refresh());
        setTimeout(onClose, 800);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={chosen ? `Configure ${chosen.label}` : 'Choose what to show'}
    >
      <div className="w-full max-w-2xl rounded border border-[var(--color-edge)] bg-[var(--surface)] p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="display text-lg">{chosen ? chosen.label : 'Add a tile'}</h2>
            <p className="mt-0.5 max-w-lg text-2xs text-[var(--text-muted)]">
              {chosen
                ? chosen.description
                : 'Every option is a §5 metric or a declared series, so the tile carries its formula, source and freshness with it.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-[var(--color-edge)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:border-[var(--color-alert)]"
          >
            ✕
          </button>
        </div>

        {!chosen ? (
          <div className="space-y-4">
            <input
              autoFocus
              data-widget-search
              className={FIELD}
              placeholder="Search — try “revenue”, “coverage”, “dark stores”, “latency”…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {Object.keys(byDomain).length === 0 && (
              <p className="py-6 text-center text-xs text-[var(--text-muted)]">
                Nothing matches “{query}”.
              </p>
            )}
            {Object.entries(byDomain).map(([domain, list]) => (
              <div key={domain}>
                <div className="label mb-1.5">{domain}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {list.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      data-widget-option={o.id}
                      onClick={() => choose(o)}
                      className="rounded border border-[var(--color-edge)] p-2.5 text-left hover:border-[var(--color-ion)]"
                    >
                      <div className="text-xs text-[var(--text-primary)]">{o.label}</div>
                      <div className="mt-0.5 text-2xs text-[var(--text-muted)]">{o.description}</div>
                      {o.caveat && (
                        <div className="mt-1 text-2xs text-[var(--color-warn)]">⚠ has a caveat</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {chosen.caveat && (
              // Read before the tile goes on a wall, not discovered from it.
              <div className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 p-2.5 text-2xs text-[var(--text-muted)]">
                <span className="text-[var(--color-warn)]">Caveat: </span>
                {chosen.caveat}
              </div>
            )}

            <label className="block">
              <span className="label">Shown as</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {chosen.kinds.map((k) => (
                  <button
                    key={k}
                    type="button"
                    data-widget-kind-option={k}
                    onClick={() => setKind(k)}
                    className={cn(
                      'rounded border px-2 py-1 text-xs capitalize',
                      k === kind
                        ? 'border-[var(--color-ion)] text-[var(--color-ion)]'
                        : 'border-[var(--color-edge)] text-[var(--text-muted)]',
                    )}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </label>

            <label className="block">
              <span className="label">Size</span>
              <div className="mt-1 flex gap-1.5">
                {(['sm', 'md', 'lg'] as WidgetSize[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSize(s)}
                    className={cn(
                      'rounded border px-2 py-1 text-xs',
                      s === size
                        ? 'border-[var(--color-ion)] text-[var(--color-ion)]'
                        : 'border-[var(--color-edge)] text-[var(--text-muted)]',
                    )}
                  >
                    {s === 'sm' ? 'Small' : s === 'md' ? 'Medium' : 'Wide'}
                  </button>
                ))}
              </div>
            </label>

            {(kind === 'goal' || kind === 'gauge' || kind === 'status') && (
              <label className="block">
                <span className="label">Target</span>
                <input
                  className={cn(FIELD, 'mt-1')}
                  placeholder="Leave blank to use the threshold from Settings"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
                <span className="mt-0.5 block text-2xs text-[var(--text-muted)]">
                  A ratio goes in as a decimal — 0.97, not 97. Blank means the tile follows Settings,
                  so changing the threshold there moves this too.
                </span>
              </label>
            )}

            {outcome && (
              <div
                className={cn(
                  'rounded border p-2.5 text-2xs',
                  outcome.ok
                    ? 'border-[var(--color-scan)]/50 text-[var(--color-scan)]'
                    : 'border-[var(--color-alert)]/50 text-[var(--color-alert)]',
                )}
              >
                {outcome.message}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setChosen(null)}
                className="rounded border border-[var(--color-edge)] px-2 py-1 text-xs text-[var(--text-muted)]"
              >
                Back
              </button>
              <div className="flex-1" />
              <button
                type="button"
                data-save-widget
                disabled={busy}
                onClick={save}
                className="rounded border border-[var(--color-ion)] bg-[var(--color-ion)]/10 px-2.5 py-1 text-xs text-[var(--color-ion)] disabled:opacity-50"
              >
                {busy ? 'Adding…' : 'Add to board'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function RemoveWidgetButton({ widgetId }: { widgetId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <button
      type="button"
      data-remove-widget={widgetId}
      aria-label="Remove this tile"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await removeWidgetAction(widgetId);
          startTransition(() => router.refresh());
        } finally {
          setBusy(false);
        }
      }}
      className="rounded border border-[var(--color-edge)] px-1.5 text-2xs text-[var(--text-muted)] hover:border-[var(--color-alert)] hover:text-[var(--color-alert)] disabled:opacity-50"
    >
      ✕
    </button>
  );
}
