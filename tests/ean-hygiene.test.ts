/**
 * §16.5.1 — EAN hygiene, and the parity test that stops the TypeScript and SQL
 * implementations from drifting.
 */
import { describe, expect, it } from 'vitest';
import { normalizeEan, partitionEans, sqlFilterAdmits, type EanRejectReason } from '@/lib/format/ean';
import { FIXTURE_RAW_SCAN_VALUES } from '@/fixtures/catalogue';

/** One fixture containing every reject reason (§16.5.1). */
const CASES: Array<{ raw: unknown; ok: boolean; reason?: EanRejectReason; ean?: string }> = [
  { raw: '8905863997257', ok: true, ean: '8905863997257' },
  { raw: '  8909391926840 ', ok: true, ean: '8909391926840' },
  { raw: "'8909393021680", ok: true, ean: '8909393021680' },
  { raw: '8905527894113', ok: true, ean: '8905527894113' },
  { raw: '12345678', ok: true, ean: '12345678' }, // EAN-8
  { raw: '12345678901234', ok: true, ean: '12345678901234' }, // ITF-14
  // Ritu Raj's case, 17 Jun 2026 — random URLs in the `ean` column.
  { raw: 'https://www.ajio.com/p/12345', ok: false, reason: 'url' },
  { raw: 'www.trends.in/item', ok: false, reason: 'url' },
  { raw: 'https://short.de/xY9', ok: false, reason: 'url' },
  { raw: '', ok: false, reason: 'empty' },
  { raw: null, ok: false, reason: 'empty' },
  { raw: '0000000000000', ok: false, reason: 'placeholder' },
  { raw: '1111111111111', ok: false, reason: 'placeholder' },
  { raw: '12345', ok: false, reason: 'too_short' },
  { raw: '123456789012345678', ok: false, reason: 'too_long' },
  { raw: 'SKU-ABC', ok: false, reason: 'non_numeric' },
];

describe('normalizeEan', () => {
  for (const c of CASES) {
    it(`${c.ok ? 'accepts' : `rejects (${c.reason})`}: ${JSON.stringify(c.raw)}`, () => {
      const v = normalizeEan(c.raw);
      expect(v.ok).toBe(c.ok);
      if (v.ok) expect(v.ean).toBe(c.ean);
      else expect(v.reason).toBe(c.reason);
    });
  }
});

describe('TypeScript ↔ SQL parity', () => {
  it('produces identical verdicts on every reject reason', () => {
    // The two implementations must stay in sync: the TS one for row-level
    // processing and rejection logging, the SQL one for aggregate pruning.
    for (const c of CASES) {
      const ts = normalizeEan(c.raw).ok;
      const sql = sqlFilterAdmits(c.raw);
      expect({ raw: c.raw, ts }).toEqual({ raw: c.raw, ts: sql });
    }
  });

  it('agrees on the raw scan values seen in production', () => {
    for (const raw of FIXTURE_RAW_SCAN_VALUES) {
      expect(normalizeEan(raw).ok).toBe(sqlFilterAdmits(raw));
    }
  });
});

describe('rejections are recorded, not discarded', () => {
  it('reports a rejection rate and keeps the raw values for debugging', () => {
    const { valid, rejected, rejectionRate } = partitionEans([...FIXTURE_RAW_SCAN_VALUES]);
    expect(valid.length).toBeGreaterThan(0);
    expect(rejected.size).toBeGreaterThan(0);
    // Silently dropping junk replaces one blind spot with another: if 8% of
    // scans are junk, someone needs to know, because it is an app bug.
    expect(rejectionRate).toBeGreaterThan(0);
    expect(rejectionRate).toBeLessThan(1);
    expect(rejected.get('url')?.length).toBeGreaterThan(0);
  });

  it('strips a spreadsheet leading apostrophe rather than rejecting the barcode', () => {
    // Barcodes arrive with stray whitespace and occasional leading apostrophes
    // from spreadsheet round-trips.
    const v = normalizeEan("'8905863997257");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ean).toBe('8905863997257');
  });
});
