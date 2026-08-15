/**
 * §9.6 / §19.3 — CSV export.
 *
 * An export is trusted more than the screen: people paste it into a pivot and
 * treat the result as fact. So the failures worth guarding are the silent ones
 * — a store code that loses its leading zero, a rupee sign that arrives
 * mangled, a truncated table that exports its truncation.
 */
import { describe, expect, it } from 'vitest';
import { csvCell, csvFilename, toCsv } from '@/lib/format/csv';

describe('escaping', () => {
  it('quotes and doubles quotes, per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('has,comma')).toBe('"has,comma"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('keeps a leading zero from being eaten by a spreadsheet', () => {
    // §19.3 — a store code of 01234 and an EAN both carry load-bearing leading
    // zeros. Quoting alone does not stop Excel converting them to numbers on
    // open; a tab prefix does, and neither Excel nor Sheets displays it.
    const cell = csvCell('01234');
    expect(cell).toContain('01234');
    expect(cell).toMatch(/^"?\t/);
    // A number that never had a leading zero is left alone.
    expect(csvCell('1234')).toBe('1234');
    expect(csvCell(1234)).toBe('1234');
  });

  it('writes an empty cell for null, and for a number that is not one', () => {
    // NaN or Infinity written literally becomes a text cell that poisons a SUM.
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('writes raw numbers, not formatted ones', () => {
    // The screen says ₹10.29 L. A spreadsheet needs 1029000, or the column
    // cannot be summed — and somebody will try.
    expect(csvCell(1029000)).toBe('1029000');
    expect(csvCell(0.94)).toBe('0.94');
  });
});

describe('building the file', () => {
  it('takes the union of keys, so an optional field cannot shift the columns', () => {
    // With only the first row's keys, a row missing `city` would push every
    // later value one column left — and every row after it would be wrong.
    const { csv } = toCsv([
      { storeId: 'a', orders: 1 },
      { storeId: 'b', orders: 2, city: 'Pune' },
    ]);
    const [header, ...rows] = csv.split('\n');
    expect(header).toBe('storeId,orders,city');
    expect(rows[0]).toBe('a,1,');
    expect(rows[1]).toBe('b,2,Pune');
  });

  it('drops a column that holds objects, and says which', () => {
    const r = toCsv([{ id: 'a', nested: { x: 1 }, n: 2 }]);
    expect(r.droppedColumns).toEqual(['nested']);
    expect(r.csv.split('\n')[0]).toBe('id,n');
  });

  it('decides scalar-ness on the first non-null value, not the first row', () => {
    const r = toCsv([
      { id: 'a', maybe: null },
      { id: 'b', maybe: { deep: true } },
    ]);
    expect(r.droppedColumns).toEqual(['maybe']);
  });

  it('returns nothing for no rows, rather than a lone header', () => {
    const r = toCsv([]);
    expect(r.csv).toBe('');
    expect(r.rowCount).toBe(0);
  });

  it('exports every row, not the truncated view', () => {
    // The one assumption people make about a download button, and the one
    // that is wrong here on purpose: the tail is why they clicked.
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, orders: i }));
    const r = toCsv(rows);
    expect(r.rowCount).toBe(500);
    expect(r.csv.split('\n')).toHaveLength(501); // header + 500
  });
});

describe('filenames', () => {
  it('slugs the caption and carries the window', () => {
    expect(csvFilename('Dark stores — no order recently')).toBe('dark-stores-no-order-recently.csv');
    expect(csvFilename('Store matrix', { start: '2026-07-18', end: '2026-08-14' })).toBe(
      'store-matrix-2026-07-18_2026-08-14.csv',
    );
  });

  it('produces a filename a filesystem accepts', () => {
    const name = csvFilename('Coverage: 94% / “unique” — by store');
    expect(name).toMatch(/^[a-z0-9-]+\.csv$/);
    expect(name.length).toBeLessThan(70);
  });
});
