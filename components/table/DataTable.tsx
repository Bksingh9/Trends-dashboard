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

export function DataTable<T>({
  columns,
  rows,
  caption,
  sourceNote,
  emptyMessage = 'No rows',
  maxHeight = 480,
  rowKey,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  caption?: string;
  sourceNote?: string;
  emptyMessage?: string;
  maxHeight?: number;
  rowKey: (row: T, i: number) => string;
  className?: string;
}) {
  return (
    // min-w-0 is load-bearing: this is usually a grid or flex item, and those
    // default to `min-width: auto`, so the item sizes to the table's intrinsic
    // width and drags the page past the viewport. The child's `overflow-auto`
    // cannot rescue it, because by then the parent is already too wide.
    <div className={cn('min-w-0 rounded border border-[var(--color-edge)] bg-[var(--surface)]', className)}>
      {caption && (
        <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-edge)] px-3 py-2">
          <span className="label">{caption}</span>
          <span className="num text-2xs text-[var(--text-muted)]">{rows.length} rows</span>
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
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-[var(--text-muted)]">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
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
  children,
}: {
  title: string;
  question: string;
  window?: { start: string; end: string };
  sources: string[];
  warnings?: string[];
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-xl">{title}</h1>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{question}</p>
        </div>
        {/* max-w-md (448px) exceeds a 412px phone viewport, so it is capped to
            the container below sm and only widens once there is room. */}
        <div className="min-w-0 max-w-full text-2xs text-[var(--text-muted)] sm:text-right">
          {window && (
            <div className="num">
              {window.start} → {window.end} IST
            </div>
          )}
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
