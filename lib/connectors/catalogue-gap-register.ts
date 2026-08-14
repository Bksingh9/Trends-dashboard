/**
 * §20.3 — Connector 16: `catalogue-gap-register`. P0, and free.
 *
 * Turns "this EAN failed to scan" into an owned row with a suspected reason and
 * an aging clock. It is a *derivation*, not an extraction: it joins
 * `fact_scan_daily` against `dim_product` inside Postgres and needs no
 * credential of its own — like `test-ean-canary`, the only thing that can block
 * it is having nowhere to read from.
 *
 * It exists because `fact_catalogue_gap` was read by `/catalogue` — the missing
 * EAN register, the reason breakdown, the aging histogram, the §6.3
 * reconciliation — and written by nothing at all. The classifier
 * (`classifyGap`) had been written and tested; nothing ever called it against
 * real rows.
 *
 * The ownership fields are deliberately preserved on re-run. A human who
 * assigns an owner, sets a status or writes a note is recording something the
 * pipeline cannot re-derive, and overwriting it every night would make the
 * register useless as a worklist — which is the one thing it is for.
 */
import { type DateWindow } from '@/lib/format/dates';
import { nullRate, rowVolume, valueSet } from '@/lib/assertions';
import { getDb } from '@/lib/db/client';
import { fixtureGaps } from '@/fixtures/catalogue';
import { BaseConnector } from './base';
import { buildMasterIndex, classifyGap, type ProductRow } from './bq-catalogue-master';
import type { Assertion, CostTier, LoadResult } from './types';

export interface GapRegisterRow {
  ean: string;
  firstSeen: string;
  lastSeen: string;
  scanCount: number;
  storesAffected: number;
  suspectedReason: string;
  reasonDirection: 'inbound' | 'outbound' | null;
  status: string;
  owner: string | null;
}

export class CatalogueGapRegisterConnector extends BaseConnector<GapRegisterRow, GapRegisterRow> {
  readonly id = 'catalogue-gap-register';
  readonly displayName = 'Catalogue gap register (derived)';
  // Derived from two marts that are themselves on 48h and 30h SLAs. Anything
  // tighter would mark this stale while it is faithfully reflecting inputs
  // that have not moved.
  readonly freshnessSlaMinutes = 48 * 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P0' as const;
  readonly powers = [
    'fact_catalogue_gap',
    '/catalogue missing-EAN register',
    'gap reasons (§20.3)',
    'missing-EAN aging',
    'missing_distinct / missing_new / missing_age_p50 (§5.3)',
  ];
  readonly blockedBy =
    'DATABASE_URL — derived in Postgres from fact_scan_daily × dim_product, so it needs no credential of its own';

  isConfigured(): boolean {
    return getDb() != null;
  }

