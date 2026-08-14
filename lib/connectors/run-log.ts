/**
 * §7.8 `etl_run_log` access, with an in-memory fallback.
 *
 * Phase 0 runs without a database and `/connectors` must still render a real
 * registry. The in-memory log is process-local and clearly labelled as such —
 * it is never presented as durable history.
 */
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { minutesSince } from '@/lib/format/dates';
import { etlRunLog } from '@/lib/db/schema';
import type { AssertionVerdict } from './types';

export interface RunRecord {
  runId: number;
  connector: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'warn' | 'fail';
  rowsIngested: number | null;
  bytesScanned: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  assertions: AssertionVerdict[];
  error: string | null;
  /** Rows came from fixtures, not the upstream source — never treat as live. */
  seeded: boolean;
  /** True when this record lives only in process memory (no DATABASE_URL). */
  ephemeral: boolean;
}

const memory: RunRecord[] = [];
let memoryId = 1;

export async function startRun(
  connector: string,
  window: { start: string; end: string },
): Promise<number> {
  const startedAt = new Date().toISOString();
  const db = getDb();
  if (db) {
    const [row] = await db
      .insert(etlRunLog)
      .values({
        connector,
        startedAt: new Date(startedAt),
        status: 'running',
        windowStart: new Date(`${window.start}T00:00:00+05:30`),
        windowEnd: new Date(`${window.end}T23:59:59+05:30`),
      })
      .returning({ runId: etlRunLog.runId });
    return row.runId;
  }
  const runId = memoryId++;
  memory.unshift({
    runId,
    connector,
    startedAt,
    finishedAt: null,
    status: 'running',
    rowsIngested: null,
    bytesScanned: null,
    windowStart: window.start,
    windowEnd: window.end,
    assertions: [],
    error: null,
    seeded: false,
    ephemeral: true,
  });
  return runId;
}

export async function finishRun(
  runId: number,
  outcome: {
    status: 'success' | 'warn' | 'fail';
    rowsIngested?: number;
    bytesScanned?: number;
    assertions?: AssertionVerdict[];
    error?: string;
    seeded?: boolean;
  },
): Promise<void> {
  const finishedAt = new Date();
  const db = getDb();
  if (db) {
    await db
      .update(etlRunLog)
      .set({
        finishedAt,
        status: outcome.status,
        rowsIngested: outcome.rowsIngested ?? null,
        bytesScanned: outcome.bytesScanned ?? null,
        assertions: outcome.assertions ?? [],
        error: outcome.error ?? null,
        seeded: outcome.seeded ?? false,
      })
      .where(eq(etlRunLog.runId, runId));
    return;
  }
  const rec = memory.find((r) => r.runId === runId);
  if (rec) {
    rec.finishedAt = finishedAt.toISOString();
    rec.status = outcome.status;
    rec.rowsIngested = outcome.rowsIngested ?? null;
    rec.bytesScanned = outcome.bytesScanned ?? null;
    rec.assertions = outcome.assertions ?? [];
    rec.error = outcome.error ?? null;
    rec.seeded = outcome.seeded ?? false;
  }
}

export async function lastRunFor(connector: string): Promise<RunRecord | null> {
  const db = getDb();
  if (db) {
    const rows = await db
      .select()
      .from(etlRunLog)
      .where(eq(etlRunLog.connector, connector))
      .orderBy(desc(etlRunLog.startedAt))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      runId: r.runId,
      connector: r.connector,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      status: r.status as RunRecord['status'],
      rowsIngested: r.rowsIngested,
      bytesScanned: r.bytesScanned,
      windowStart: r.windowStart?.toISOString() ?? null,
      windowEnd: r.windowEnd?.toISOString() ?? null,
      assertions: (r.assertions ?? []) as AssertionVerdict[],
      error: r.error,
      seeded: r.seeded ?? false,
      ephemeral: false,
    };
  }
  return memory.find((r) => r.connector === connector) ?? null;
}

/**
 * How long a `running` row is believed before it is treated as abandoned.
 *
 * A serverless invocation killed at its time limit never gets to write the
 * outcome, so the row stays `running` forever. Without an expiry that one
 * orphan blocks every future run of that connector — the scheduler would see
 * "already running" on every tick and the connector would go permanently stale
 * while the board showed no error at all.
 */
const RUNNING_STALE_MINUTES = 10;

/**
 * Is this connector mid-run right now?
 *
 * The concurrency guard exists because a double-write to the mart is the one
 * failure the assertion gate cannot catch: both writers produce valid rows, and
 * the result reconciles against nothing.
 */
export async function isRunning(connector: string): Promise<boolean> {
  const run = await lastRunFor(connector);
  if (!run || run.status !== 'running') return false;
  return minutesSince(run.startedAt) < RUNNING_STALE_MINUTES;
}

/** Orphaned `running` rows, so the UI can show them as abandoned rather than live. */
export async function abandonedRuns(): Promise<RunRecord[]> {
  return (await recentRuns(200)).filter(
    (r) => r.status === 'running' && minutesSince(r.startedAt) >= RUNNING_STALE_MINUTES,
  );
}

export async function recentRuns(limit = 50): Promise<RunRecord[]> {
  const db = getDb();
  if (db) {
    const rows = await db.select().from(etlRunLog).orderBy(desc(etlRunLog.startedAt)).limit(limit);
    return rows.map((r) => ({
      runId: r.runId,
      connector: r.connector,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      status: r.status as RunRecord['status'],
      rowsIngested: r.rowsIngested,
      bytesScanned: r.bytesScanned,
      windowStart: r.windowStart?.toISOString() ?? null,
      windowEnd: r.windowEnd?.toISOString() ?? null,
      assertions: (r.assertions ?? []) as AssertionVerdict[],
      error: r.error,
      seeded: r.seeded ?? false,
      ephemeral: false,
    }));
  }
  return memory.slice(0, limit);
}

/** Trailing row counts for the `rowVolume` assertion baseline. */
export async function trailingRowCounts(connector: string, days = 7): Promise<number[]> {
  const runs = (await recentRuns(200)).filter(
    (r) => r.connector === connector && r.status !== 'fail' && r.rowsIngested != null,
  );
  return runs.slice(0, days).map((r) => r.rowsIngested ?? 0);
}
