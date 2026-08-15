/**
 * §20 — Connector 6: `bq-catalogue-master`. P1.
 *
 * Turns "this EAN failed to scan" into "and here's why". The duplicate-assignment
 * subquery is the outbound detector: it finds the "EAN already assigned to
 * another item code" case mechanically instead of relying on manual triage.
 */
import { config } from '@/lib/config';
import { cardinality, nullRate, rowVolume } from '@/lib/assertions';
import { normalizeEan } from '@/lib/format/ean';
import { normalizeItemCode } from '@/lib/format/keys';
import { isBigQueryConfigured, runQuery } from '@/lib/gcp/bigquery';
import { fixtureProductMaster } from '@/fixtures/catalogue';
import type { DateWindow } from '@/lib/format/dates';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

/**
 * §20.2 — the RBL structured catalogue, verified against production.
 *
 * This is the source that is actually reachable and actually populated:
 * `rbl_catalog_structured_v7` in `fynd-jio-impetus-prod`, 1,81,022 products and
 * 1,77,741 variants, confirmed by schema discovery on 14 Aug 2026.
 *
 * The EAN lives on the *variant*, not the product — one style in six sizes is
 * six barcodes — so the grain of `dim_product` is one row per (EAN, item_code)
 * and the join fans out deliberately. `gtin_value` is the barcode;
 * `gtin_type` distinguishes EAN13 from UPC and the like.
 *
 * `available` is a STRING in this schema, not a boolean, so it is normalised in
 * `transform` rather than trusted here — the values seen in the wild include
 * both `true`/`false` and `1`/`0`.
 *
 * **`gtin_type` is load-bearing, and mostly says `ALU`.** ALU is Reliance's
 * internal Article Level Unit code, not a barcode. The Companion scan feed
 * sends real EANs read off a physical product, so joining an ALU against a
 * scanned EAN matches nothing — and the silent result would be every scanned
 * product classifying as `absent_from_master`, which is the most alarming
 * reason in the §20.3 taxonomy and would have been entirely an artefact.
 *
 * `gtin_value` also arrives float-formatted (`410219992001.0`) because the
 * upstream passed it through a numeric type. §19.3 is exactly this hazard: the
 * trailing `.0` is why every value failed check-digit validation.
 */
export const RBL_ITEM_SQL = () => `
SELECT
  p.item_code,
  v.gtin_value AS ean_raw,
  v.gtin_type,
  p.name,
  p.brand,
  p.category,
  CAST(p.available AS STRING) AS available
FROM \`${config.bqCatalogueProject}.${config.bqCatalogueDataset}.product_variants\` AS v
JOIN \`${config.bqCatalogueProject}.${config.bqCatalogueDataset}.products\` AS p
  USING (product_id)
WHERE v.gtin_value IS NOT NULL
  AND p.item_code IS NOT NULL
`.trim();

/**
 * What proportion of the catalogue is actually barcoded, by identifier type.
 *
 * Cheap, and it answers the question that decides whether this source can serve
 * as the EAN master at all: if every row is `ALU`, it cannot, and the §20.3 join
 * needs a different table.
 */
export const GTIN_TYPE_SQL = () => `
SELECT gtin_type, COUNT(*) AS n
FROM \`${config.bqCatalogueProject}.${config.bqCatalogueDataset}.product_variants\`
GROUP BY 1
ORDER BY n DESC
`.trim();

/**
 * §19.3 — undo the float round-trip an upstream numeric column leaves behind.
 *
 * `410219992001.0` is not a barcode with a decimal point; it is a barcode that
 * passed through a FLOAT64. Stripping the artefact is safe, but `Number()` is
 * not — that would drop the leading zeros a real EAN can carry.
 */
export function stripFloatArtefact(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s;
}

/**
 * Identifier types that are genuinely barcodes a customer can scan.
 * `ALU` is deliberately excluded — see the note on `RBL_ITEM_SQL`.
 */
export const BARCODE_GTIN_TYPES = new Set(['EAN', 'EAN13', 'UPC', 'UPCA', 'GTIN', 'ISBN']);

