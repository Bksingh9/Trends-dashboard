/**
 * §18.8 — Connector 10: `slack-alerts`. P2.
 *
 * Production alerts (`C0B0APYNZTQ`) plus NOC/ops store escalations
 * (`C0BFJQDV05N`). Grouped by fingerprint, deduped, written to `fact_issues`
 * with `source = 'slack_noc'`. The permalink stays on every row so a person can
 * jump to the thread.
 */
import { config } from '@/lib/config';
import { rowVolume } from '@/lib/assertions';
import type { DateWindow } from '@/lib/format/dates';
import { fixtureIssues, type IssueRow } from '@/fixtures/business';
import { classifyJourneyStep } from './jira';
import { respectRetryAfter } from './retry';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

interface RawAlert {
  ts: string;
  channel: string;
  text: string;
  permalink: string;
}

/** Group by error signature or store code, so one broken thing is one row. */
export function fingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d{4,}/g, '#') // ids, timestamps, counts
    .replace(/[0-9a-f]{8,}/g, '#') // hashes
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function extractStoreCode(text: string): string | null {
  const m = text.match(/\bstore[\s:#-]*([0-9]{3,6})\b/i);
  return m ? m[1] : null;
}

export class SlackAlertsConnector extends BaseConnector<RawAlert, IssueRow> {
  readonly id = 'slack-alerts';
  readonly displayName = 'Slack — prod alerts & NOC escalations';
  readonly freshnessSlaMinutes = 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P2' as const;
  readonly powers = ['/issues alert stream', 'store issue intake'];
  readonly blockedBy = '§13.6 Slack bot token';

  isConfigured(): boolean {
    return Boolean(config.slackBotToken) && Boolean(config.slackAlertsChannel);
  }

  private async history(channel: string, w: DateWindow): Promise<RawAlert[]> {
    const oldest = Math.floor(Date.parse(`${w.start}T00:00:00+05:30`) / 1000);
    const latest = Math.floor(Date.parse(`${w.end}T23:59:59+05:30`) / 1000);
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channel);
    url.searchParams.set('limit', '200');
    url.searchParams.set('oldest', String(oldest));
    url.searchParams.set('latest', String(latest));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.slackBotToken}` } });
    if (await respectRetryAfter(res)) return this.history(channel, w);
    if (!res.ok) throw new Error(`Slack ${res.status}`);
    const body = (await res.json()) as { ok: boolean; error?: string; messages?: Array<{ ts: string; text?: string }> };
    if (!body.ok) throw new Error(`Slack API error: ${body.error}`);

    return (body.messages ?? []).map((m) => ({
      ts: m.ts,
      channel,
      text: m.text ?? '',
      permalink: `https://slack.com/archives/${channel}/p${m.ts.replace('.', '')}`,
    }));
  }

  protected async extract(w: DateWindow): Promise<RawAlert[]> {
    const channels = [config.slackAlertsChannel, config.slackNocChannel].filter(Boolean);
    const out: RawAlert[] = [];
    // §14.3 — sequential only.
    for (const c of channels) out.push(...(await this.history(c, w)));
    return out;
  }

  protected transform(alerts: RawAlert[]): IssueRow[] {
    const grouped = new Map<string, { alerts: RawAlert[]; fp: string }>();
    for (const a of alerts) {
      const fp = fingerprint(a.text);
      const cur = grouped.get(fp) ?? { alerts: [], fp };
      cur.alerts.push(a);
      grouped.set(fp, cur);
    }

    return [...grouped.values()].map(({ alerts: group, fp }) => {
      const first = group[group.length - 1];
      const storeCode = extractStoreCode(first.text);
      const isNoc = first.channel === config.slackNocChannel;
      return {
        issueKey: `SLACK-${fp.replace(/[^a-z0-9]/g, '').slice(0, 24)}-${first.ts.split('.')[0]}`,
        source: 'slack_noc' as const,
        title: first.text.slice(0, 180) || '(no text)',
        priority: /p0|critical|down|outage/i.test(first.text) ? 'P0' : ('P2' as IssueRow['priority']),
        status: 'To Do',
        workstream: isNoc ? 'Store Ops' : 'Platform & Infra',
        journeyStep: classifyJourneyStep(first.text),
        storeCode,
        assignee: null,
        createdAt: new Date(Number(first.ts.split('.')[0]) * 1000).toISOString(),
        resolvedAt: null,
        url: first.permalink,
      };
    });
  }

  protected async load(rows: IssueRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factIssues } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_issues' };
    await db
      .insert(factIssues)
      .values(
        rows.map((r) => ({
          issueKey: r.issueKey,
          source: r.source,
          title: r.title,
          priority: r.priority,
          status: r.status,
          workstream: r.workstream,
          journeyStep: r.journeyStep,
          storeCode: r.storeCode,
          assignee: r.assignee,
          createdAt: new Date(r.createdAt),
          resolvedAt: null,
          url: r.url,
        })),
      )
      .onConflictDoUpdate({
        target: factIssues.issueKey,
        set: { title: sql`excluded.title`, status: sql`excluded.status` },
      });
    return { rowsIngested: rows.length, table: 'fact_issues' };
  }

  protected fixture(): IssueRow[] {
    return fixtureIssues().filter((i) => i.source === 'slack_noc');
  }

  readonly assertions: Assertion<IssueRow>[] = [
    rowVolume<IssueRow>({ tolerance: 0.9, zeroIsFail: false }),
  ];
}

export const slackAlerts = new SlackAlertsConnector();
