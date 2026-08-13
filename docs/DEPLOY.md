# Deploying to Vercel

The app is deploy-ready as-is: it builds clean, requires no credentials to run,
and serves labelled fixtures for every connector that isn't configured yet.

---

## Cron schedule — currently set for Hobby

Vercel's **Hobby plan allows 2 cron jobs, once a day**, so `vercel.json` ships
with exactly that: one nightly run of every connector, and the morning brief.

```json
"crons": [
  { "path": "/api/cron/all",              "schedule": "0 1 * * *" },
  { "path": "/api/insights?post=slack",   "schedule": "30 2 * * *" }
]
```

Everything still refreshes daily and the brief still lands before stand-up. What
you give up is the near-live cadence — the Scan Strip won't move within a day,
and a connector failure surfaces the next morning rather than within the hour.

Cron schedules in `vercel.json` are **UTC**. `30 2 * * *` is 08:00 IST.

### On upgrading to Pro, paste this back

The §6.4 cadence, which is what the dashboard is designed around:

```json
"crons": [
  { "path": "/api/cron/bq-orders",              "schedule": "0 * * * *" },
  { "path": "/api/cron/bq-ga4-events",          "schedule": "15 * * * *" },
  { "path": "/api/cron/slack-catalogue-report", "schedule": "*/30 * * * *" },
  { "path": "/api/cron/sheets-store-master",    "schedule": "30 0 * * *" },
  { "path": "/api/cron/bq-catalogue-master",    "schedule": "30 23 * * *" },
  { "path": "/api/cron/sentry",                 "schedule": "*/15 * * * *" },
  { "path": "/api/cron/jira",                   "schedule": "*/30 * * * *" },
  { "path": "/api/cron/gcp-logging",            "schedule": "*/15 * * * *" },
  { "path": "/api/cron/api-latency",            "schedule": "20 * * * *" },
  { "path": "/api/cron/slack-alerts",           "schedule": "*/30 * * * *" },
  { "path": "/api/cron/test-ean-canary",        "schedule": "0 20 * * *" },
  { "path": "/api/insights?post=slack",         "schedule": "30 2 * * *" }
]
```

### Meanwhile, on Hobby

Any connector can still be run on demand — from the manual re-run on
`/connectors`, or directly:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://<host>/api/cron/slack-catalogue-report
```

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
