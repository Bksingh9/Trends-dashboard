/**
 * §4.9 — Browse BigQuery.
 *
 * The navigator every BI tool opens with: pick a project, see its datasets,
 * expand one, see its tables with row counts and sizes, click a table and see
 * its columns. Power BI calls it Navigator, Looker Studio calls it the data
 * source picker. This build had no equivalent — the only way to find out what
 * was in the warehouse was `npm run discover` from a terminal.
 *
 * Everything here is **metadata only**. `datasets.list`, `tables.list`,
 * `tables.get` and `__TABLES__` all scan zero bytes, so expanding a dataset
 * costs nothing. That is a deliberate constraint rather than an optimisation: a
 * browser that bills a query every time somebody clicks a folder is a browser
 * nobody is allowed to use twice, and the one thing this page must not do is
 * make exploring the warehouse expensive.
 */
import Link from 'next/link';
import { config } from '@/lib/config';
import { isBigQueryConfigured, listColumns, listDatasets, listTables } from '@/lib/gcp/bigquery';
import { ModuleHeader } from '@/components/table/DataTable';
import { formatCount } from '@/lib/format/currency';
import { formatIST } from '@/lib/format/dates';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ dataset?: string; table?: string; q?: string }>;
}) {
  const { dataset, table, q } = await searchParams;
  const project = config.gcpProjectId;

  if (!isBigQueryConfigured()) {
    return (
      <div className="space-y-4">
        <ModuleHeader
          title="Browse BigQuery"
          question="What is actually in the warehouse?"
          sources={['BigQuery metadata API — no bytes scanned']}
        />
        <div className="rounded border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2.5">
          <div className="text-xs font-semibold text-[var(--color-warn)]">No BigQuery credential</div>
          <p className="mt-1 max-w-3xl text-2xs text-[var(--text-muted)]">
            Add one on{' '}
            <Link href="/connectors/sources" className="text-[var(--color-ion)] underline">
              Data sources
            </Link>{' '}
            and this page will list every dataset the service account can see.
          </p>
        </div>
      </div>
    );
  }

  let datasets: string[] = [];
  let error: string | null = null;
  try {
    datasets = await listDatasets(project);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const needle = (q ?? '').trim().toLowerCase();
  const shown = needle ? datasets.filter((d) => d.toLowerCase().includes(needle)) : datasets;

  const tables = dataset ? await listTables(dataset, project).catch(() => []) : [];
  const columns = dataset && table ? await listColumns(dataset, table, project).catch(() => []) : [];

  return (
    <div className="space-y-4">
      <ModuleHeader
        title="Browse BigQuery"
        question="What is actually in the warehouse, and how big is it?"
        sources={[`${project} — metadata API, no bytes scanned`]}
        warnings={error ? [error] : []}
      >
        <p className="mt-3 max-w-3xl text-xs text-[var(--text-muted)]">
          {formatCount(datasets.length)} datasets visible to{' '}
          <span className="text-[var(--text-primary)]">{project}</span>&rsquo;s service account.
          Expanding anything here is free — row counts come from <code className="num">__TABLES__</code>,
          which scans nothing. To read rows, use{' '}
          <Link href="/insights" className="text-[var(--color-ion)] underline">
            Ask the data
          </Link>
          , where a query is budgeted and guarded.
        </p>
      </ModuleHeader>

      <form className="flex flex-wrap items-center gap-2" method="get">
        <input
          name="q"
          defaultValue={q ?? ''}
          data-dataset-search
          placeholder="Filter datasets — try “analytics”, “sng”, “catalog”…"
          className="w-full max-w-sm rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:border-[var(--color-ion)] focus:outline-none"
        />
        <button
          type="submit"
          className="rounded border border-[var(--color-edge)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:border-[var(--color-ion)]"
        >
          Filter
        </button>
      </form>

      <div className="grid gap-3 lg:grid-cols-[18rem_1fr]">
        <nav
          aria-label="Datasets"
          className="max-h-[34rem] overflow-y-auto rounded border border-[var(--color-edge)] bg-[var(--surface)] p-2"
        >
          <div className="label mb-1.5 px-1">Datasets ({shown.length})</div>
          <ul className="space-y-0.5">
            {shown.map((d) => (
              <li key={d}>
                <Link
                  href={`/connectors/browse?dataset=${encodeURIComponent(d)}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                  data-dataset={d}
                  className={cn(
                    'block truncate rounded px-2 py-1 text-2xs',
                    d === dataset
                      ? 'bg-[var(--color-ion)]/15 text-[var(--color-ion)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--color-ink)] hover:text-[var(--text-primary)]',
                  )}
                >
                  {d}
                </Link>
              </li>
            ))}
            {shown.length === 0 && !error && (
              <li className="px-2 py-3 text-2xs text-[var(--text-muted)]">Nothing matches that filter.</li>
            )}
          </ul>
        </nav>

        <div className="space-y-3">
          {!dataset ? (
            <p className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-6 text-xs text-[var(--text-muted)]">
              Choose a dataset to see its tables.
            </p>
          ) : (
            <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)]">
              <header className="border-b border-[var(--color-edge)] px-3 py-2">
                <span className="label">{dataset}</span>
                <span className="ml-2 text-2xs text-[var(--text-muted)]">{tables.length} tables</span>
              </header>
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-2xs">
                  <thead className="sticky top-0 bg-[var(--surface)] text-[var(--text-muted)]">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-normal">Table</th>
                      <th className="px-3 py-1.5 text-left font-normal">Type</th>
                      <th className="px-3 py-1.5 text-right font-normal">Rows</th>
                      <th className="px-3 py-1.5 text-right font-normal">Size</th>
                      <th className="px-3 py-1.5 text-right font-normal">Last modified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.map((t) => (
                      <tr
                        key={t.tableId}
                        className={cn(
                          'border-t border-[var(--color-edge)]/50',
                          t.tableId === table && 'bg-[var(--color-ion)]/10',
                        )}
                      >
                        <td className="px-3 py-1.5">
                          <Link
                            href={`/connectors/browse?dataset=${encodeURIComponent(dataset)}&table=${encodeURIComponent(t.tableId)}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                            data-table={t.tableId}
                            className="text-[var(--color-ion)] hover:underline"
                          >
                            {t.tableId}
                          </Link>
                        </td>
                        {/* A view is not a table to load from, and the two are
                            indistinguishable by name. */}
                        <td className="px-3 py-1.5 text-[var(--text-muted)]">{t.type.toLowerCase()}</td>
                        <td className="num px-3 py-1.5 text-right">{t.rows == null ? '—' : formatCount(t.rows)}</td>
                        <td className="num px-3 py-1.5 text-right text-[var(--text-muted)]">{formatBytes(t.bytes)}</td>
                        <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">
                          {t.modifiedAt ? formatIST(t.modifiedAt) : '—'}
                        </td>
                      </tr>
                    ))}
                    {tables.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-center text-[var(--text-muted)]">
                          No tables, or this dataset is not readable by the service account.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {table && (
            <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)]">
              <header className="border-b border-[var(--color-edge)] px-3 py-2">
                <span className="label">
                  {dataset}.{table}
                </span>
                <span className="ml-2 text-2xs text-[var(--text-muted)]">{columns.length} columns</span>
              </header>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-2xs">
                  <thead className="sticky top-0 bg-[var(--surface)] text-[var(--text-muted)]">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-normal">Column</th>
                      <th className="px-3 py-1.5 text-left font-normal">Type</th>
                      <th className="px-3 py-1.5 text-left font-normal">Mode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((c) => (
                      <tr key={c.name} className="border-t border-[var(--color-edge)]/50">
                        <td className="px-3 py-1.5 text-[var(--text-primary)]">{c.name}</td>
                        <td className="px-3 py-1.5 text-[var(--text-muted)]">{c.type}</td>
                        <td className="px-3 py-1.5 text-[var(--text-muted)]">{c.mode.toLowerCase()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
