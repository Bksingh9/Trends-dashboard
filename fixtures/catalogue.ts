/**
 * Catalogue fixtures, generated at EAN level so every derived number is
 * internally consistent: daily coverage, window coverage, the missing-EAN
 * register, and store-level coverage all come from one synthetic scan table
 * rather than from separately invented aggregates.
 *
 * Constructed to reproduce the §18.7 baseline exactly for
 * 30 Jul – 12 Aug 2026: 41,628 unique scans, 2,510 distinct missing,
 * 94.0% unique coverage.
 */
import { CATALOGUE_BASELINE, TEST_EANS, UNREACHABLE_REPORT_DAYS } from './baselines';
import { hashSeed, makeRng } from './rng';
import { dateRange, daysBetween, isWeekend, type DateWindow } from '@/lib/format/dates';
import { FIXTURE_STORES } from './stores';

export interface ScanRow {
  dateKey: string;
  storeId: string;
  ean: string;
  result: 'found' | 'not_found';
  platform: 'Android' | 'iOS';
  salesChannel: string;
  scanCount: number;
  sessionCount: number;
}

const BASE = CATALOGUE_BASELINE;
const WINDOW_DAYS = 14;

/** A valid 13-digit EAN derived from an index — GS1 India prefixes (890…). */
function synthEan(i: number): string {
  const prefixes = ['890', '891', '899'];
  const p = prefixes[i % prefixes.length];
  const body = String(1_000_000_000 + ((i * 2_654_435_761) % 9_000_000_000)).slice(0, 10);
  return `${p}${body}`.slice(0, 13);
}

interface Universe {
  eans: string[];
  missing: Set<string>;
  /** ean → sorted list of day indices (0-based into the baseline window) */
  dayIndex: Map<string, number[]>;
  dayWeights: number[];
}

let cachedUniverse: Universe | null = null;

/**
 * The EAN universe for the baseline window. Built once per process — 41,628
 * EANs with day assignments is a few MB and rebuilding it per request would
 * make the fixture path slower than the real one.
 */
function universe(): Universe {
  if (cachedUniverse) return cachedUniverse;
  const rng = makeRng(hashSeed('companion-catalogue-v1'));

  const eans: string[] = [];
  const seen = new Set<string>();
  // Seed the known test EANs first so `/reference` and the canary have real data.
  for (const t of TEST_EANS) {
    eans.push(t.ean);
    seen.add(t.ean);
  }
  for (let i = 0; eans.length < BASE.uniqueScans; i++) {
    const e = synthEan(i);
    if (seen.has(e)) continue;
    seen.add(e);
    eans.push(e);
  }

  // Missing set: the eight store-visit EANs are known-bad and must be in it.
  const missing = new Set<string>(
    TEST_EANS.filter((t) => t.expectedResult === 'not_found').map((t) => t.ean),
  );
  // Fill the rest deterministically, skipping the known-good canaries.
  const known = new Set<string>(TEST_EANS.map((t) => t.ean));
  let cursor = 0;
  while (missing.size < BASE.distinctMissing) {
    const e = eans[(cursor * 7919) % eans.length];
    cursor++;
    if (!known.has(e)) missing.add(e);
    if (cursor > eans.length * 4) break; // safety
  }

  // Daily traffic weights, weekday-seasonal (retail peaks Fri–Sun).
  const days = dateRange({ start: BASE.windowStart, end: BASE.windowEnd });
  const dayWeights = days.map((d) => (isWeekend(d) ? 1.32 : 0.92) + rng() * 0.12);
  const weightSum = dayWeights.reduce((a, b) => a + b, 0);

  // Assign each EAN a first-seen day proportional to traffic, then extra
  // appearances so the repeat factor looks like real scan behaviour.
  const dayIndex = new Map<string, number[]>();
  const cum: number[] = [];
  let acc = 0;
  for (const w of dayWeights) {
    acc += w / weightSum;
    cum.push(acc);
  }
  const pickDay = (r: number) => {
    for (let i = 0; i < cum.length; i++) if (r <= cum[i]) return i;
    return cum.length - 1;
  };

  for (const ean of eans) {
    const isMissing = missing.has(ean);
    // Missing EANs cluster onto specific days (a bad stock drop lands together),
    // which is what makes daily coverage swing between 88.5% and 96.7% rather
    // than sitting flat at the window average.
    const r = rng();
    const first = isMissing ? pickDay((r * 0.55 + Math.floor(r * 4) * 0.25) % 1) : pickDay(r);
    const daysSet = new Set<number>([first]);
    const repeats = rng() < 0.42 ? (rng() < 0.28 ? 2 : 1) : 0;
    for (let k = 0; k < repeats; k++) {
      const extra = Math.min(WINDOW_DAYS - 1, first + 1 + Math.floor(rng() * 5));
      daysSet.add(extra);
    }
    dayIndex.set(ean, [...daysSet].sort((a, b) => a - b));
  }

  cachedUniverse = { eans, missing, dayIndex, dayWeights };
  return cachedUniverse;
}

