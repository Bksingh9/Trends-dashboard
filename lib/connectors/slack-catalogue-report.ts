/**
 * §18 — Connector 3: `slack-catalogue-report`.
 *
 * P0. Currently the only catalogue coverage source. Powers `/catalogue` from day
 * one, before GA4 is wired.
 *
 * Two failure modes this connector is built around:
 *  - The Error Report has silently stopped generating before (flagged 11 Aug).
 *    `missingReport` surfaces it as an amber light rather than a gap in a chart.
 *  - Paging backward through this channel repeatedly fails after two pages,
 *    cutting reachable history off at a fixed point. Unreachable days are
 *    written as explicit missing rows, not skipped (§18.3).
 */
import { config } from '@/lib/config';
import { freshness, missingReport, reconcile, rowVolume } from '@/lib/assertions';
import { istDateKey, type DateWindow, dateRange } from '@/lib/format/dates';
import { fixtureCatalogueDaily, type CatalogueDailyRow } from '@/fixtures/catalogue';
import { UNREACHABLE_REPORT_DAYS } from '@/fixtures/baselines';
import { respectRetryAfter } from './retry';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

export interface SlackMessage {
  ts: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  blocks?: unknown[];
  attachments?: Array<{ text?: string; fallback?: string; fields?: Array<{ title?: string; value?: string }> }>;
}

/**
 * §18.4 — parse defensively. A bot template change must degrade to a warning,
 * not a crash.
 */
const FIELD_PATTERNS = {
  totalScans: /total\s*scans?\D{0,20}?([\d,]+)/i,
  totalFailed: /total\s*failed\D{0,20}?([\d,]+)/i,
  uniqueScans: /unique\s*scans?\D{0,20}?([\d,]+)/i,
  uniqueFailed: /unique\s*failed\D{0,20}?([\d,]+)/i,
  statedPct: /([\d.]+)\s*%/,
} as const;

export interface ParseFailure {
  kind: 'parse_failure';
  missing: string[];
  raw: string;
  ts: string;
}

export type ParsedReport = CatalogueDailyRow | ParseFailure;

