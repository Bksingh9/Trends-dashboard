/**
 * The real numbers from §1 and §18.7. Fixtures are shaped to reproduce these,
 * and Phase 1/2 acceptance tests reconcile the pipeline against them.
 *
 * "If your pipeline can't reproduce them for the same window, the pipeline is
 * wrong — not the baseline." (§1)
 */

/** §1 — internal reporting, Apr–May 2026. Historical baseline, not live truth. */
export const BUSINESS_BASELINE = {
  trailing28dOrders: 1360,
  trailing28dEgmvLow: 1_000_000, // ₹10 L
  trailing28dEgmvHigh: 1_200_000, // ₹12 L
  activeUsers: 41_500,
  storesOnboarded: 272,
  totalTrendsStores: 1765,
  revenueApril: 329_000, // ₹3.29 L
  revenueMayMtd: 707_000, // ₹7.07 L
  hostAppVersion: 'AJIO 9.44',
  androidSdk: '1.3.6',
  iosSdk: '1.2.9',
} as const;

/** Derived, and the number to sanity-check any revenue mapping against (A2). */
export const BASELINE_AOV = 11_00_000 / BUSINESS_BASELINE.trailing28dOrders; // ≈ ₹809

/**
 * §18.7 — the catalogue backfill acceptance test. The ingested series must
 * reproduce these for 30 Jul – 12 Aug 2026 or the parser is wrong.
 */
export const CATALOGUE_BASELINE = {
  windowStart: '2026-07-30',
  windowEnd: '2026-08-12',
  uniqueScans: 41_628,
  distinctMissing: 2_510,
  /** (41628 − 2510) / 41628 = 0.93971 */
  uniqueCoverage: 0.9397,
  dailyCoverageMin: 0.885,
  dailyCoverageMax: 0.967,
} as const;

/**
 * §2.8 — store visit audits. These are *manual shelf samples* and run far worse
 * than the ~94% scan-observed aggregate, because customers mostly scan items
 * that work while an auditor scans at random. Never present the two as the same
 * metric (§16.5.2).
 */
export const STORE_VISIT_AUDITS = [
  {
    visitDate: '2026-07-23',
    storeLabel: 'Trends, Ambience Mall Vasant Kunj',
    itemsScanned: 20,
    itemsFailed: 10,
    failedEans: ['8905121688019', '8905121694607', '8905893933119', '8905893496771'],
  },
  {
    visitDate: '2026-07-01',
    storeLabel: 'Trends, Crown Interior Mall Faridabad',
    itemsScanned: 24,
    itemsFailed: 10,
    failedEans: ['8909476118948', '8909477811794', '8905121698728', '8909476165614'],
  },
  {
    visitDate: '2026-07-15',
    storeLabel: 'Trends, Ambience Gurugram',
    itemsScanned: 17,
    itemsFailed: 10,
    failedEans: [],
  },
  {
    visitDate: '2026-07-08',
    storeLabel: 'Trends, Andheri (store 9626)',
    itemsScanned: 125,
    itemsFailed: 37, // 29.6% gap
    failedEans: [],
  },
] as const;

/** §2.8 — the test EAN registry. Seeds `dim_test_ean` and the canary job. */
export const TEST_EANS = [
  { ean: '8905863997257', expectedResult: 'found', feature: 'scan_and_go', source: 'slack_verified' },
  { ean: '8909391926840', expectedResult: 'found', feature: 'scan_and_go', source: 'slack_verified' },
  { ean: '8909393021680', expectedResult: 'found', feature: 'size_finder', source: 'slack_verified' },
  { ean: '8905527894113', expectedResult: 'found', feature: 'size_finder', source: 'slack_verified' },
  {
    ean: '8905121688019',
    expectedResult: 'not_found',
    feature: null,
    source: 'store_visit',
    sourceNote: 'Trends, Ambience Mall Vasant Kunj — 23 Jul 2026',
  },
  {
    ean: '8905121694607',
    expectedResult: 'not_found',
    feature: null,
    source: 'store_visit',
    sourceNote: 'Trends, Ambience Mall Vasant Kunj — 23 Jul 2026',
  },
  {
    ean: '8905893933119',
    expectedResult: 'not_found',
    feature: null,
    source: 'store_visit',
    sourceNote: 'Trends, Ambience Mall Vasant Kunj — 23 Jul 2026',
  },
  {
    ean: '8905893496771',
    expectedResult: 'not_found',
    feature: null,
    source: 'store_visit',
    sourceNote: 'Trends, Ambience Mall Vasant Kunj — 23 Jul 2026',
  },
  {
    ean: '8909476118948',
    expectedResult: 'not_found',
    feature: null,
    source: 'store_visit',
    sourceNote: 'Trends, Crown Interior Mall Faridabad — 1 Jul 2026',
  },
  {
    ean: '8909477811794',
    expectedResult: 'not_found',
    feature: null,
    source: 'store_visit',
    sourceNote: 'Trends, Crown Interior Mall Faridabad — 1 Jul 2026',
  },
  {
    ean: '8905121698728',
    expectedResult: 'not_found',
    feature: null,
    source: 'store_visit',
    sourceNote: 'Trends, Crown Interior Mall Faridabad — 1 Jul 2026',
  },
  {
    ean: '8909476165614',
    expectedResult: 'not_found',
    feature: null,
    source: 'store_visit',
    sourceNote: 'Trends, Crown Interior Mall Faridabad — 1 Jul 2026',
  },
] as const;

/** §18.3 — known unreachable via Slack pagination. Rendered as a hatched gap. */
export const UNREACHABLE_REPORT_DAYS = ['2026-07-27', '2026-07-28', '2026-07-29'] as const;

/** §5.5 — gap reason taxonomy seed values. */
export const GAP_REASONS = [
  {
    reason: 'category_not_mapped',
    label: 'Category not mapped',
    direction: 'inbound',
    knownFrequency: 'Very high',
    sortOrder: 1,
  },
  {
    reason: 'ean_assigned_to_multiple_item_codes',
    label: 'EAN/barcode already assigned to another item code',
    direction: 'outbound',
    knownFrequency: 'Very high',
    sortOrder: 2,
  },
  {
    reason: 'absent_from_master',
    label: 'Item not in catalogue master',
    direction: 'inbound',
    knownFrequency: null,
    sortOrder: 3,
  },
  {
    reason: 'item_inactive',
    label: 'Item inactive / delisted',
    direction: 'outbound',
    knownFrequency: null,
    sortOrder: 4,
  },
  {
    reason: 'store_inventory_mismatch',
    label: 'Store-specific inventory mismatch',
    direction: 'outbound',
    knownFrequency: null,
    sortOrder: 5,
  },
  { reason: 'unknown', label: 'Unknown', direction: null, knownFrequency: 'Residual bucket', sortOrder: 99 },
] as const;

/** §4.7 — the ten known workstreams. Loyalty is present but disabled (§0). */
export const WORKSTREAMS = [
  'Payments & Coupons',
  'UI/UX',
  'De-tag',
  'Store Ops',
  'Analytics & Insights',
  'Location & Geofencing',
  'Security',
  'Platform & Infra',
  'QA & Automation',
  'Scan & Catalogue',
] as const;