/** §20.2 — unnest `all_identifiers` to a flat EAN dimension. ~3 lakh expected. */
export const ITEM_SQL = `
SELECT
  item.item_code,
  ident AS ean_raw,
  item.name,
  item.brand,
  item.category,
  item.is_active
FROM \`${config.bqItemTable}\` AS item,
UNNEST(item.all_identifiers) AS ident
WHERE ident IS NOT NULL
`.trim();

export interface ProductRow {
  itemCode: string;
  ean: string;
  name: string;
  brand: string;
  category: string | null;
  categoryMapped: boolean;
  isActive: boolean;
}

interface RawItem {
  item_code: string;
  ean_raw: string;
  name: string;
  brand: string;
  category: string | null;
  /** Orbis returns a real boolean. */
  is_active?: boolean;
  /** RBL returns a STRING — `true`/`false` and `1`/`0` both occur. */
  available?: string | null;
  gtin_type?: string | null;
}

export class BqCatalogueMasterConnector extends BaseConnector<RawItem, ProductRow> {
  readonly id = 'bq-catalogue-master';
  readonly displayName = 'BigQuery — catalogue master (Orbis item)';
  readonly freshnessSlaMinutes = 30 * 60;
  readonly costTier: CostTier = 'metered';
  readonly priority = 'P1' as const;
  readonly powers = ['gap reason classification', 'dim_product', '/catalogue gap reasons'];
  readonly blockedBy = '§13.2 GCP service account';

  isConfigured(): boolean {
    return isBigQueryConfigured();
  }

  /**
   * Two possible upstreams for the same mart, and only one of them has ever
   * been reachable.
   *
   * `ITEM_SQL` targets the Orbis item table in the Companion project, which is
   * what §20.2 originally specified. `RBL_ITEM_SQL` targets the structured RBL
   * catalogue, which is the source that actually answered — verified against
   * production, 1.81 lakh products.
   *
   * One connector rather than two, because two connectors writing `dim_product`
   * is the double-write the concurrency guard cannot help with: both would
   * produce valid rows and the result would reconcile against nothing. The
   * source used is recorded on the run so provenance is never ambiguous.
   */
  private sourceSql(): { sql: string; source: 'rbl' | 'orbis' } {
    if (config.bqCatalogueProject && config.bqCatalogueDataset) {
      return { sql: RBL_ITEM_SQL(), source: 'rbl' };
    }
    return { sql: ITEM_SQL, source: 'orbis' };
  }

  protected async extract(): Promise<RawItem[]> {
    const { sql, source } = this.sourceSql();
    const res = await runQuery<RawItem>({ query: sql, // BigQuery labels allow only lowercase letters, digits, hyphens and
      // underscores — a colon here is rejected outright, which the live API
      // catches and no amount of local review would have.
      connector: `${this.id}-${source}` });
    return res.rows;
  }