/**
 * Map an arbitrary date onto the baseline window, so any window has data.
 *
 * Offset-based rather than hash-based on purpose: the 14 days of the baseline
 * window must map one-to-one onto the 14 day-buckets, or hash collisions drop
 * whole buckets and the distinct-EAN total lands short of 41,628.
 */
function baselineDayFor(dateKey: string): number {
  const offset = daysBetween(BASE.windowStart, dateKey);
  return ((offset % WINDOW_DAYS) + WINDOW_DAYS) % WINDOW_DAYS;
}

let cachedScansByDay: Map<number, { found: string[]; notFound: string[] }> | null = null;

function scansByDay() {
  if (cachedScansByDay) return cachedScansByDay;
  const u = universe();
  const m = new Map<number, { found: string[]; notFound: string[] }>();
  for (let d = 0; d < WINDOW_DAYS; d++) m.set(d, { found: [], notFound: [] });
  for (const [ean, days] of u.dayIndex) {
    const bucket = u.missing.has(ean) ? 'notFound' : 'found';
    for (const d of days) m.get(d)![bucket].push(ean);
  }
  cachedScansByDay = m;
  return m;
}

/** EAN-level scan rows for a window — the source of every catalogue number. */
export function fixtureScanRows(window: DateWindow): ScanRow[] {
  const byDay = scansByDay();
  const out: ScanRow[] = [];
  const liveStores = FIXTURE_STORES.filter((s) => s.companionLive);

  for (const dateKey of dateRange(window)) {
    const d = baselineDayFor(dateKey);
    const day = byDay.get(d)!;
    const rng = makeRng(hashSeed(`scan:${dateKey}`));
    for (const [result, eans] of [
      ['found', day.found],
      ['not_found', day.notFound],
    ] as const) {
      for (const ean of eans) {
        const store = liveStores[Math.floor(rng() * liveStores.length)];
        const scanCount = result === 'not_found' ? 1 + Math.floor(rng() * 3) : 1 + Math.floor(rng() * 5);
        out.push({
          dateKey,
          storeId: store.storeId,
          ean,
          result,
          platform: rng() < 0.78 ? 'Android' : 'iOS',
          salesChannel: 'trends_companion',
          scanCount,
          sessionCount: Math.max(1, Math.round(scanCount * 0.7)),
        });
      }
    }
  }
  return out;
}

export interface CatalogueDailyRow {
  dateKey: string;
  totalScans: number;
  totalFailed: number;
  uniqueScans: number;
  uniqueFailed: number;
  uniqueCoverage: number;
  totalCoverage: number;
  botStatedPct: number | null;
  /** null = unreachable via Slack pagination (§18.3), not "no report". */
  reportGenerated: boolean | null;
  source: 'slack_bot' | 'ga4_bq' | 'unreachable';
}

