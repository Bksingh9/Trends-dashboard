'use client';

/**
 * §9.3 / §4.2 — the filter bar.
 *
 * The URL is the state, not a mirror of it. Every control writes a query param
 * and nothing else; the page re-renders from the server with the new filters.
 * That is what makes a link shareable: there is no client state that could be
 * true on one screen and not on the recipient's.
 *
 * `router.replace` rather than `push` for everything except an explicit reset,
 * because a NOC engineer adjusting a date range four times should not have to
 * press Back four times to leave the page.
 */
import { useMemo, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { COMPARE_LABELS, COMPARE_MODES, PLATFORMS, type CompareMode } from '@/lib/params/filters';
import { cn } from '@/lib/cn';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterBarProps {
  /** The window the server actually used, after validation. */
  window: { start: string; end: string };
  stores?: FilterOption[];
  cities?: string[];
  states?: string[];
  /** Hidden where the underlying fact table has no platform column. */
  showPlatform?: boolean;
  /** Hidden on pages with no period-over-period comparison. */
  showCompare?: boolean;
  /** Quick ranges, in days. */
  presets?: number[];
}

const FIELD =
  'h-7 min-w-0 rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-ion)] focus:outline-none';

export function FilterBar({
  window,
  stores = [],
  cities = [],
  states = [],
  showPlatform = false,
  showCompare = true,
  presets = [7, 28, 90],
}: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const current = useMemo(
    () => ({
      start: params.get('start') ?? window.start,
      end: params.get('end') ?? window.end,
      store: params.get('store') ?? '',
      city: params.get('city') ?? '',
      state: params.get('state') ?? '',
      platform: params.get('platform') ?? '',
      compare: (params.get('compare') as CompareMode) ?? 'prev_period',
    }),
    [params, window.start, window.end],
  );

  const write = (changes: Record<string, string | null>, mode: 'replace' | 'push' = 'replace') => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    // Sorted so two equivalent filter sets produce identical URLs. Without this
    // the same view can be reached by URLs that differ only in param order,
    // which breaks caching and makes "is this the same link?" unanswerable.
    next.sort();
    const qs = next.toString();
    startTransition(() => {
      router[mode](qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  };

  const applyPreset = (days: number) => {
    // The window ends yesterday, matching `trailingWindow` — today is partial,
    // and a half day compared against full ones is not a comparison.
    const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    write({ start, end });
  };

  const isFiltered =
    Boolean(current.store || current.city || current.state || current.platform) ||
    current.compare !== 'prev_period' ||
    params.has('start');

  return (
    <div
      data-filter-bar
      aria-busy={pending}
      className={cn(
        'mb-4 flex flex-wrap items-center gap-2 rounded border border-[var(--color-edge)] bg-[var(--surface)] px-3 py-2',
        pending && 'opacity-60',
      )}
    >
      <span className="label shrink-0">Filters</span>

      <label className="flex items-center gap-1 text-2xs text-[var(--text-muted)]">
        <span className="sr-only sm:not-sr-only">From</span>
        <input
          type="date"
          name="start"
          aria-label="Window start date"
          className={cn(FIELD, 'num')}
          value={current.start}
          max={current.end}
          onChange={(e) => write({ start: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-1 text-2xs text-[var(--text-muted)]">
        <span className="sr-only sm:not-sr-only">to</span>
        <input
          type="date"
          name="end"
          aria-label="Window end date"
          className={cn(FIELD, 'num')}
          value={current.end}
          min={current.start}
          onChange={(e) => write({ end: e.target.value })}
        />
      </label>

      <div className="flex items-center gap-1">
        {presets.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => applyPreset(d)}
            className="h-7 rounded border border-[var(--color-edge)] px-2 text-2xs text-[var(--text-muted)] hover:border-[var(--color-ion)] hover:text-[var(--text-primary)]"
          >
            {d}d
          </button>
        ))}
      </div>

      {stores.length > 0 && (
        <select
          aria-label="Store"
          className={FIELD}
          value={current.store}
          onChange={(e) => write({ store: e.target.value })}
        >
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      )}

      {cities.length > 0 && (
        <select
          aria-label="City"
          className={FIELD}
          value={current.city}
          onChange={(e) => write({ city: e.target.value })}
        >
          <option value="">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}

      {states.length > 0 && (
        <select
          aria-label="State"
          className={FIELD}
          value={current.state}
          onChange={(e) => write({ state: e.target.value })}
        >
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}

      {showPlatform && (
        <select
          aria-label="Platform"
          className={FIELD}
          value={current.platform}
          onChange={(e) => write({ platform: e.target.value })}
        >
          <option value="">Both platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {p === 'ios' ? 'iOS' : 'Android'}
            </option>
          ))}
        </select>
      )}

      {showCompare && (
        <select
          aria-label="Comparison period"
          className={FIELD}
          value={current.compare}
          onChange={(e) => write({ compare: e.target.value })}
        >
          {COMPARE_MODES.map((m) => (
            <option key={m} value={m}>
              {COMPARE_LABELS[m]}
            </option>
          ))}
        </select>
      )}

      {isFiltered && (
        // `push`, not `replace` — clearing filters is a destination someone may
        // want to come back from.
        <button
          type="button"
          onClick={() =>
            write(
              { start: null, end: null, store: null, city: null, state: null, platform: null, compare: null },
              'push',
            )
          }
          className="h-7 rounded border border-[var(--color-edge)] px-2 text-2xs text-[var(--color-warn)] hover:border-[var(--color-warn)]"
        >
          Clear
        </button>
      )}
    </div>
  );
}
