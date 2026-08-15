/**
 * Store dimension fixtures (§19).
 *
 * 272 Companion-live stores of 1,765 Trends stores — the ~15% activation from
 * §1. Store codes carry leading zeros deliberately: they are the exact shape
 * that breaks joins when some layer treats them as numeric (§19.3).
 */
import { BUSINESS_BASELINE } from './baselines';
import { hashSeed, makeRng } from './rng';

export interface FixtureStore {
  storeId: string;
  storeCode: string;
  storeName: string;
  city: string;
  state: string;
  region: string;
  tenant: string;
  companionLive: boolean;
  activatedOn: string | null;
  /**
   * Null where the store master has no location. §4.4's map reports those
   * rather than plotting them at 0,0 — which is the Atlantic, not Gujarat.
   */
  lat: number | null;
  lon: number | null;
}

const CITIES: Array<[string, string, string, number, number]> = [
  ['Mumbai', 'Maharashtra', 'West', 19.076, 72.8777],
  ['Delhi', 'Delhi', 'North', 28.6139, 77.209],
  ['Bengaluru', 'Karnataka', 'South', 12.9716, 77.5946],
  ['Hyderabad', 'Telangana', 'South', 17.385, 78.4867],
  ['Ahmedabad', 'Gujarat', 'West', 23.0225, 72.5714],
  ['Chennai', 'Tamil Nadu', 'South', 13.0827, 80.2707],
  ['Kolkata', 'West Bengal', 'East', 22.5726, 88.3639],
  ['Pune', 'Maharashtra', 'West', 18.5204, 73.8567],
  ['Jaipur', 'Rajasthan', 'North', 26.9124, 75.7873],
  ['Lucknow', 'Uttar Pradesh', 'North', 26.8467, 80.9462],
  ['Surat', 'Gujarat', 'West', 21.1702, 72.8311],
  ['Kanpur', 'Uttar Pradesh', 'North', 26.4499, 80.3319],
  ['Nagpur', 'Maharashtra', 'West', 21.1458, 79.0882],
  ['Indore', 'Madhya Pradesh', 'Central', 22.7196, 75.8577],
  ['Bhopal', 'Madhya Pradesh', 'Central', 23.2599, 77.4126],
  ['Patna', 'Bihar', 'East', 25.5941, 85.1376],
  ['Vadodara', 'Gujarat', 'West', 22.3072, 73.1812],
  ['Coimbatore', 'Tamil Nadu', 'South', 11.0168, 76.9558],
  ['Kochi', 'Kerala', 'South', 9.9312, 76.2673],
  ['Chandigarh', 'Chandigarh', 'North', 30.7333, 76.7794],
  ['Guwahati', 'Assam', 'East', 26.1445, 91.7362],
  ['Faridabad', 'Haryana', 'North', 28.4089, 77.3178],
  ['Gurugram', 'Haryana', 'North', 28.4595, 77.0266],
  ['Visakhapatnam', 'Andhra Pradesh', 'South', 17.6868, 83.2185],
];

const MALL_WORDS = [
  'Central Mall',
  'City Centre',
  'High Street',
  'Phoenix Mall',
  'Grand Plaza',
  'Metro Junction',
  'Forum Mall',
  'Ambience Mall',
  'Crown Interior Mall',
  'Elante',
  'Nexus Mall',
  'Main Road',
];

function buildStores(): FixtureStore[] {
  const rng = makeRng(hashSeed('companion-stores-v1'));
  const total = BUSINESS_BASELINE.totalTrendsStores;
  const live = BUSINESS_BASELINE.storesOnboarded;
  const stores: FixtureStore[] = [];

  for (let i = 0; i < total; i++) {
    const [city, state, region, lat, lon] = CITIES[i % CITIES.length];
    const mall = MALL_WORDS[Math.floor(rng() * MALL_WORDS.length)];
    // Platform store id, and a retail store code with a leading zero — the
    // shape that silently drops rows when treated as a number (§19.3).
    const storeId = String(600 + i);
    const storeCode = String(i + 1).padStart(5, '0');
    const isLive = i < live;
    // Activation ramp across Feb–Aug 2026.
    const activatedOn = isLive
      ? new Date(Date.UTC(2026, 1, 1) + Math.floor((i / live) * 190) * 86_400_000)
          .toISOString()
          .slice(0, 10)
      : null;
    stores.push({
      storeId,
      storeCode,
      storeName: `Trends, ${mall} ${city}`,
      city,
      state,
      region,
      tenant: 'trends',
      companionLive: isLive,
      activatedOn,
      lat: Number((lat + (rng() - 0.5) * 0.28).toFixed(6)),
      lon: Number((lon + (rng() - 0.5) * 0.28).toFixed(6)),
    });
  }
  return stores;
}

export const FIXTURE_STORES: FixtureStore[] = buildStores();
export const FIXTURE_LIVE_STORES = FIXTURE_STORES.filter((s) => s.companionLive);

/** §4.4 — operational state that is manual-entry or externally sourced. */
export interface FixtureStoreOps {
  storeId: string;
  qrVmPlaced: boolean | null;
  qrVmVerifiedOn: string | null;
  staffTrained: boolean | null;
  footfallDaily: number | null;
  billsDaily: number | null;
  nocOwner: string | null;
}

const NOC_OWNERS = ['NOC — North', 'NOC — West', 'NOC — South', 'NOC — East'];

export const FIXTURE_STORE_OPS: FixtureStoreOps[] = FIXTURE_LIVE_STORES.map((s) => {
  const rng = makeRng(hashSeed(`ops:${s.storeId}`));
  const known = rng();
  return {
    storeId: s.storeId,
    // A third of stores genuinely have no QR/VM record — that is a real gap and
    // renders as "unknown", never as false.
    qrVmPlaced: known < 0.33 ? null : rng() < 0.72,
    qrVmVerifiedOn: known < 0.33 ? null : '2026-07-' + String(1 + Math.floor(rng() * 28)).padStart(2, '0'),
    staffTrained: known < 0.28 ? null : rng() < 0.66,
    footfallDaily: known < 0.4 ? null : 120 + Math.floor(rng() * 900),
    billsDaily: known < 0.4 ? null : 30 + Math.floor(rng() * 260),
    nocOwner: NOC_OWNERS[Math.floor(rng() * NOC_OWNERS.length)],
  };
});
