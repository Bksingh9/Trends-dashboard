/**
 * §18.6 / §20.3 — parsing the Daily Catalog Sync Report.
 *
 * Written against the verbatim messages in `fixtures/catalogue-report-samples`,
 * captured from `#sng-catalogue-lack` on 14 Aug 2026. The parser it replaces
 * looked for `totalScans`, `totalFailed`, `uniqueScans` and `uniqueFailed`,
 * none of which the report contains — it logged a parse failure for every
 * message and produced nothing, for every message ever posted.
 *
 * §16.5.2 matters here: this is a **sync** report, not a scan report. It counts
 * products moving between Catalog Cloud and the platform. Scan coverage — what
 * customers pointed a phone at — comes from GA4 via `bq-ga4-scans`. The two
 * measure different populations and must never be blended into one coverage
 * number, which is exactly the mistake §16.5.2 exists to prevent.
 */

export interface PipelineResult {
  pipeline: string;
  synced: number;
  inboundFailed: number;
  outboundFailed: number;
  inboundErrors: Array<{ errorType: string; count: number }>;
  outboundErrors: Array<{ errorType: string; count: number }>;
}

export interface ReconcileStage {
  stage: string;
  total: number;
  success: number;
  failed: number;
}

export interface CatalogueSyncReport {
  reportDate: string;
  /** The hour the report covers. The title says "Daily"; the window is hourly. */
  windowStart: string | null;
  windowEnd: string | null;
  pipelines: PipelineResult[];
  reconcile: ReconcileStage[];
  reconcilePassed: number;
  reconcileFailed: number;
  /** Every pipeline summed — the figure worth trending. */
  totalSynced: number;
  totalInboundFailed: number;
  totalOutboundFailed: number;
}

