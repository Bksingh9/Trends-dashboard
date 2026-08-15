# Slack Connector — end-to-end

Handoff for the Companion Trends dashboard.

Do not paste real tokens, webhook URLs, service-account keys, or `.env.local`
contents into this file. Secrets belong only in local `.env.local`, Vercel
environment variables, or the approved secret manager.

> **Corrections to the original handoff note.** It listed
> `lib/connectors/slack-snapshot.ts` and
> `lib/connectors/slack-catalogue-sync-report.ts` under "already wired in code".
> Neither existed, and neither did the webhook fallback. All three are now
> built, and the verification command below is one that has actually been run.
> `npm run typecheck`, `etl:seed` and `etl:status` did already exist.

## Slack app

| | |
|---|---|
| Workspace | `Fynd` |
| App | `AI Dashboard Bot` |
| App ID | `A0908SBQHJP` |
| Bot user | `ai_dashboard_bot` |
| Bot ID | `B0908SKGXJP` |

## Channels

| Purpose | Channel | ID |
|---|---|---|
| Catalogue sync reports | `#sng-catalogue-lack` | `C0AV6FU1YUU` |
| Companion app alerts | `#companion-app-alerts` | `C0B0APYNZTQ` |
| NOC / ops | — | `C0BFJQDV05N` |

## Required scopes

`channels:read`, `channels:history`, `files:read`, `chat:write`,
`incoming-webhook`.

The token authenticates today; the read/write scopes are pending workspace
approval and reinstall. Until that lands there are two bridges, described below.

## Environment variables

```bash
SLACK_BOT_TOKEN=xoxb-REDACTED
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/REDACTED
SLACK_CATALOGUE_CHANNEL=C0AV6FU1YUU
SLACK_ALERTS_CHANNEL=C0B0APYNZTQ
SLACK_NOC_CHANNEL=C0BFJQDV05N
SLACK_DIGEST_CHANNEL=C0B0APYNZTQ
SLACK_SNAPSHOT_DIR=/absolute/path/to/slack-snapshots
DATABASE_URL=postgres://REDACTED
```

Only `SLACK_SNAPSHOT_DIR` is a temporary local bridge. Production should prefer
the approved bot token plus `DATABASE_URL`.

## The two bridges, and what they cost

### Read — `SLACK_SNAPSHOT_DIR`

Export the channel history you already have access to as JSON, drop it in the
directory, and the connectors parse it with **the same code** that parses a live
response. Filenames must contain the channel id
(`C0AV6FU1YUU-2026-08-15.json`); contents may be either a bare array of messages
or a whole `conversations.history` response — both shapes are accepted, because
requiring one guarantees somebody hands over the other.

What it costs, and what is done about it:

- A run served this way is **`cache`, never `live`**, and the warning names the
  files and their age in hours. A bridge reported as a live feed is worse than a
  fixture, because it looks like it is working.
- The fallback is only reached **after a real API attempt has failed**, and the
  failure reason is carried into the warning.
- Freshness drops from a hard gate to a warning in snapshot mode only. §6.3
  exists to stop a *silently* stale feed overwriting a good mart; a snapshot is
  loudly stale. Hard-failing it too would mean the bridge loads nothing, leaving
  the choice between a blocked mart and a fortnight-old fixture — and the
  fixture is the one that gets mistaken for current.

### Write — `SLACK_WEBHOOK_URL`

Keeps alerting alive without `chat:write`.

An incoming webhook posts to the single channel chosen when it was created, so
it **cannot route**. An alert addressed to the NOC channel will land wherever
the webhook points. Every post through it therefore carries the channel it was
meant for, in its own text. The fallback triggers only on scope/auth errors — a
`channel_not_found` is *not* retried through the webhook, because that would
deliver the message somewhere else and call it a success.

## Connectors

| id | reads | writes |
|---|---|---|
| `slack-catalogue-report` | coverage headline, one row a day | `fact_catalogue_daily` |
| `slack-catalogue-sync-report` | the defect table, one row per (report, pipeline, direction, error) | `fact_catalogue_defect` |
| `slack-alerts` | Sentry alerts, health digest | `fact_app_health_daily`, `fact_issues` |

Two connectors on one message on purpose: the grains differ, and one connector
is one row type. A connector writing two marts is one whose `load()` branches on
which half of its rows it is holding.

`slack-catalogue-sync-report` is the one that turns
`EAN already assigned to item code = 36` into rows you can work. Unmapped error
strings keep `gap_reason = NULL` rather than being filed under the nearest §20.3
reason — the bot invents strings faster than anyone maps them, and a wrong
reason is worse than an absent one.

### Key files

- `lib/connectors/slack-snapshot.ts`
- `lib/connectors/slack-catalogue-report.ts`
- `lib/connectors/slack-catalogue-sync-report.ts`
- `lib/connectors/slack-alerts.ts`
- `lib/alerts.ts`

## Local verification

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Snapshot fallback, no database, no token — this exact command has been run and
its output is below:

```bash
SLACK_BOT_TOKEN= \
SLACK_SNAPSHOT_DIR=/absolute/path/to/slack-snapshots \
npx tsx -e "import { slackCatalogueSyncReport } from './lib/connectors/slack-catalogue-sync-report'; (async () => { const r = await slackCatalogueSyncReport.run({ start: '2026-08-15', end: '2026-08-15' }); console.log({ ok: r.ok, rows: r.rows.length, source: r.meta.source }); })();"
```

```
{ ok: true, rows: 21, source: 'cache' }
▲ Slack read failed (SLACK_BOT_TOKEN not set) — served from a snapshot instead.
  3 messages from 1 file(s), newest 0h old. This is a local bridge, not a live feed.
▲ Data is 34.3h stale (SLA 26h) — the feed may have stopped silently
```

`source: 'cache'` is the part to check. If that ever reads `live` while
`SLACK_BOT_TOKEN` is empty, the provenance has been lost and the result cannot
be trusted.

## Live production flow

1. Workspace admin approves/reinstalls `AI Dashboard Bot` with the required
   scopes.
2. Set production secrets: `SLACK_BOT_TOKEN`, `SLACK_WEBHOOK_URL`, the channel
   IDs, `DATABASE_URL`.
3. `npm run db:push` — `fact_catalogue_defect` is new.
4. `npm run etl:seed -- slack-catalogue-sync-report slack-alerts` to prove the
   load paths with fixtures.
5. `npm run etl:run -- slack-catalogue-sync-report slack-alerts` for the live run.
6. `npm run etl:status` to confirm.
7. Check `/connectors`, `/catalogue`, `/issues`, `/app-health`.

Once the token has `channels:history`, **unset `SLACK_SNAPSHOT_DIR` in
production.** Leaving it set means a Slack outage silently degrades to whatever
export happens to be on disk, and the difference is one line in a warning.

## XLSX attachment flow

After `files:read` is approved:

1. Read Tatsu report thread files from `#sng-catalogue-lack`.
2. Download only bounded XLSX files.
3. Capture headers first, not raw product/customer data.
4. Add a per-EAN detail connector only after PII and data-shape checks.

This is the step that turns a summary count into a per-EAN work queue.

## Do not

- Do not commit `.env.local`.
- Do not put real `xoxb-` tokens in Markdown.
- Do not paste `SLACK_WEBHOOK_URL` into tickets or docs.
- Do not use a user token as the production integration path.
- Do not scrape browser cookies or session tokens.