/** Daily rows as the Tatsu bot would report them, derived from the scan rows. */
export function fixtureCatalogueDaily(window: DateWindow): CatalogueDailyRow[] {
  const rows = fixtureScanRows(window);
  const byDate = new Map<string, ScanRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.dateKey) ?? [];
    list.push(r);
    byDate.set(r.dateKey, list);
  }

  return dateRange(window).map((dateKey) => {
    if ((UNREACHABLE_REPORT_DAYS as readonly string[]).includes(dateKey)) {
      return {
        dateKey,
        totalScans: 0,
        totalFailed: 0,
        uniqueScans: 0,
        uniqueFailed: 0,
        uniqueCoverage: 0,
        totalCoverage: 0,
        botStatedPct: null,
        reportGenerated: null,
        source: 'unreachable' as const,
      };
    }
    const day = byDate.get(dateKey) ?? [];
    const totalScans = day.reduce((a, r) => a + r.scanCount, 0);
    const totalFailed = day.filter((r) => r.result === 'not_found').reduce((a, r) => a + r.scanCount, 0);
    const uniqueScans = new Set(day.map((r) => r.ean)).size;
    const uniqueFailed = new Set(day.filter((r) => r.result === 'not_found').map((r) => r.ean)).size;
    const uniqueCoverage = uniqueScans === 0 ? 0 : (uniqueScans - uniqueFailed) / uniqueScans;
    const totalCoverage = totalScans === 0 ? 0 : (totalScans - totalFailed) / totalScans;
    return {
      dateKey,
      totalScans,
      totalFailed,
      uniqueScans,
      uniqueFailed,
      uniqueCoverage,
      totalCoverage,
      // The bot states its own percentage; the reconcile assertion (§18.5)
      // compares our recomputation against it.
      botStatedPct: Number(uniqueCoverage.toFixed(4)),
      reportGenerated: true,
      source: 'slack_bot' as const,
    };
  });
}

export interface GapRow {
  ean: string;
  firstSeen: string;
  lastSeen: string;
  scanCount: number;
  storesAffected: number;
  suspectedReason: string;
  reasonDirection: 'inbound' | 'outbound' | null;
  status: 'new' | 'investigating' | 'fix-pending' | 'resolved' | 'wontfix';
  owner: string | null;
}

const REASON_MIX: Array<[string, 'inbound' | 'outbound', number]> = [
  ['category_not_mapped', 'inbound', 0.38],
  ['ean_assigned_to_multiple_item_codes', 'outbound', 0.31],
  ['absent_from_master', 'inbound', 0.14],
  ['item_inactive', 'outbound', 0.09],
  ['store_inventory_mismatch', 'outbound', 0.05],
  ['unknown', 'inbound', 0.03],
];

/** The missing-EAN register (§4.5), derived from the same scan rows. */
export function fixtureGaps(window: DateWindow): GapRow[] {
  const rows = fixtureScanRows(window).filter((r) => r.result === 'not_found');
  const byEan = new Map<string, ScanRow[]>();
  for (const r of rows) {
    const list = byEan.get(r.ean) ?? [];
    list.push(r);
    byEan.set(r.ean, list);
  }

  const owners = ['Ritu Raj', 'Bhagyesh P', 'Omkar G', null];
  const statuses: GapRow['status'][] = ['new', 'investigating', 'fix-pending', 'resolved', 'wontfix'];

  return [...byEan.entries()].map(([ean, rs]) => {
    const rng = makeRng(hashSeed(`gap:${ean}`));
    const dates = rs.map((r) => r.dateKey).sort();
    let acc = 0;
    const roll = rng();
    let reason = REASON_MIX[0];
    for (const r of REASON_MIX) {
      acc += r[2];
      if (roll <= acc) {
        reason = r;
        break;
      }
    }
    const statusRoll = rng();
    const status =
      statusRoll < 0.52
        ? 'new'
        : statusRoll < 0.74
          ? 'investigating'
          : statusRoll < 0.86
            ? 'fix-pending'
            : statusRoll < 0.96
              ? 'resolved'
              : 'wontfix';
    return {
      ean,
      firstSeen: dates[0],
      lastSeen: dates[dates.length - 1],
      scanCount: rs.reduce((a, r) => a + r.scanCount, 0),
      storesAffected: new Set(rs.map((r) => r.storeId)).size,
      suspectedReason: reason[0],
      reasonDirection: reason[1],
      status: statuses.includes(status) ? status : 'new',
      owner: owners[Math.floor(rng() * owners.length)],
    };
  });
}

/**
 * §16.5.1 — the junk that must be excluded from every count. Ritu Raj flagged
 * random URLs in the `ean` column on 17 Jun 2026.
 */