/** `| 2,742 |` → 2742. Returns null rather than 0 so a missing cell is visible. */
function cell(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number(v.replace(/[,\s|]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Rows of an `Error Type | Total` table inside a code fence.
 *
 * The `TOTAL` row and the `---` rules are skipped: TOTAL is a sum the report
 * already states elsewhere, and double-counting it would inflate every error
 * breakdown by exactly 100%.
 */
function parseErrorTable(block: string): Array<{ errorType: string; count: number }> {
  const out: Array<{ errorType: string; count: number }> = [];
  for (const line of block.split('\n')) {
    const m = /^\s*([A-Za-z][^|]*?)\s*\|\s*([\d,]+)\s*$/.exec(line);
    if (!m) continue;
    const errorType = m[1].trim();
    if (/^total$/i.test(errorType) || /^error type$/i.test(errorType)) continue;
    const count = cell(m[2]);
    if (count != null) out.push({ errorType, count });
  }
  return out;
}

/**
 * Splits the message into per-pipeline sections.
 *
 * Each `*<name> Pipeline*` heading owns everything up to the next one, and the
 * Inbound/Outbound failure tables belong to whichever pipeline precedes them.
 * Parsing the fences globally instead would attribute SAP's empty tables to
 * AJIO and silently zero out the real failure counts.
 */
function splitPipelines(text: string): Array<{ name: string; body: string }> {
  const heads = [...text.matchAll(/^\*([A-Za-z0-9 ]+) Pipeline\*\s*$/gm)];
  return heads.map((h, i) => ({
    name: h[1].trim(),
    body: text.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index! : undefined),
  }));
}

export function parseCatalogueSyncReport(text: string): CatalogueSyncReport | null {
  const reportDate = /\*Report Date:\*\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
  if (!reportDate) return null;

  const win = /\*Window:\*\s*([\d-]+ [\d:]+)\s*-\s*([\d-]+ [\d:]+)/.exec(text);

  const pipelines: PipelineResult[] = [];
  for (const { name, body } of splitPipelines(text)) {
    // The reconcile section is not a pipeline, even though it follows one.
    const beforeReconcile = body.split('*Reconcile Report')[0];

    const inboundBlock = /\*Inbound Failure Report:\*\s*```([\s\S]*?)```/.exec(beforeReconcile)?.[1] ?? '';
    const outboundBlock = /\*Outbound Failure Report:\*\s*```([\s\S]*?)```/.exec(beforeReconcile)?.[1] ?? '';

    pipelines.push({
      pipeline: name,
      // Zero here is a real measured zero — SAP genuinely syncs nothing (§13.9)
      // — so it is defaulted rather than left null.
      synced: cell(/Synced:\s*([\d,]+)/.exec(beforeReconcile)?.[1]) ?? 0,
      inboundFailed: cell(/Inbound Failed:\s*([\d,]+)/.exec(beforeReconcile)?.[1]) ?? 0,
      outboundFailed: cell(/Outbound Failed:\s*([\d,]+)/.exec(beforeReconcile)?.[1]) ?? 0,
      inboundErrors: parseErrorTable(inboundBlock),
      outboundErrors: parseErrorTable(outboundBlock),
    });
  }
  if (pipelines.length === 0) return null;

  const reconcile: ReconcileStage[] = [];
  const stageBlock = /Stage\s*\|\s*Total\s*\|\s*Success\s*\|\s*Failed([\s\S]*?)```/.exec(text)?.[1] ?? '';
  for (const line of stageBlock.split('\n')) {
    const m = /^\s*([a-z][a-z_]*)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*$/i.exec(line);
    if (!m) continue;
    reconcile.push({
      stage: m[1].trim(),
      total: cell(m[2]) ?? 0,
      success: cell(m[3]) ?? 0,
      failed: cell(m[4]) ?? 0,
    });
  }

  return {
    reportDate,
    windowStart: win?.[1] ?? null,
    windowEnd: win?.[2] ?? null,
    pipelines,
    reconcile,
    reconcilePassed: cell(/Total Passed \(Success\)\s*:\s*([\d,]+)/.exec(text)?.[1]) ?? 0,
    reconcileFailed: cell(/Total Failed\s*:\s*([\d,]+)/.exec(text)?.[1]) ?? 0,
    totalSynced: pipelines.reduce((a, p) => a + p.synced, 0),
    totalInboundFailed: pipelines.reduce((a, p) => a + p.inboundFailed, 0),
    totalOutboundFailed: pipelines.reduce((a, p) => a + p.outboundFailed, 0),
  };
}

/**
 * §6.3 — does the report's own arithmetic hold?
 *
 * The error tables should sum to the headline failure counts. When they do not,
 * either the upstream truncated a table or this parser missed a row — and both
 * are worth knowing, because a silently short breakdown makes the top defect
 * look smaller than it is. The report is the source of truth for its own
 * totals, so a mismatch always means *our* number is the wrong one.
 */
export function reconcileReport(r: CatalogueSyncReport): Array<{
  pipeline: string;
  direction: 'inbound' | 'outbound';
  stated: number;
  summed: number;
  agrees: boolean;
}> {
  const out = [];
  for (const p of r.pipelines) {
    for (const direction of ['inbound', 'outbound'] as const) {
      const stated = direction === 'inbound' ? p.inboundFailed : p.outboundFailed;
      const errs = direction === 'inbound' ? p.inboundErrors : p.outboundErrors;
      const summed = errs.reduce((a, e) => a + e.count, 0);
      out.push({ pipeline: p.pipeline, direction, stated, summed, agrees: stated === summed });
    }
  }
  return out;
}

/** The single biggest catalogue defect right now, across both directions. */
export function topDefect(
  r: CatalogueSyncReport,
): { errorType: string; count: number; direction: 'inbound' | 'outbound'; pipeline: string } | null {
  let best: { errorType: string; count: number; direction: 'inbound' | 'outbound'; pipeline: string } | null = null;
  for (const p of r.pipelines) {
    for (const direction of ['inbound', 'outbound'] as const) {
      for (const e of direction === 'inbound' ? p.inboundErrors : p.outboundErrors) {
        if (!best || e.count > best.count) {
          best = { errorType: e.errorType, count: e.count, direction, pipeline: p.pipeline };
        }
      }
    }
  }
  return best;
}
