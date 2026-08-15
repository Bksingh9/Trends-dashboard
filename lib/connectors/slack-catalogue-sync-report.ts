/**
 * §18.5 — Connector: `slack-catalogue-sync-report` (the Tatsu report's defects).
 *
 * `slack-catalogue-report` parses the *coverage* line out of the hourly report —
 * one row a day, the headline percentage. This one parses the **defect table**:
 * every error type and its count, per pipeline, per direction.
 *
 * That is the difference between "94% coverage" and "2,742 SKUs failed outbound
 * because an EAN is already assigned to another item code" — the first is a
 * number for a slide, the second is a work queue. §20.3's reason taxonomy has
 * had no live feed until now; it has been populated from a hand-written map.
 *
 * Deliberately a separate connector rather than more work inside the existing
 * one. Two grains — one row per day versus one row per (day, pipeline, error) —
 * means two marts, and a connector that writes two marts is one whose `load()`
 * branches on which half of its rows it is holding. That is precisely the seam
 * the §14 framework exists to keep straight.
 */
import { config } from '@/lib/config';
import { cardinality, freshness, rowVolume } from '@/lib/assertions';
import type { DateWindow } from '@/lib/format/dates';
import { CATALOGUE_SYNC_ERRORS } from '@/fixtures/catalogue-report-samples';
import { BaseConnector } from './base';
import { flattenBlocks, reportDateFromTs, type SlackMessage } from './slack-catalogue-report';
import { parseCatalogueSyncReport } from './catalogue-report-parse';
import { isScopeOrAuthFailure, readChannel } from './slack-snapshot';
import type { Assertion, CostTier, LoadResult } from './types';

/** One error type, in one direction, on one pipeline, in one report. */
export interface SyncDefectRow {
  reportDate: string;
  /** Report hour, ISO. Several reports land per day and each is its own row. */
  reportedAt: string;
  pipeline: string;
  direction: 'inbound' | 'outbound';
  errorType: string;
  count: number;
  /**
   * The §20.3 reason this maps to, where one is known.
   *
   * Null is common and correct: the bot invents error strings faster than
   * anybody maps them, and an unmapped defect must still be counted. Mapping it
   * to a neighbour to avoid a null would put the count under the wrong reason.
   */
  gapReason: string | null;
}

/** Matches a bot error string to a §20.3 reason, longest prefix first. */
export function mapGapReason(errorType: string): string | null {
  const keys = Object.keys(CATALOGUE_SYNC_ERRORS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (errorType.toLowerCase().includes(k.toLowerCase())) {
      return CATALOGUE_SYNC_ERRORS[k].maps_to ?? null;
    }
  }
  return null;
}

export function directionOf(errorType: string): 'inbound' | 'outbound' | null {
  const keys = Object.keys(CATALOGUE_SYNC_ERRORS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (errorType.toLowerCase().includes(k.toLowerCase())) return CATALOGUE_SYNC_ERRORS[k].direction;
  }
  return null;
}

export class SlackCatalogueSyncReportConnector extends BaseConnector<SlackMessage, SyncDefectRow> {
  readonly id = 'slack-catalogue-sync-report';
  readonly displayName = 'Slack — catalogue sync defects';
  /** The bot posts hourly; two missed hours is a real gap worth flagging. */
  readonly freshnessSlaMinutes = 3 * 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P1' as const;
  readonly powers = ['/catalogue defect table', '§20.3 reason counts', 'fact_catalogue_defect'];
  readonly blockedBy = '§13.6 Slack bot token (channels:history pending reinstall)';

  /**
   * Freshness is a hard gate on a live read and a warning on a snapshot.
   *
   * §6.3 exists to stop a **silently** stale feed from overwriting a good mart.
   * A snapshot is loudly stale: the source is `cache`, and the warning already
   * states the export's age in hours. Hard-failing it as well means the bridge
   * loads nothing at all, which is the opposite of what it is for — the choice
   * would be between a blocked mart and a fortnight-old fixture, and the
   * fortnight-old fixture is the one that gets mistaken for current.
   *
   * The staleness is not suppressed, only re-levelled. It still appears on
   * `/connectors`, and the run is still `cache`.
   */
  get assertions(): Assertion<SyncDefectRow>[] {
    return [
      rowVolume({ vsTrailingMedianDays: 7, tolerance: 0.6, zeroIsFail: false }),
      freshness({
        column: 'reportDate',
        maxLagHours: 26,
        level: this.lastSource === 'cache' ? 'warn' : 'fail',
      }),
      // One distinct error type across a whole window means the table stopped
      // being parsed and one line is being matched repeatedly — which would look
      // like a single catastrophic defect rather than a parser failure.
      cardinality({ column: 'errorType', minDistinct: 2, level: 'warn' }),
    ];
  }

  isConfigured(): boolean {
    // The snapshot bridge is a real read path, so a snapshot directory alone is
    // enough to be configured. Reporting "not configured" while a usable export
    // sits on disk would be the same false-negative this build keeps fixing.
    return Boolean(config.slackBotToken || process.env.SLACK_SNAPSHOT_DIR || config.slackSnapshotDir);
  }