export const FIXTURE_RAW_SCAN_VALUES = [
  '8905863997257',
  '  8909391926840 ',
  "'8909393021680",
  'https://www.ajio.com/p/12345',
  'www.trends.in/item',
  'https://short.de/xY9',
  '0000000000000',
  '1111111111111',
  'SKU-ABC-123',
  '12345',
  '123456789012345678',
  '',
  '8905527894113',
] as const;

/**
 * §20.2 — the product master, as `dim_product` sees it.
 *
 * Derived from the same scan rows as everything else in this file, and that is
 * the whole point: the gap reasons on `/catalogue` are a *join* between what
 * customers scanned and what the master contains, so a product fixture invented
 * independently would make that join reconcile to nothing.
 *
 * The rules below encode the §20.3 reason taxonomy as data rather than as a
 * label, so the classifier is exercised against a master that genuinely has the
 * shape it claims:
 *
 *   found EAN                            → present, mapped, active
 *   absent_from_master                   → not present at all
 *   category_not_mapped                  → present with a null category
 *   ean_assigned_to_multiple_item_codes  → present twice under two item codes
 *   item_inactive                        → present but is_active = false
 *
 * Deliberately not 3 lakh rows. The real master is that size and the volume
 * would be noise; what matters here is that every branch of the classifier has
 * at least one real row to land on.
 */
export interface ProductMasterRow {
  itemCode: string;
  ean: string;
  name: string;
  brand: string;
  category: string | null;
  categoryMapped: boolean;
  isActive: boolean;
}

const BRANDS = ['Trends', 'Avaasa', 'Netplay', 'Performax', 'Fig', 'DNMX', 'Rio', 'Teamspirit'];
const CATEGORIES = ['Menswear', 'Womenswear', 'Kidswear', 'Footwear', 'Accessories', 'Innerwear'];

export function fixtureProductMaster(window: DateWindow): ProductMasterRow[] {
  const scans = fixtureScanRows(window);
  const gaps = new Map(fixtureGaps(window).map((g) => [g.ean, g]));

  // Every EAN the scan feed has ever seen is a candidate for the master. What
  // the master does with it is what distinguishes the reasons.
  const eans = [...new Set(scans.map((s) => s.ean))].sort();
  const out: ProductMasterRow[] = [];

  for (const ean of eans) {
    const gap = gaps.get(ean);
    const rng = makeRng(hashSeed(`product:${ean}`));
    const base = {
      ean,
      name: `Item ${ean.slice(-6)}`,
      brand: BRANDS[Math.floor(rng() * BRANDS.length)],
      category: CATEGORIES[Math.floor(rng() * CATEGORIES.length)] as string | null,
      categoryMapped: true,
      isActive: true,
    };

    // A successful scan is, by definition, an EAN the master resolves cleanly.
    if (!gap) {
      out.push({ ...base, itemCode: `ITM${hashSeed(`item:${ean}`) % 900_000 + 100_000}` });
      continue;
    }

    switch (gap.suspectedReason) {
      case 'absent_from_master':
        // The row simply does not exist. That absence is the finding.
        break;

      case 'category_not_mapped':
        out.push({
          ...base,
          itemCode: `ITM${hashSeed(`item:${ean}`) % 900_000 + 100_000}`,
          category: null,
          categoryMapped: false,
        });
        break;

      case 'ean_assigned_to_multiple_item_codes':
        // The outbound case the §20.2 duplicate-assignment subquery detects
        // mechanically. Two item codes, one EAN — so the join fans out and the
        // scan cannot resolve to a single product.
        out.push({ ...base, itemCode: `ITM${hashSeed(`item:${ean}`) % 900_000 + 100_000}` });
        out.push({ ...base, itemCode: `ITM${hashSeed(`dupe:${ean}`) % 900_000 + 100_000}` });
        break;

      case 'item_inactive':
        out.push({
          ...base,
          itemCode: `ITM${hashSeed(`item:${ean}`) % 900_000 + 100_000}`,
          isActive: false,
        });
        break;

      default:
        // store_inventory_mismatch and unknown are not master-side problems —
        // the row is fine, the failure is elsewhere.
        out.push({ ...base, itemCode: `ITM${hashSeed(`item:${ean}`) % 900_000 + 100_000}` });
    }
  }

  return out;
}
