/**
 * §7.8 `etl_run_log` access, with an in-memory fallback.
 *
 * Phase 0 runs without a database and `/connectors` must still render a real
 * registry. The in-memory log is process-local and clearly labelled as such —
 * it is never presented as durable history.
 */
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
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
      ephemeral: false,
    };
  }
  return memory.find((r) => r.connector === connector) ?? null;
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
