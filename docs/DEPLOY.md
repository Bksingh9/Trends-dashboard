# Deploying to Vercel

The app is deploy-ready as-is: it builds clean, requires no credentials to run,
and serves labelled fixtures for every connector that isn't configured yet.

---

## Cron schedule — one heartbeat, SLA-driven

There is **one scheduled entry point**. It does not decide what to run; the
freshness SLA declared on each connector does (ADR-003). `vercel.json` ships
with:

```json
"crons": [
  { "path": "/api/cron/tick",           "schedule": "*/15 * * * *" },
  { "path": "/api/insights?post=slack", "schedule": "30 2 * * *" }
]
```

`/api/cron/tick` reads the run log, finds everything past its SLA, and runs
only that. Firing it more often than anything is due is cheap — it reads the
log, finds nothing, and returns. So the only thing that matters is that it
fires **at least as often as the tightest SLA in the registry**, which is
currently 60 minutes (`api-latency`, `gcp-logging`, `jira`, `sentry`,
`slack-alerts`). The `/connectors` page states this cadence in prose, and a
unit test fails the build if the schedule here falls behind the SLAs.

This replaced one cron entry per connector deliberately. A cron expression per
connector drifts away from the SLA shown on `/connectors` until the two
disagree and nobody can say which is the truth; and adding a fourteenth
connector meant editing this file and redeploying. Now a new connector declares
an SLA and the scheduler picks it up.

Cron schedules in `vercel.json` are **UTC**. `30 2 * * *` is 08:00 IST.

### If you are on Hobby

Vercel's **Hobby plan runs cron jobs once a day**, at an approximate hour. The
schedule above is still correct — Vercel will simply invoke it daily, which
means every SLA tighter than a day silently becomes daily.

That is visible rather than hidden: the tick's own response reports
`shortestSlaMinutes` and the cadence it needs, and any mart whose connector has
gone past its SLA serves `stale` rather than `live`, so the affected cards say
so on the page (§14.5). Nothing shows green on data that has stopped moving.

To get the real cadence, upgrade to Pro — no config change is needed, the same
`*/15` schedule starts being honoured.

### Running a connector by hand

Any connector can still be run on demand — from the manual re-run on
`/connectors`, or directly:

```bash
# Run whatever is due right now, exactly as the heartbeat would
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/tick

# Force one connector regardless of its SLA
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://<host>/api/cron/slack-catalogue-report
```

Or press **run now** on that connector's row on `/connectors` — a server
action, so no secret has to reach the browser.

If you want tighter cadence without upgrading, point an external scheduler
(GitHub Actions on a schedule, cron-job.org, or an existing internal runner) at
those same endpoints. They are ordinary authenticated POSTs.

---

## Option A — GitHub integration (recommended)

Gives you automatic deploys on every push, preview deploys per branch, and no
token to manage.

1. Open <https://vercel.com/new>
2. Import `Bksingh9/Trends-dashboard`
3. Framework preset: **Next.js** (auto-detected). Leave build settings alone.
4. Set **Production Branch** to `claude/companion-trends-dashboard-0uf9zs`
   (Settings → Git), or merge that branch to `main` first.
5. Deploy.

It will build and serve on fixtures with no environment variables at all. Add
them incrementally afterwards — each one flips a connector from fixture to live
with no code change.

## Option B — CLI with a token

```bash
# Create at https://vercel.com/account/tokens
export VERCEL_TOKEN=...

npm i -g vercel
vercel link --yes --token "$VERCEL_TOKEN"
vercel pull --yes --environment=production --token "$VERCEL_TOKEN"
vercel build --prod --token "$VERCEL_TOKEN"
vercel deploy --prebuilt --prod --token "$VERCEL_TOKEN"
```

---

## Environment variables

None are required. Add them in Vercel → Settings → Environment Variables as
they become available; see `.env.example` for the annotated full list.

**Set these first, in this order of leverage:**

| Variable | What it unblocks |
|---|---|
| `NEXTAUTH_SECRET` + `AUTH_ALLOWLIST` | Closes the open-access banner and gates the dashboard (§9.4) |
| `CRON_SECRET` | Stops a public URL triggering a BigQuery scan. **Set this before adding GCP credentials** |
| `DATABASE_URL` | Durable marts and run log. Without it, `/connectors` history is in-memory only |
| `GCP_SA_KEY_JSON` | `bq-orders`, `bq-catalogue-master`, `ga4-api`, `gcp-logging` |
| `BQ_GA4_PROJECT` + `BQ_GA4_DATASET` | The funnel, the Scan Strip, scan-level catalogue analysis — §13.1, the highest-leverage unblock in the whole build |
| `SLACK_BOT_TOKEN` | The catalogue report, the alert stream, the daily digest |
| `ANTHROPIC_API_KEY` | The written daily brief (a deterministic summary shows without it) |
| `CUSTOMER_ID_SALT` | **Required in production** — salts the customer_id hash (§27.4). The app throws without it |

### The boot guard will stop a bad deploy

`instrumentation.ts` runs `assertProductionOnly` at boot and **throws** if any
non-production value reaches config — a UAT application id, an `sngz*` host, a
`uat` hostname. If your deploy crashes on boot with
`Non-production value in …`, that is the guard doing its job, not a bug.

### Database

Vercel Postgres, Neon, or Supabase all work. After provisioning:

```bash
npm run db:push        # applies the §7 schema
```

Then create the read-only role that `/api/ask` runs against — the regex guard is
defence in depth, this is the actual boundary:

```sql
CREATE ROLE dashboard_readonly LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE <db> TO dashboard_readonly;
GRANT USAGE ON SCHEMA public TO dashboard_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dashboard_readonly;
```

Put that role's connection string in `DATABASE_URL_READONLY`. Until it is set,
`/api/ask` will generate and preview SQL but refuse to execute it.

---

## Region

`vercel.json` pins `bom1` (Mumbai). The users, the BigQuery data, and the stores
are all in India; running the serving layer anywhere else adds a round trip to
every request for no benefit.

---

## After the first deploy

1. Open `/connectors` — every connector should be listed, most as grey
   "not configured". That page is the deploy's own smoke test.
2. Open `/` — the hub should render with fixture badges on every card and the
   Scan Strip animating.
3. Run the browser check against the deployed URL:
   ```bash
   VERIFY_BASE_URL=https://<your-deploy>.vercel.app npm run verify:browser
   ```
   It asserts every route renders, every KPI card carries source/grain/refreshed,
   and fixture data is visibly marked.