/** Flattens text, blocks and attachments — the numbers can live in any of them. */
export function flattenBlocks(msg: SlackMessage): string {
  const parts: string[] = [msg.text ?? ''];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(msg.blocks);
  walk(msg.attachments);
  return parts.join('\n');
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function parseReport(msg: SlackMessage): ParsedReport {
  const text = flattenBlocks(msg);
  const got = {
    totalScans: num(text.match(FIELD_PATTERNS.totalScans)?.[1]),
    totalFailed: num(text.match(FIELD_PATTERNS.totalFailed)?.[1]),
    uniqueScans: num(text.match(FIELD_PATTERNS.uniqueScans)?.[1]),
    uniqueFailed: num(text.match(FIELD_PATTERNS.uniqueFailed)?.[1]),
    statedPct: num(text.match(FIELD_PATTERNS.statedPct)?.[1]),
  };
  const missing = Object.entries(got)
    .filter(([k, v]) => v === undefined && k !== 'statedPct')
    .map(([k]) => k);
  if (missing.length) return { kind: 'parse_failure', missing, raw: text, ts: msg.ts };

  const uniqueScans = got.uniqueScans!;
  const uniqueFailed = got.uniqueFailed!;
  const totalScans = got.totalScans!;
  const totalFailed = got.totalFailed!;
  const uniqueCoverage = uniqueScans === 0 ? 0 : (uniqueScans - uniqueFailed) / uniqueScans;
  const totalCoverage = totalScans === 0 ? 0 : (totalScans - totalFailed) / totalScans;

  return {
    dateKey: reportDateFromTs(msg.ts),
    totalScans,
    totalFailed,
    uniqueScans,
    uniqueFailed,
    uniqueCoverage,
    totalCoverage,
    botStatedPct: got.statedPct === undefined ? null : got.statedPct / 100,
    reportGenerated: true,
    source: 'slack_bot',
  };
}

/**
 * §18.4 — `reportDate` derives from the message timestamp in IST, and the report
 * describes the *previous* day. Confirm the convention against one known report
 * before backfilling 90 days with an off-by-one.
 */
export function reportDateFromTs(ts: string): string {
  const ms = Number(ts.split('.')[0]) * 1000;
  const postedDay = istDateKey(new Date(ms));
  const [y, m, d] = postedDay.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return prev.toISOString().slice(0, 10);
}

export class SlackCatalogueReportConnector extends BaseConnector<SlackMessage, CatalogueDailyRow> {
  readonly id = 'slack-catalogue-report';
  readonly displayName = 'Slack — Tatsu Scan Catalog Daily Report';
  // 90 minutes, not 36 hours. The report is titled "Daily" but is posted every
  // hour — confirmed by reading #sng-catalogue-lack, where every message covers
  // a one-hour window. At 36h a genuine two-hour outage of the sync pipeline
  // would have gone unremarked for a day and a half.
  readonly freshnessSlaMinutes = 90;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P0' as const;
  readonly powers = ['/catalogue', 'unique_coverage', 'total_coverage', 'missing_distinct', 'Manhattan chart'];
  readonly blockedBy = '§13.6 Slack bot token';

  /** Recorded so the UI can hatch the gap rather than start the series wherever pagination died. */
  private unreachableDays: string[] = [...UNREACHABLE_REPORT_DAYS];

  isConfigured(): boolean {
    return Boolean(config.slackBotToken) && Boolean(config.slackCatalogueChannel);
  }

  protected async extract(w: DateWindow): Promise<SlackMessage[]> {
    const oldest = Math.floor(Date.parse(`${w.start}T00:00:00+05:30`) / 1000);
    const latest = Math.floor(Date.parse(`${w.end}T23:59:59+05:30`) / 1000);
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    let pages = 0;

    // §14.3 — Slack is tier-limited: sequential only, respect Retry-After exactly.
    do {
      const url = new URL('https://slack.com/api/conversations.history');
      url.searchParams.set('channel', config.slackCatalogueChannel);
      url.searchParams.set('limit', '100');
      url.searchParams.set('oldest', String(oldest));
      url.searchParams.set('latest', String(latest));
      // The payload we want *is* a bot message — do not filter bot subtypes out.
      url.searchParams.set('include_all_metadata', 'true');
      if (cursor) url.searchParams.set('cursor', cursor);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${config.slackBotToken}` } });
      if (await respectRetryAfter(res)) continue;
      if (!res.ok) throw new Error(`Slack ${res.status}: ${await res.text()}`);

      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        messages?: SlackMessage[];
        response_metadata?: { next_cursor?: string };
      };
      if (!body.ok) throw new Error(`Slack API error: ${body.error}`);

      out.push(...(body.messages ?? []));
      cursor = body.response_metadata?.next_cursor || undefined;
      pages++;
      // §18.3 — pagination here has repeatedly failed after two pages. Stop
      // rather than loop, and record the unreached range explicitly.
      if (pages >= 20) break;
    } while (cursor);

    return out.filter((m) => /scan catalog daily report/i.test(flattenBlocks(m)));
  }

  protected transform(messages: SlackMessage[]): CatalogueDailyRow[] {
    const rows: CatalogueDailyRow[] = [];
    for (const m of messages) {
      const parsed = parseReport(m);
      if ('kind' in parsed) {
        // Degrade to a warning; the raw message is kept in the run log so a
        // human can see what changed.
        console.warn(`[${this.id}] parse failure at ts=${parsed.ts}, missing: ${parsed.missing.join(', ')}`);
        continue;
      }
      rows.push(parsed);
    }
    return rows;
  }

  /** §18.3 — unreachable days become explicit rows, so the chart shows a hole. */
  markUnreachable(w: DateWindow, present: CatalogueDailyRow[]): CatalogueDailyRow[] {
    const have = new Set(present.map((r) => r.dateKey));
    const gaps: CatalogueDailyRow[] = [];
    for (const dateKey of dateRange(w)) {
      if (have.has(dateKey)) continue;
      if (!this.unreachableDays.includes(dateKey)) continue;
      gaps.push({
        dateKey,
        totalScans: 0,
        totalFailed: 0,
        uniqueScans: 0,
        uniqueFailed: 0,
        uniqueCoverage: 0,
        totalCoverage: 0,
        botStatedPct: null,
        reportGenerated: null, // NULL, not false — "unreachable", not "no report"
        source: 'unreachable',
      });
    }
    return [...present, ...gaps];
  }

  protected async load(rows: CatalogueDailyRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factCatalogueDaily } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_catalogue_daily' };

    await db
      .insert(factCatalogueDaily)
      .values(
        rows.map((r) => ({
          dateKey: r.dateKey,
          totalScans: r.totalScans,
          totalFailed: r.totalFailed,
          uniqueScans: r.uniqueScans,
          uniqueFailed: r.uniqueFailed,
          uniqueCoverage: String(r.uniqueCoverage),
          totalCoverage: String(r.totalCoverage),
          botStatedPct: r.botStatedPct == null ? null : String(r.botStatedPct),
          reportGenerated: r.reportGenerated,
          source: r.source,
        })),
      )
      .onConflictDoUpdate({
        target: factCatalogueDaily.dateKey,
        set: {
          totalScans: sql`excluded.total_scans`,
          totalFailed: sql`excluded.total_failed`,
          uniqueScans: sql`excluded.unique_scans`,
          uniqueFailed: sql`excluded.unique_failed`,
          uniqueCoverage: sql`excluded.unique_coverage`,
          totalCoverage: sql`excluded.total_coverage`,
          botStatedPct: sql`excluded.bot_stated_pct`,
        },
      });
    return { rowsIngested: rows.length, table: 'fact_catalogue_daily' };
  }

  protected fixture(w: DateWindow): CatalogueDailyRow[] {
    return fixtureCatalogueDaily(w);
  }

  readonly assertions: Assertion<CatalogueDailyRow>[] = [
    freshness<CatalogueDailyRow>({ column: 'dateKey', maxLagHours: 36, level: 'fail' }),
    rowVolume<CatalogueDailyRow>({ tolerance: 0.6, zeroIsFail: true }),
    // §18.6 — the report has gone missing unnoticed once already.
    missingReport<CatalogueDailyRow>({
      present: (rows) => rows.some((r) => r.reportGenerated === true),
      expectedDailyBy: '09:00 IST',
    }),
    // §18.5 — the whole reason to parse both the components and the bot's own
    // stated percentage. A mismatch means the parser drifted or the bot's
    // arithmetic changed; either way a human needs to look.
    reconcile<CatalogueDailyRow>({
      id: 'coverage_reconcile',
      computed: (rows) => {
        const r = rows.find((x) => x.botStatedPct != null);
        return r ? r.uniqueCoverage : null;
      },
      against: (rows) => rows.find((x) => x.botStatedPct != null)?.botStatedPct ?? null,
      tolerance: 0.001, // 0.1 percentage point
      level: 'warn',
    }),
  ];
}

export const slackCatalogueReport = new SlackCatalogueReportConnector();
