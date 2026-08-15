/**
 * §9.6 — CSV export.
 *
 * Built from the **row objects**, not from the rendered columns. A column
 * renders `₹10.29 L` and `94.0%`; a spreadsheet needs `1029000` and `0.94`.
 * Exporting what is on screen produces a file that looks right and cannot be
 * summed, which is worse than no export at all — somebody will paste it into a
 * pivot and get an answer.
 *
 * So the export carries the underlying field names and raw values. It is the
 * data behind the table, which is what anybody asking for "the CSV" wants.
 */

/** Values a spreadsheet can hold. Anything else is dropped, and said so. */
type Scalar = string | number | boolean | null | undefined;

function isScalar(v: unknown): v is Scalar {
  return v == null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Escapes one cell.
 *
 * The leading apostrophe guard is not decoration: a store code like `01234`
 * or an EAN is a string whose leading zeros are load-bearing (§19.3), and
 * Excel silently converts anything digit-shaped to a number on open. Quoting
 * alone does not stop it. A value that is all digits and has a leading zero is
 * therefore prefixed with a tab, which Excel and Sheets both read as "text"
 * without showing the character.
 */
export function csvCell(v: Scalar): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';

  const s = String(v);
  const needsTextGuard = /^0\d+$/.test(s);
  const body = needsTextGuard ? `\t${s}` : s;
  // RFC 4180: quote if it contains a delimiter, quote or newline; double any
  // embedded quote.
  return /[",\n\r\t]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

export interface CsvResult {
  csv: string;
  rowCount: number;
  /** Columns dropped because they held objects or arrays, not scalars. */
  droppedColumns: string[];
}

/**
 * One row per record, columns in first-seen order across all rows.
 *
 * Union of keys rather than the first row's, because a row missing an optional
 * field would otherwise silently shift every later column left.
 */
export function toCsv<T extends Record<string, unknown>>(rows: T[]): CsvResult {
  if (rows.length === 0) return { csv: '', rowCount: 0, droppedColumns: [] };

  const keys: string[] = [];
  const dropped = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (keys.includes(k) || dropped.has(k)) continue;
      // Decided on the first non-null occurrence: a column that is null in row
      // one and an object in row two is not a scalar column.
      const sample = rows.find((r) => r[k] != null)?.[k];
      if (sample !== undefined && !isScalar(sample)) dropped.add(k);
      else keys.push(k);
    }
  }

  const header = keys.map((k) => csvCell(k)).join(',');
  const body = rows.map((row) => keys.map((k) => csvCell(row[k] as Scalar)).join(',')).join('\n');

  return { csv: `${header}\n${body}`, rowCount: rows.length, droppedColumns: [...dropped] };
}

/** `Dark stores` + a window → `dark-stores-2026-07-18_2026-08-14.csv`. */
export function csvFilename(caption: string, window?: { start: string; end: string }): string {
  const slug = caption
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return window ? `${slug}-${window.start}_${window.end}.csv` : `${slug}.csv`;
}
