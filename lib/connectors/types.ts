/**
 * §6.2 — The connector contract.
 *
 * Every connector implements this interface. No exceptions — it is what makes
 * `/connectors`, the fixture fallback, the assertion gate, and the run log
 * cohere.
 */
import type { DateWindow } from '@/lib/format/dates';

export type DataSourceState = 'live' | 'cache' | 'fixture' | 'stale' | 'missing' | 'not_instrumented';

export interface ConnectorMeta {
  connector: string;
  fetchedAt: string; // ISO
  windowStart: string;
  windowEnd: string;
  rowCount: number;
  bytesScanned?: number;
  source: 'live' | 'cache' | 'fixture';
  warnings: string[];
}

export interface ConnectorError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ConnectorResult<T> {
  ok: boolean;
  rows: T[];
  meta: ConnectorMeta;
  error?: ConnectorError;
  assertions?: AssertionVerdict[];
}

export type AssertionLevel = 'pass' | 'warn' | 'fail';

export interface AssertionVerdict {
  id: string;
  level: AssertionLevel;
  message: string;
  observed?: number | string | null;
  expected?: number | string | null;
}

export interface AssertionContext {
  connector: string;
  window: DateWindow;
  /** Trailing history for volume comparisons, newest last. */
  trailingRowCounts?: number[];
}

export interface Assertion<T> {
  id: string;
  /** `fail` blocks the load and keeps serving the last good snapshot (§6.3). */
  level: Exclude<AssertionLevel, 'pass'>;
  run(rows: T[], ctx: AssertionContext): Promise<AssertionVerdict> | AssertionVerdict;
}

export interface LoadResult {
  rowsIngested: number;
  table: string;
}

export type CostTier = 'free' | 'metered' | 'expensive';

export interface ConnectorDescriptor {
  id: string;
  displayName: string;
  /** §6.2 build priority. */
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  freshnessSlaMinutes: number;
  costTier: CostTier;
  /** What this connector powers, for the lineage view on `/connectors` (§4.9). */
  powers: string[];
  /** Human-readable blocker from §13, when not configured. */
  blockedBy?: string;
  configured: boolean;
}

export interface ConnectorStatus extends ConnectorDescriptor {
  lastRunAt: string | null;
  lastStatus: 'success' | 'warn' | 'fail' | 'never';
  rowsIngested: number | null;
  freshnessMinutes: number | null;
  withinSla: boolean;
  lastError: string | null;
  assertions: AssertionVerdict[];
  health: 'green' | 'amber' | 'red' | 'grey';
}