  protected async extract(w: DateWindow): Promise<SlackMessage[]> {
    const channel = config.slackCatalogueChannel;
    const oldest = Math.floor(Date.parse(`${w.start}T00:00:00+05:30`) / 1000);
    const latest = Math.floor(Date.parse(`${w.end}T23:59:59+05:30`) / 1000);

    const { messages, source, warnings } = await readChannel(channel, async () => {
      if (!config.slackBotToken) throw new Error('SLACK_BOT_TOKEN not set');
      const out: SlackMessage[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const url = new URL('https://slack.com/api/conversations.history');
        url.searchParams.set('channel', channel);
        url.searchParams.set('limit', '100');
        url.searchParams.set('oldest', String(oldest));
        url.searchParams.set('latest', String(latest));
        url.searchParams.set('include_all_metadata', 'true');
        if (cursor) url.searchParams.set('cursor', cursor);

        const res = await fetch(url, { headers: { Authorization: `Bearer ${config.slackBotToken}` } });
        if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text()).slice(0, 160)}`);
        const body = (await res.json()) as {
          ok: boolean;
          error?: string;
          messages?: SlackMessage[];
          response_metadata?: { next_cursor?: string };
        };
        if (!body.ok) {
          const why = body.error ?? 'unknown';
          // `missing_scope` is the expected state until the reinstall lands and
          // is exactly what the snapshot exists for. Saying which kind of
          // failure it was keeps the fallback warning honest about what it
          // survived — a scope gap is a pending admin action, anything else is
          // a genuine outage.
          throw new Error(
            isScopeOrAuthFailure(why)
              ? `Slack API error: ${why} (scope/auth — the reinstall is pending)`
              : `Slack API error: ${why}`,
          );
        }
        out.push(...(body.messages ?? []));
        cursor = body.response_metadata?.next_cursor || undefined;
        pages += 1;
        if (pages >= 20) break; // §18.3 — pagination has repeatedly stalled past two pages
      } while (cursor);

      return out;
    });

    this.lastSource = source;
    this.lastWarnings = warnings;

    // Snapshots are not window-filtered by the exporter, so the window is
    // applied here — otherwise a run for one day would ingest the whole export
    // and the freshness assertion would pass on data from a fortnight ago.
    return messages.filter((m) => {
      const ts = Number(m.ts ?? 0);
      return ts >= oldest && ts <= latest;
    });
  }

  private lastSource: 'live' | 'cache' = 'live';
  private lastWarnings: string[] = [];

  protected readSource(): 'live' | 'cache' {
    return this.lastSource;
  }

  /** Carries "served from a snapshot, N hours old" onto the run. */
  protected readWarnings(): string[] {
    return this.lastWarnings;
  }

  protected transform(messages: SlackMessage[]): SyncDefectRow[] {
    const out: SyncDefectRow[] = [];

    for (const msg of messages) {
      const text = flattenBlocks(msg);
      const parsed = parseCatalogueSyncReport(text);
      if (!parsed) continue; // not a sync report — the channel carries other traffic

      const reportDate = parsed.reportDate || reportDateFromTs(msg.ts ?? '0');
      const reportedAt = new Date(Number(msg.ts ?? 0) * 1000).toISOString();

      for (const p of parsed.pipelines) {
        for (const [direction, errors] of [
          ['inbound', p.inboundErrors],
          ['outbound', p.outboundErrors],
        ] as const) {
          for (const e of errors) {
            if (!e.errorType || e.count <= 0) continue;
            out.push({
              reportDate,
              reportedAt,
              pipeline: p.pipeline,
              // The report's own column wins over the lookup: the map is a
              // convenience, the report is the source.
              direction,
              errorType: e.errorType,
              count: e.count,
              gapReason: mapGapReason(e.errorType),
            });
          }
        }
      }
    }

    return out;
  }

  protected async load(rows: SyncDefectRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factCatalogueDefect } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_catalogue_defect' };

    // Two reports in the same hour for the same pipeline and error would
    // collide on the key; the later one wins, which matches "the newest report
    // for that hour is the truth".
    const byKey = new Map<string, SyncDefectRow>();
    for (const r of rows) {
      byKey.set(`${r.reportDate}|${r.reportedAt}|${r.pipeline}|${r.direction}|${r.errorType}`, r);
    }
    const deduped = [...byKey.values()];

    for (let i = 0; i < deduped.length; i += 500) {
      await db
        .insert(factCatalogueDefect)
        .values(
          // `reported_at` is a timestamptz, so drizzle wants a Date. The row
          // type keeps an ISO string because that is what every other layer
          // here passes around.
          deduped.slice(i, i + 500).map((r) => ({ ...r, reportedAt: new Date(r.reportedAt) })),
        )
        .onConflictDoUpdate({
          target: [
            factCatalogueDefect.reportDate,
            factCatalogueDefect.reportedAt,
            factCatalogueDefect.pipeline,
            factCatalogueDefect.direction,
            factCatalogueDefect.errorType,
          ],
          set: { count: sql`excluded.count`, gapReason: sql`excluded.gap_reason` },
        });
    }

    return { rowsIngested: deduped.length, table: 'fact_catalogue_defect' };
  }

  protected fixture(w: DateWindow): SyncDefectRow[] {
    // Derived from the real error taxonomy rather than invented, and from the
    // one hour actually captured: 2,742 of 2,935 outbound failures were the
    // duplicate-EAN defect.
    const reportedAt = `${w.end}T11:00:00.000Z`;
    const shape: Array<[string, 'inbound' | 'outbound', number]> = [
      ['EAN already assigned to item code', 'outbound', 2742],
      ['Category Mapping Not Found', 'inbound', 118],
      ['Brand not found', 'outbound', 96],
      ['Country of origin invalid', 'outbound', 61],
      ['Product Master Sync API Failure', 'inbound', 24],
      ['Dimension invalid', 'outbound', 12],
    ];
    return shape.map(([errorType, direction, count]) => ({
      reportDate: w.end,
      reportedAt,
      pipeline: 'RBL → Fynd',
      direction,
      errorType,
      count,
      gapReason: mapGapReason(errorType),
    }));
  }
}

export const slackCatalogueSyncReport = new SlackCatalogueSyncReportConnector();
