'use client';

/**
 * §9.6 — the download button.
 *
 * The CSV is built on the server, where the row objects live, and arrives here
 * as a finished string. Nothing about the data model crosses the boundary and
 * no fetch is made — the file is already in the page, so the click is instant
 * and works with the dashboard's own auth rather than needing an endpoint of
 * its own to protect.
 *
 * A Blob rather than a `data:` URL: Chrome caps `data:` navigations around
 * 2 MB, which a store table clears easily, and the failure is a silently
 * ignored click.
 */
import { useState } from 'react';

export function CsvExport({
  csv,
  filename,
  rowCount,
  droppedColumns = [],
}: {
  csv: string;
  filename: string;
  rowCount: number;
  droppedColumns?: string[];
}) {
  const [done, setDone] = useState(false);
  if (!csv) return null;

  const download = () => {
    // ﻿ — without the BOM, Excel opens UTF-8 as Latin-1 and the rupee sign
    // and every accented store name arrive mangled.
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  };

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        data-csv-export={filename}
        onClick={download}
        title={
          droppedColumns.length
            ? `Exports ${rowCount} rows. Columns not exportable as text: ${droppedColumns.join(', ')}`
            : `Exports all ${rowCount} rows with their raw values`
        }
        className="rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-2xs text-[var(--text-muted)] hover:border-[var(--color-ion)] hover:text-[var(--color-ion)]"
      >
        {done ? 'Downloaded' : 'CSV'}
      </button>
      {/* Said out loud: the export is the full set, not the truncated view. The
          opposite assumption — that a download matches what is on screen — is
          the one people make, and it is wrong here on purpose. */}
      {droppedColumns.length > 0 && (
        <span className="text-2xs text-[var(--text-muted)]/70">{droppedColumns.length} col. omitted</span>
      )}
    </span>
  );
}
