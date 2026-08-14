'use server';

/**
 * §4.9 — running a connector from the page.
 *
 * A server action rather than a fetch to `/api/cron/[connector]`, because that
 * route is protected by `CRON_SECRET` and the only way to call it from the
 * browser would be to ship the secret to the browser. The action runs on the
 * server with the session already resolved, so nothing has to be handed out.
 *
 * The button is the reason the rest of `/connectors` is usable: a NOC engineer
 * who sees a red connector at 09:05 needs to retry it and watch the outcome,
 * not file a ticket asking someone to redeploy.
 */
import { revalidatePath } from 'next/cache';
import { getConnector } from '@/lib/connectors/registry';
import { runDoctor } from '@/lib/connectors/doctor';
import { tick, windowFor } from '@/lib/connectors/scheduler';
import { canEdit, getSessionUser } from '@/lib/auth';

export interface RefreshOutcome {
  ok: boolean;
  connector: string;
  message: string;
  rows?: number;
  source?: string;
  warnings?: string[];
  durationMs?: number;
}

/**
 * Force-runs one connector, bypassing the SLA check but never the concurrency
 * guard — a manual retry while a scheduled run is mid-flight is exactly the
 * double-write the guard exists to prevent.
 */
export async function refreshConnector(id: string): Promise<RefreshOutcome> {
  const user = getSessionUser();
  // Deliberately a capability check rather than a role check: §9.4 gives `exec`
  // read-only access, and a metered BigQuery scan is a write-shaped action.
  if (!canEdit(user.role, 'thresholds')) {
    return { ok: false, connector: id, message: `Your role (${user.role}) cannot trigger a connector run.` };
  }

  const connector = getConnector(id);
  if (!connector) return { ok: false, connector: id, message: `Unknown connector "${id}".` };

  if (!connector.isConfigured()) {
    return {
      ok: false,
      connector: id,
      message:
        connector.descriptor().blockedBy ??
        'Not configured — add its credentials before running it. See /connectors/setup.',
    };
  }

  const result = await tick({ only: [id], force: true, window: windowFor(id) });

  const skipped = result.skipped.find((s) => s.id === id);
  if (skipped?.reason === 'already_running') {
    return { ok: false, connector: id, message: 'Already running — wait for the current run to finish.' };
  }

  const run = result.ran.find((r) => r.id === id);
  if (!run) return { ok: false, connector: id, message: 'The run did not start. Check the run log.' };

  revalidatePath('/connectors');
  return {
    ok: run.ok,
    connector: id,
    rows: run.rows,
    source: run.source,
    warnings: run.warnings,
    durationMs: run.ms,
    message: run.ok
      ? `${run.rows.toLocaleString('en-IN')} rows ingested from ${run.source} in ${(run.ms / 1000).toFixed(1)}s.`
      : `Run failed — the mart was left on its last good snapshot. ${run.warnings.join(' ')}`,
  };
}

/** Runs everything that is due right now, the same way the heartbeat does. */
export async function refreshAllDue(): Promise<{ ok: boolean; message: string }> {
  const user = getSessionUser();
  if (!canEdit(user.role, 'thresholds')) {
    return { ok: false, message: `Your role (${user.role}) cannot trigger a connector run.` };
  }

  const result = await tick();
  revalidatePath('/connectors');

  if (result.ran.length === 0) {
    const blocked = result.skipped.filter((s) => s.reason === 'not_configured').length;
    return {
      ok: true,
      message: `Nothing was due. ${result.skipped.length - blocked} within SLA, ${blocked} not configured.`,
    };
  }
  const failed = result.ran.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    message: `Ran ${result.ran.length} connector${result.ran.length === 1 ? '' : 's'} in ${(result.durationMs / 1000).toFixed(1)}s${
      failed.length ? `, ${failed.length} failed: ${failed.map((f) => f.id).join(', ')}` : ''
    }${result.truncated ? ' (budget reached — the rest run on the next tick)' : ''}.`,
  };
}

/**
 * §14.4 — the preflight.
 *
 * Proves each hop separately (credentials parse, token exchange, dataset
 * reachable, query runs) so a failure names the hop instead of saying
 * "connector down" — which is the difference between a five-minute fix and an
 * afternoon of guessing.
 */
export async function checkConnections() {
  const user = getSessionUser();
  if (!canEdit(user.role, 'thresholds')) return null;
  return runDoctor();
}
