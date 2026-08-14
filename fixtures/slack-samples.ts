/**
 * Verbatim messages captured from `#companion-app-alerts` (C0B0APYNZTQ).
 *
 * Everything in `slack-alerts.ts` before this file was written against a
 * *guess* at the message format. These are the real thing, copied from the
 * channel on 14 Aug 2026, and they are committed for one reason: a parser
 * tested only against text its own author invented tests nothing except that
 * author's imagination.
 *
 * Two shapes share the channel, from two different senders, and they need
 * completely different handling:
 *
 *   `sentry`  — one incident. Carries an error type, an endpoint, an event
 *               count, an affected-user count, a state and a short id. This is
 *               the row that belongs in `fact_issues`.
 *   `digest`  — the nightly Manus-assistant roll-up. A count *per service*,
 *               not an incident. Loading it as an issue would invent a new
 *               "issue" every single night whose title is a table.
 *
 * Tracking parameters (`notification_uuid`, `referrer`) are stripped from the
 * URLs. They identify a specific Slack delivery, not the incident, and they
 * would make every re-capture of the same message look like a new one.
 */

export interface SlackSample {
  /** How the message should classify. The expected answer, not an input. */
  kind: 'sentry' | 'digest' | 'other';
  ts: string;
  /** Slack's `bot_profile.name` / `username`, which is how the shapes differ. */
  username: string;
  text: string;
}

/* eslint-disable no-irregular-whitespace */

