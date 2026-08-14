/**
 * Applying §9.3 filters to the data a module has fetched.
 *
 * The filters are resolved once, here, into a store-id allow-list and a
 * platform predicate. Doing it per-module invited exactly the bug COMMIT 1
 * fixed: a headline computed on one population and a breakdown on another.
 *
 * A filter that matches nothing is a real answer — "this store had no orders in
 * this window" — but it is indistinguishable on screen from "you typed a store
 * code that does not exist", so `resolveScope` reports which one it is and the
 * page says so.
 */
import { PLATFORM_VALUES, type Filters } from '@/lib/params/filters';
import type { DateWindow } from '@/lib/format/dates';

export interface StoreDimLike {
  storeId: string;
  storeCode: string;
  storeName: string;
  city: string;
  state: string;
}

export interface Scope {
  window: DateWindow;
  /** `null` means unfiltered — every store. An empty set means nothing matched. */
  storeIds: Set<string> | null;
  /** Warehouse spelling (`Android`), or undefined when unfiltered. */
  platform?: string;
  /** Human description of what is being looked at, for the page header. */
  description: string | null;
  warnings: string[];
}

/**
 * `store` matches a store code *or* a store id, because both appear in links
 * people share: the code is what the NOC says out loud, the id is what a
 * deep-link carries. Matching is case-insensitive on the code but never
 * numeric — §19.3, `00421` is not 421.
 */
export function resolveScope(filters: Filters, stores: StoreDimLike[]): Scope {
  const warnings: string[] = [];
  const parts: string[] = [];
  let matched = stores;

  if (filters.store) {
    const needle = filters.store.toLowerCase();
    matched = matched.filter(
      (s) => s.storeCode.toLowerCase() === needle || s.storeId.toLowerCase() === needle,
    );
    parts.push(matched[0] ? `${matched[0].storeName} (${matched[0].storeCode})` : `store ${filters.store}`);
    if (matched.length === 0) {
      warnings.push(
        `No store matches "${filters.store}" — check the store code, which keeps its leading zeros (§19.3).`,
      );
    }
  }

  if (filters.city) {
    const needle = filters.city.toLowerCase();
    const before = matched.length;
    matched = matched.filter((s) => s.city.toLowerCase() === needle);
    parts.push(filters.city);
    if (matched.length === 0 && before > 0) warnings.push(`No store is in "${filters.city}".`);
  }

  if (filters.state) {
    const needle = filters.state.toLowerCase();
    const before = matched.length;
    matched = matched.filter((s) => s.state.toLowerCase() === needle);
    parts.push(filters.state);
    if (matched.length === 0 && before > 0) warnings.push(`No store is in "${filters.state}".`);
  }

  const filtered = Boolean(filters.store || filters.city || filters.state);
  const platform = filters.platform ? PLATFORM_VALUES[filters.platform] : undefined;
  if (platform) parts.push(platform);

  return {
    window: filters.window,
    storeIds: filtered ? new Set(matched.map((s) => s.storeId)) : null,
    platform,
    description: parts.length ? parts.join(' · ') : null,
    warnings,
  };
}

/** Narrow any store-keyed row set to the scope. Unfiltered scopes pass through. */
export function scopeRows<T extends { storeId?: string }>(rows: T[], scope: Scope): T[] {
  if (!scope.storeIds) return rows;
  const ids = scope.storeIds;
  return rows.filter((r) => r.storeId != null && ids.has(r.storeId));
}

/** Narrow rows carrying a platform column. Rows without one are kept. */
export function scopePlatform<T extends { platform?: string }>(rows: T[], scope: Scope): T[] {
  if (!scope.platform) return rows;
  const want = scope.platform.toLowerCase();
  return rows.filter((r) => !r.platform || r.platform.toLowerCase() === want);
}

/** Store dimension rows in scope, for the denominators (`stores live`, etc.). */
export function scopeStores<T extends { storeId: string }>(stores: T[], scope: Scope): T[] {
  if (!scope.storeIds) return stores;
  const ids = scope.storeIds;
  return stores.filter((s) => ids.has(s.storeId));
}