  /**
   * §20.2 — normalise, then **de-duplicate on the mart's natural key**.
   *
   * The real RBL catalogue contains the same `(ean, item_code)` pair more than
   * once — different size variants sharing a barcode, and outright duplicate
   * rows. Postgres rejects an `ON CONFLICT DO UPDATE` statement whose batch
   * touches one row twice ("cannot affect row a second time"), so the whole
   * load failed on the first production run.
   *
   * That is not an inconvenience to paper over: those duplicates *are* the
   * §20.3 `ean_assigned_to_multiple_item_codes` defect, and they are the single
   * largest error class in the Tatsu sync report (2,742 of 2,935 outbound
   * failures in one hour). The loader keeps the first occurrence, and the count
   * of collapsed rows is published so it reads as a catalogue finding rather
   * than as a quietly shorter load.
   */
  protected transform(rows: RawItem[]): ProductRow[] {
    const byKey = new Map<string, ProductRow>();
    const nonBarcodeTypes = new Map<string, number>();
    let duplicateKeys = 0;
    let rejectedEans = 0;

    for (const r of rows) {
      // §16.5.1 — apply EAN hygiene on *both* sides of every join, or the
      // normalisation buys you nothing.
      // Only scannable identifier types reach the EAN column. An ALU is an
      // internal article code; letting one through would put a value in
      // `dim_product.ean` that no scan can ever match, and every scan of that
      // product would then classify as `absent_from_master`.
      const gtinType = (r.gtin_type ?? '').trim().toUpperCase();
      if (gtinType && !BARCODE_GTIN_TYPES.has(gtinType)) {
        nonBarcodeTypes.set(gtinType, (nonBarcodeTypes.get(gtinType) ?? 0) + 1);
        continue;
      }

      const v = normalizeEan(stripFloatArtefact(r.ean_raw));
      if (!v.ok) {
        rejectedEans++;
        continue;
      }
      const itemCode = normalizeItemCode(r.item_code);
      const key = `${v.ean}|${itemCode}`;
      if (byKey.has(key)) {
        duplicateKeys++;
        continue;
      }
      byKey.set(key, {
        itemCode,
        ean: v.ean,
        name: r.name ?? '',
        brand: r.brand ?? '',
        category: r.category ?? null,
        categoryMapped: r.category != null && r.category !== '',
        // Orbis sends a boolean; RBL sends a string that is `true`/`false` in
        // some rows and `1`/`0` in others. `Boolean('false')` is true, so
        // trusting either shape directly marks every discontinued item live.
        isActive: activeFlag(r),
      });
    }

    this.lastDuplicateKeys = duplicateKeys;
    this.lastRejectedEans = rejectedEans;
    this.lastNonBarcode = [...nonBarcodeTypes.entries()].sort((a, b) => b[1] - a[1]);

    if (duplicateKeys > 0 || rejectedEans > 0 || nonBarcodeTypes.size > 0) {
      const skipped = this.lastNonBarcode.map(([t, n]) => `${t}×${n}`).join(', ');
      console.warn(
        `[${this.id}] ${rows.length} source rows → ${byKey.size} unique (ean, item_code); ` +
          `${duplicateKeys} duplicate keys collapsed, ${rejectedEans} failed EAN hygiene` +
          (skipped ? `, non-barcode identifier types skipped: ${skipped}` : ''),
      );
    }

    return [...byKey.values()];
  }

  /** Read by the duplicate-rate assertion; see §20.3. */
  private lastDuplicateKeys = 0;
  private lastRejectedEans = 0;
  private lastNonBarcode: Array<[string, number]> = [];