export const SLACK_ALERT_SAMPLES: SlackSample[] = [
  {
    kind: 'sentry',
    ts: '1786025143.000100',
    username: 'Sentry',
    text: `:red_circle: <https://fynd-f7.sentry.io/issues/7594455422/?environment=sng&alert_rule_id=16977944&alert_type=issue|*PromoIntegrationError*>
POST /apply-promotions
\`\`\`Failed to fetch details for all 1 product(s)\`\`\`
Events: *36*   Users Affected: *11*   State: *Regressed*   First Seen: *2026-07-05*
Project: <https://fynd-f7.sentry.io/issues/?project=4510674776686592|hashira>    Alert: <https://sentry.io/organizations/fynd-f7/issues/alerts/rules/hashira/16977944/details/|comp-app-hashira-regression>    Short ID: HASHIRA-1J`,
  },
  {
    kind: 'sentry',
    ts: '1786019599.000200',
    username: 'Sentry',
    text: `:red_circle: <https://fynd-f7.sentry.io/issues/7487196729/?environment=sng&alert_rule_id=16977944&alert_type=issue|*FDKServerResponseError*>
POST /session/init
\`\`\`Client network socket disconnected before secure TLS connection was established\`\`\`
Events: *22*   State: *Regressed*   First Seen: *2026-05-17*
Project: <https://fynd-f7.sentry.io/issues/?project=4510674776686592|hashira>    Alert: <https://sentry.io/organizations/fynd-f7/issues/alerts/rules/hashira/16977944/details/|comp-app-hashira-regression>    Short ID: HASHIRA-11`,
  },
  {
    // No `Users Affected` and no `State` — the optional fields really are
    // optional, and a parser that requires them drops the highest-volume issue
    // on the board.
    kind: 'sentry',
    ts: '1785835642.000300',
    username: 'Sentry',
    text: `:red_circle: <https://fynd-f7.sentry.io/issues/7225929493/?environment=sng&alert_rule_id=16977944&alert_type=issue|*Error*>
GET /api/app/config
\`\`\`CORS blocked for origin: <https://dxxs3.com/>\`\`\`
Events: *746*   First Seen: *2026-01-28*
Project: <https://fynd-f7.sentry.io/issues/?project=4510674776686592|hashira>    Alert: <https://sentry.io/organizations/fynd-f7/issues/alerts/rules/hashira/16977944/details/|comp-app-hashira-regression>    Short ID: HASHIRA-9`,
  },
  {
    // A different project and the `production` environment rather than `sng`.
    kind: 'sentry',
    ts: '1785753137.000400',
    username: 'Sentry',
    text: `:red_circle: <https://fynd-f7.sentry.io/issues/7045696140/?environment=production&alert_rule_id=16977956&alert_type=issue|*TypeError*>
POST /webhook/refund
\`\`\`Cannot read properties of null (reading 'gid')\`\`\`
Events: *466*   First Seen: *2025-11-19*
Project: <https://fynd-f7.sentry.io/issues/?project=1543857|gringotts>    Alert: <https://sentry.io/organizations/fynd-f7/issues/alerts/rules/gringotts/16977956/details/|comp-app-gringotts-regression>    Short ID: GRINGOTTS-1JZB`,
  },
  {
    // The highest user impact in the sample, and the one whose priority the
    // NOC most needs raised.
    kind: 'sentry',
    ts: '1785667133.000500',
    username: 'Sentry',
    text: `:red_circle: <https://fynd-f7.sentry.io/issues/7498475471/?environment=sng&alert_rule_id=16977944&alert_type=issue|*Error*>
GET /inventory/resolve-sizes
\`\`\`fetchProductStockStatusViaHttp: itemId is required\`\`\`
Events: *1251*   Users Affected: *154*   State: *Regressed*   First Seen: *2026-05-21*
Project: <https://fynd-f7.sentry.io/issues/?project=4510674776686592|hashira>    Alert: <https://sentry.io/organizations/fynd-f7/issues/alerts/rules/hashira/16977944/details/|comp-app-hashira-regression>    Short ID: HASHIRA-14`,
  },
  {
    kind: 'digest',
    ts: '1786071625.000600',
    username: 'Manus-assistant',
    text: `:large_green_circle: *Companion App Health — EOD 14 Aug*
━━━━━━━━━━━━━━━━━━━━━
*Now (last 24h):* 12 Aug, 23:00 IST → 14 Aug, 04:30 IST
━━━━━━━━━━━━━━━━━━━━━
\`\`\`avis              🟢  1 issue  ↑0% vs prev 24h
computron         🟢  0 issues
silverbolt        🟢  1 issue  ↑0% vs prev 24h
cartorderproxy    🟢  0 issues
hashira           🟢  5 issues  ↑0% vs prev 24h
gringotts         🟢  2 issues  ↑0% vs prev 24h
megatron          🟢  1 issue  ↑0% vs prev 24h\`\`\`
━━━━━━━━━━━━━━━━━━━━━
:link: <https://fynd-f7.sentry.io/issues/|Sentry Dashboard> | Full thread below ↓`,
  },
  {
    kind: 'digest',
    ts: '1785985216.000700',
    username: 'Manus-assistant',
    text: `:large_green_circle: *Companion App Health — EOD 13 Aug*
━━━━━━━━━━━━━━━━━━━━━
*Now (last 24h):* 11 Aug, 23:00 IST → 13 Aug, 04:30 IST
━━━━━━━━━━━━━━━━━━━━━
\`\`\`avis              🟢  1 issue  ↑0% vs prev 24h
computron         🟢  0 issues
silverbolt        🟢  0 issues
cartorderproxy    🟢  0 issues
hashira           🟢  3 issues  ↑0% vs prev 24h
gringotts         🟢  2 issues  ↑0% vs prev 24h
megatron          🟢  0 issues\`\`\`
━━━━━━━━━━━━━━━━━━━━━
:link: <https://fynd-f7.sentry.io/issues/|Sentry Dashboard> | Full thread below ↓`,
  },
  {
    // Neither shape. A human talking in the channel must not become a row.
    kind: 'other',
    ts: '1785900000.000800',
    username: 'Kingshuk',
    text: 'Looking at the hashira regressions now — will update here once I have an RCA.',
  },
];

/* eslint-enable no-irregular-whitespace */

/**
 * §13.6 / A11 — what the channel proves about the Sentry side, confirmed by
 * reading it rather than assumed.
 *
 * `SENTRY_ORG` and `SENTRY_PROJECTS` were previously guesses in `.env.example`.
 * These are the values the alerts themselves carry.
 */
export const SENTRY_FACTS = {
  org: 'fynd-f7',
  /** Every project that alerts into #companion-app-alerts. */
  projects: [
    'avis',
    'computron',
    'silverbolt',
    'cartorderproxy',
    'hashira',
    'gringotts',
    'megatron',
  ],
  /** Both appear on real alerts; `sng` is the Companion environment (§0). */
  environments: ['sng', 'production'],
  alertRulePattern: 'comp-app-<project>-regression',
} as const;
