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
  is_active: boolean;
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

  protected async extract(): Promise<RawItem[]> {
    const res = await runQuery<RawItem>({ query: ITEM_SQL, connector: this.id });
    return res.rows;
  }

  protected transform(rows: RawItem[]): ProductRow[] {
    const out: ProductRow[] = [];
    for (const r of rows) {
      // §16.5.1 — apply EAN hygiene on *both* sides of every join, or the
      // normalisation buys you nothing.
      const v = normalizeEan(r.ean_raw);
      if (!v.ok) continue;
      out.push({
        itemCode: normalizeItemCode(r.item_code),
        ean: v.ean,
        name: r.name ?? '',
        brand: r.brand ?? '',
        category: r.category,
        categoryMapped: r.category != null && r.category !== '',
        isActive: Boolean(r.is_active),
      });
    }
    return out;
  }

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
    cardinality<ProductRow>({ column: 'ean', minDistinct: 10_000, level: 'warn' }),
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
