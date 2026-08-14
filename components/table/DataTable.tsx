/**
 * A shared table so the vocabulary stays consistent across modules (§29.4) and
 * density is calibrated for a returning daily user rather than a first-time
 * visitor.
 */
import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  /** Mono + tabular for every numeral in the product (§10.2). */
  numeric?: boolean;
  width?: string;
  render: (row: T) => React.ReactNode;
  title?: string;
}

/**
 * How a capped table declares what it is hiding.
 *
 * Passing a pre-sliced array to `rows` is the bug this exists to prevent: the
 * header then says "200 rows" while the underlying set has 272, and a reader
 * who sums the revenue column gets a number that ties to nothing on the page.
 * Hand `DataTable` the *whole* set plus this, and it does the slicing itself so
 * N, M, the sort key and the residual are all derived from the same array.
 */
export interface Truncation<T> {
  /** N — how many rows to render. */
  limit: number;
  /** The sort key in the reader's words: "e-GMV", "coverage, ascending". */
  sortKey: string;
  /** Plural noun for a row: "stores", "EANs". */
  noun: string;
  /**
   * What the hidden rows are worth, rendered next to the count. Without this a
   * reader knows rows are missing but not whether they matter.
   */
  residual?: (hidden: T[]) => string | null;
}

export function DataTable<T>({
  columns,
  rows,
  caption,
  sourceNote,
  emptyMessage = 'No rows',
  maxHeight = 480,
  rowKey,
  className,
  truncation,
}: {
  columns: Column<T>[];
  rows: T[];
  caption?: string;
  sourceNote?: string;
  emptyMessage?: string;
  maxHeight?: number;
  rowKey: (row: T, i: number) => string;
  className?: string;
  truncation?: Truncation<T>;
}) {
  const total = rows.length;
  const visible = truncation ? rows.slice(0, truncation.limit) : rows;
  const hidden = truncation ? rows.slice(truncation.limit) : [];
  const residual = truncation?.residual && hidden.length > 0 ? truncation.residual(hidden) : null;

  return (
    // min-w-0 is load-bearing: this is usually a grid or flex item, and those
    // default to `min-width: auto`, so the item sizes to the table's intrinsic
    // width and drags the page past the viewport. The child's `overflow-auto`
    // cannot rescue it, because by then the parent is already too wide.
    <div
      // The rendered and underlying counts are published on the element so the
      // truncation contract is checkable from outside — a header that claims
      // "top 200 of 272" while rendering 272 rows is the failure this catches.
      data-rows-shown={visible.length}
      data-rows-total={total}
      className={cn('min-w-0 rounded border border-[var(--color-edge)] bg-[var(--surface)]', className)}
    >
      {caption && (
        <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-edge)] px-3 py-2">
          <span className="label">{caption}</span>
          <span className="num text-2xs text-[var(--text-muted)]">
            {hidden.length > 0
              ? `Top ${visible.length} of ${total} by ${truncation!.sortKey}`
              : `${total} rows`}
          </span>
        </div>
      )}
      {/* tabIndex makes the scroll container reachable by keyboard. Without it
          a keyboard user can tab to the links inside the table but cannot
          scroll it — and these tables are the NOC's primary working surface. */}
      <div
        className="overflow-auto"
        style={{ maxHeight }}
        tabIndex={0}
        role="region"
        aria-label={caption ? `${caption}, scrollable` : 'Scrollable table'}
      >
        <table className="data-table w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-edge)]">
              {columns.map((c) => (
                <th
                  key={c.key}
                  title={c.title}
                  style={{ width: c.width }}
                  className={cn(
                    'label px-3 py-2 font-normal',
                    c.align === 'right' || c.numeric ? 'text-right' : 'text-left',
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-[var(--text-muted)]">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              visible.map((row, i) => (
                <tr
                  key={rowKey(row, i)}
                  className="border-b border-[var(--color-edge)]/50 last:border-0 hover:bg-[var(--color-ink)]/40"
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-3 py-1.5',
                        c.numeric && 'num',
                        c.align === 'right' || c.numeric ? 'text-right' : 'text-left',
                      )}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {hidden.length > 0 && (
        // Sits directly under the last visible row, where someone who has just
        // scrolled to the bottom and started adding up a column will hit it.
        <div
          data-truncation-residual
          className="border-t border-[var(--color-edge)] bg-[var(--color-ink)]/40 px-3 py-1.5 text-2xs text-[var(--text-muted)]"
        >
          <span className="num">+{hidden.length.toLocaleString('en-IN')}</span> {truncation!.noun} not
          shown
          {residual && (
            <>
              {' · '}
              <span className="num">{residual}</span>
            </>
          )}
        </div>
      )}
      {sourceNote && (
        <div className="border-t border-[var(--color-edge)] px-3 py-1.5 text-2xs text-[var(--text-muted)]">
          Source: {sourceNote}
        </div>
      )}
    </div>
  );
}

/** Module page header: title, subtitle, and the window/source line. */
export function ModuleHeader({
  title,
  question,
  window,
  sources,
  warnings = [],
  scope,
  compareLabel,
  children,
}: {
  title: string;
  question: string;
  window?: { start: string; end: string };
  sources: string[];
  warnings?: string[];
  /** What the §9.3 filters narrowed this page to, if anything. */
  scope?: string | null;
  compareLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-xl">{title}</h1>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{question}</p>
          {/* A filtered page that looks unfiltered is the fastest way to have
              someone quote a store's revenue as the national figure. */}
          {scope && (
            <p data-scope className="mt-1 text-2xs text-[var(--color-ion)]">
              Filtered to {scope}
            </p>
          )}
        </div>
        {/* max-w-md (448px) exceeds a 412px phone viewport, so it is capped to
            the container below sm and only widens once there is room. */}
        <div className="min-w-0 max-w-full text-2xs text-[var(--text-muted)] sm:text-right">
          {window && (
            <div className="num">
              {window.start} → {window.end} IST
            </div>
          )}
          {compareLabel && <div data-compare-label>{compareLabel}</div>}
          <div className="max-w-full truncate sm:max-w-md" title={sources.join(' · ')}>
            {sources.join(' · ')}
          </div>
        </div>
      </div>
      {warnings.length > 0 && (
        // Deduped: several sources commonly report the same warning (e.g. two
        // unconfigured connectors both saying "not configured"), and repeating
        // it makes the banner read as two separate problems.
        <ul className="mt-2 space-y-0.5">
          {[...new Set(warnings)].map((w) => (
            <li key={w} className="text-2xs text-[var(--color-warn)]">
              ▲ {w}
            </li>
          ))}
        </ul>
      )}
      {children}
    </header>
  );
}