  protected async load(rows: ProductRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { dimProduct } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'dim_product' };
    // §20.4 — 3 lakh rows is small; a daily full refresh is fine.
    for (let i = 0; i < rows.length; i += 1000) {
      await db
        .insert(dimProduct)
        .values(rows.slice(i, i + 1000))
        .onConflictDoUpdate({
          target: [dimProduct.ean, dimProduct.itemCode],
          set: {
            name: sql`excluded.name`,
            brand: sql`excluded.brand`,
            category: sql`excluded.category`,
            categoryMapped: sql`excluded.category_mapped`,
            isActive: sql`excluded.is_active`,
            updatedAt: new Date(),
          },
        });
    }
    return { rowsIngested: rows.length, table: 'dim_product' };
  }

  protected fixture(w: DateWindow): ProductRow[] {
    // Derived from the same scan rows as the gap register, so the §20.3 reason
    // join actually reconciles. An independently-invented product fixture would
    // make every gap read as `absent_from_master`.
    //
    // Not 3 lakh rows — the real master is that size and the volume would be
    // noise here. What matters is that every branch of the classifier has a
    // real row to land on.
    return fixtureProductMaster(w);
  }

  readonly assertions: Assertion<ProductRow>[] = [
    rowVolume<ProductRow>({ tolerance: 0.5, zeroIsFail: true }),
    nullRate<ProductRow>({ columns: ['ean', 'itemCode'], max: 0.01, level: 'fail' }),
    // Warn, not fail: the real master carries ~3 lakh EANs and a collapse to a
    // few thousand means the unnest broke. The fixture is deliberately smaller,
    // so this warns there rather than blocking the seed.
    // `fail`, not `warn`. A collapsed product dimension is worse than a stale
    // one: §20.3 classifies any scanned EAN missing from the master as
    // `absent_from_master`, so loading a near-empty master would report the
    // entire catalogue as missing — the most alarming reason in the taxonomy,
    // stated with total confidence, and entirely an artefact. §6.3 hard-fail
    // leaves the mart on its last good snapshot, which is the right outcome.
    cardinality<ProductRow>({ column: 'ean', minDistinct: 10_000, level: 'fail' }),
    // §20.3 — duplicate (ean, item_code) pairs are the catalogue's largest
    // outbound defect, independently confirmed by the Tatsu sync report. A
    // *rise* is the finding; some duplication is the steady state, so this
    // warns rather than blocking the load.
    {
      id: 'duplicate_ean_item_pairs',
      level: 'warn' as const,
      run: (loaded: ProductRow[]) => {
        const dupes = this.lastDuplicateKeys;
        const total = loaded.length + dupes;
        const rate = total === 0 ? 0 : dupes / total;
        if (rate > 0.05) {
          return {
            id: 'duplicate_ean_item_pairs',
            level: 'warn' as const,
            message: `${dupes.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} catalogue rows share an (EAN, item code) pair (${(rate * 100).toFixed(1)}%) — the §20.3 outbound defect the sync report tracks`,
            observed: Number(rate.toFixed(4)),
            expected: 0.05,
          };
        }
        return {
          id: 'duplicate_ean_item_pairs',
          level: 'pass' as const,
          message: `${dupes} duplicate (EAN, item code) pairs collapsed`,
          observed: dupes,
        };
      },
    },
  ];
}

/**
 * §20.3 — reason classification. `suspected_reason` is a hypothesis and the
 * column name stays honest about that; the register's `status` field is where a
 * human confirms it.
 */
export type GapReason =
  | 'absent_from_master'
  | 'category_not_mapped'
  | 'item_inactive'
  | 'ean_assigned_to_multiple_item_codes'
  | 'present_investigate';

/** Normalises the two shapes `available`/`is_active` arrive in. */
export function activeFlag(r: { is_active?: boolean; available?: string | null }): boolean {
  if (typeof r.is_active === 'boolean') return r.is_active;
  const v = (r.available ?? '').trim().toLowerCase();
  // Unknown is treated as active: a product missing the flag is far more often
  // a gap in the feed than a discontinued line, and marking it inactive would
  // classify every scan of it as `item_inactive` — a wrong reason, confidently
  // stated, which is worse than no reason at all.
  if (v === '') return true;
  return v === 'true' || v === '1' || v === 'yes' || v === 'y';
}

export function classifyGap(
  ean: string,
  master: Map<string, { category: string | null; isActive: boolean; itemCodes: Set<string> }>,
): { reason: GapReason; direction: 'inbound' | 'outbound' } {
  const item = master.get(ean);
  if (!item) return { reason: 'absent_from_master', direction: 'inbound' };
  if (item.itemCodes.size > 1)
    return { reason: 'ean_assigned_to_multiple_item_codes', direction: 'outbound' };
  if (!item.category) return { reason: 'category_not_mapped', direction: 'inbound' };
  if (!item.isActive) return { reason: 'item_inactive', direction: 'outbound' };
  return { reason: 'present_investigate', direction: 'inbound' };
}

export function buildMasterIndex(
  products: ProductRow[],
): Map<string, { category: string | null; isActive: boolean; itemCodes: Set<string> }> {
  const m = new Map<string, { category: string | null; isActive: boolean; itemCodes: Set<string> }>();
  for (const p of products) {
    const cur = m.get(p.ean) ?? { category: p.category, isActive: p.isActive, itemCodes: new Set<string>() };
    cur.itemCodes.add(p.itemCode);
    cur.category = cur.category ?? p.category;
    cur.isActive = cur.isActive || p.isActive;
    m.set(p.ean, cur);
  }
  return m;
}

export const bqCatalogueMaster = new BqCatalogueMasterConnector();
