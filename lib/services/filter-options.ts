/**
 * The values the filter bar offers, drawn from the store dimension.
 *
 * Enumerated rather than free-text because a store code typed from memory is
 * usually wrong — §19.3 leading zeros mean `421` and `00421` look the same to a
 * human and are different keys to the warehouse. The dropdown makes the wrong
 * one unreachable.
 */
import { getStores } from '@/lib/data/repository';

export interface FilterOptions {
  stores: Array<{ value: string; label: string }>;
  cities: string[];
  states: string[];
}

export async function getFilterOptions(): Promise<FilterOptions> {
  const stores = await getStores();
  const live = stores.rows.filter((s) => s.companionLive);

  return {
    // Keyed by store code, which is what the NOC says out loud and what the
    // shared link should carry.
    stores: live
      .map((s) => ({ value: s.storeCode, label: `${s.storeCode} · ${s.storeName}` }))
      .sort((a, b) => a.value.localeCompare(b.value)),
    cities: [...new Set(live.map((s) => s.city).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    states: [...new Set(live.map((s) => s.state).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
  };
}