  /**
   * Failed scans in the window, grouped to one row per EAN, classified against
   * the product master.
   *
   * `firstSeen` reaches back past the window on purpose: the aging clock is the
   * whole point of the register (§4.5 — "a miss that is 30 days old is an
   * ownership failure, not a data issue"), and recomputing it from a 3-day
   * window would reset every gap's age to zero every night.
   */
  protected async extract(w: DateWindow): Promise<GapRegisterRow[]> {
    const db = getDb();
    if (!db) return [];

    const { factScanDaily, dimProduct, factCatalogueGap } = await import('@/lib/db/schema');
    const { and, eq, gte, lte, sql } = await import('drizzle-orm');

    const failed = await db
      .select({
        ean: factScanDaily.ean,
        firstSeen: sql<string>`MIN(${factScanDaily.dateKey})`,
        lastSeen: sql<string>`MAX(${factScanDaily.dateKey})`,
        scanCount: sql<number>`SUM(${factScanDaily.scanCount})`,
        storesAffected: sql<number>`COUNT(DISTINCT ${factScanDaily.storeId})`,
      })
      .from(factScanDaily)
      .where(
        and(
          eq(factScanDaily.result, 'not_found'),
          gte(factScanDaily.dateKey, w.start),
          lte(factScanDaily.dateKey, w.end),
        ),
      )
      .groupBy(factScanDaily.ean);

    if (failed.length === 0) return [];

    const products = await db
      .select({
        itemCode: dimProduct.itemCode,
        ean: dimProduct.ean,
        category: dimProduct.category,
        isActive: dimProduct.isActive,
      })
      .from(dimProduct);

    const master = buildMasterIndex(
      products.map((p) => ({
        itemCode: p.itemCode,
        ean: p.ean,
        name: '',
        brand: '',
        category: p.category,
        categoryMapped: p.category != null,
        isActive: p.isActive ?? true,
      })) as ProductRow[],
    );

    // Existing rows carry the human columns and the original first-seen date.
    const existing = new Map(
      (
        await db
          .select({
            ean: factCatalogueGap.ean,
            firstSeen: factCatalogueGap.firstSeen,
            status: factCatalogueGap.status,
            owner: factCatalogueGap.owner,
          })
          .from(factCatalogueGap)
      ).map((r) => [r.ean, r]),
    );

    return failed.map((f) => {
      const prior = existing.get(f.ean);
      const { reason, direction } = classifyGap(f.ean, master);
      return {
        ean: f.ean,
        // The earlier of the two, so the aging clock survives a narrow re-run.
        firstSeen: prior && prior.firstSeen < f.firstSeen ? prior.firstSeen : f.firstSeen,
        lastSeen: f.lastSeen,
        scanCount: Number(f.scanCount ?? 0),
        storesAffected: Number(f.storesAffected ?? 0),
        suspectedReason: reason,
        reasonDirection: direction,
        // Never re-derived. A human set these, and the pipeline cannot know
        // better than they do.
        status: prior?.status ?? 'new',
        owner: prior?.owner ?? null,
      };
    });
  }

  protected transform(rows: GapRegisterRow[]): GapRegisterRow[] {
    return rows;
  }

  protected async load(rows: GapRegisterRow[]): Promise<LoadResult> {
    const { factCatalogueGap } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_catalogue_gap' };

    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(factCatalogueGap)
        .values(rows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: factCatalogueGap.ean,
          set: {
            // Only the derived columns. `status` and `owner` are absent from
            // this list deliberately — a nightly run must not clear the
            // assignment somebody made this morning.
            lastSeen: sql`excluded.last_seen`,
            scanCount: sql`excluded.scan_count`,
            storesAffected: sql`excluded.stores_affected`,
            suspectedReason: sql`excluded.suspected_reason`,
            reasonDirection: sql`excluded.reason_direction`,
            updatedAt: new Date(),
          },
        });
    }
    return { rowsIngested: rows.length, table: 'fact_catalogue_gap' };
  }

  protected fixture(w: DateWindow): GapRegisterRow[] {
    return fixtureGaps(w).map((g) => ({
      ean: g.ean,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      scanCount: g.scanCount,
      storesAffected: g.storesAffected,
      suspectedReason: g.suspectedReason,
      reasonDirection: g.reasonDirection,
      status: g.status,
      owner: g.owner,
    }));
  }

  readonly assertions: Assertion<GapRegisterRow>[] = [
    // Not `zeroIsFail`: an empty register genuinely means every scan resolved,
    // which is the outcome the whole catalogue programme is trying to reach.
    // Failing on success would be perverse.
    rowVolume<GapRegisterRow>({ tolerance: 0.6, zeroIsFail: false }),
    nullRate<GapRegisterRow>({ columns: ['ean', 'firstSeen', 'lastSeen'], max: 0, level: 'fail' }),
    valueSet<GapRegisterRow>({
      column: 'reasonDirection',
      allowed: ['inbound', 'outbound'],
      level: 'warn',
    }),
    // §20.3 — the taxonomy is the contract. A reason outside it means the
    // classifier and the UI have drifted apart, and the breakdown on
    // `/catalogue` would silently stop adding up.
    valueSet<GapRegisterRow>({
      column: 'suspectedReason',
      allowed: [
        'absent_from_master',
        'category_not_mapped',
        'item_inactive',
        'ean_assigned_to_multiple_item_codes',
        'present_investigate',
        'store_inventory_mismatch',
        'unknown',
      ],
      level: 'warn',
    }),
  ];
}

export const catalogueGapRegister = new CatalogueGapRegisterConnector();
