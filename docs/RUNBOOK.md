# Runbook

What each connector failure looks like and how to fix it. Written so someone
other than the author can fix a broken connector.

---

## First question, always: is this a data problem or a business problem?

Given this system's history — `avis_base_view` stale for two weeks while
reporting itself healthy (DOPS-25241), and the Tatsu catalogue report silently
ceasing to generate (flagged 11 Aug) — **the most likely explanation for a
sudden metric collapse is that a pipe broke.** Check that before waking anyone.

1. Open `/connectors`. Any red row is your answer.
2. If a metric reads zero and its connector is green, check the **row-count
   reconciliation**, not just freshness: a fresh `max(order_ts)` with an
   anomalously low count for yesterday is the same failure wearing a disguise.
3. The `pipeline_not_business` RCA rule on `/insights` runs this check for you
   and is always evaluated first.

---

## How the assertion gate behaves

| Verdict | What happens | What you see |
|---|---|---|
| `pass` | Mart updated | Connector green |
| `warn` | Mart updated, cards flagged | Connector amber, caution marker on affected cards |
| `fail` | **Mart untouched.** Last good snapshot keeps serving | Connector red, Slack alert posted |

A hard fail never overwrites good data with bad. That is the point: the
dashboard degrades to stale-but-labelled, never to confidently-wrong.

---

## Per-connector triage

### `bq-orders` — BigQuery orders and revenue (P0)

| Symptom | Likely cause | Fix |
|---|---|---|
| `freshness:orderTs` fails | `avis_base_view` has gone stale upstream — this has happened before | Raise a DOPS ticket against the Avis pipeline. Do **not** widen the freshness SLA to make the alert go away |
| `row_volume` warns but freshness passes | Late-arriving or partially-loaded partition | Re-run the trailing 7 days: `POST /api/cron/bq-orders?start=…&end=…` |
| `value_set:affiliateId` fails | A non-production affiliate id is present in ingested rows | **Do not load.** Something upstream has merged environments — §0 violation. Escalate |
| `uniqueness:orderId` fails | The view has started emitting one row per state transition rather than per order | Re-introspect the schema (`SCHEMA_DISCOVERY_SQL`) and adjust the grain |
| Revenue is 100× out | A2 — paise vs rupees | Set `BQ_ORDERS_CURRENCY_DIVISOR=100`. Confirm against the ₹3.29 L April baseline first |
| Order counts feel wrong by ~10% | A3 — status enum unconfirmed | Compare `orders` against `orders_confirmed` on `/sales`. Resolve the enum with the Avis owner and record it in ADR-000 |

**Backfill:** `pnpm etl:backfill --connector=bq-orders --from=… --to=… --chunk=7d`.
Every `load()` is an upsert on `order_id`, so re-running any window is safe.

### `bq-ga4-events` — GA4 export (P0, currently blocked)

| Symptom | Likely cause | Fix |
|---|---|---|
| Connector shows "blocked" | A4 — the dataset name is unknown | Run `discoverGa4Dataset()`, or the `INFORMATION_SCHEMA.SCHEMATA` query in §16.1. Set `BQ_GA4_PROJECT` and `BQ_GA4_DATASET` |
| `paramPresence` fails on `store_id` | A5 — the param fires in pre-prod but arrives empty in production | Run `PARAM_FILL_SQL`. **Everything store-level collapses without `store_id`** — treat as P0 instrumentation |
| `cardinality:storeId` warns | Fewer than 50 distinct stores in the window | Either genuine (holiday) or the param has partially broken. Check the fill rate |
| `ga4_purchases_vs_orders` drift widens | Instrumentation broke, or the order pipeline did | Both directions are worth checking. A widening gap is the cheapest early warning available |
| BigQuery bill jumps | A wildcard query lost its `_TABLE_SUFFIX` filter | Check job labels: every job is labelled `connector=bq-ga4-events`. The dry-run gate should have caught it |
| Scan Strip says "last complete day" | A14 — streaming export is off | Either enable intraday export or accept the fallback. Do not fake liveness |

### `slack-catalogue-report` — Tatsu daily report (P0)

| Symptom | Likely cause | Fix |
|---|---|---|
| `missing_report` warns | The bot did not post — **this has gone unnoticed before** | Check Tatsu and the upstream GA4→BQ job that feeds it |
| `coverage_reconcile` warns | The parser drifted, or the bot's own arithmetic changed | The raw message is in `etl_run_log`. Compare the parsed components against the bot's stated % |
| Parse failure logged, no rows | The bot template changed | Update `FIELD_PATTERNS`. It degrades to a warning by design — it will not crash |
| Series starts abruptly mid-history | §18.3 — pagination fails after ~2 pages in this workspace | Expected. Unreachable days are written with `report_generated = NULL` and render hatched. Do not backfill them as zeros |

**Acceptance check after any parser change:** 30 Jul – 12 Aug 2026 must reproduce
94.0% unique coverage, 2,510 distinct missing, 41,628 unique scans. `npm test`
asserts this.

### `sheets-store-master` — the store dimension (P0)

| Symptom | Fix |
|---|---|
| Hard fail naming the headers found | A column was renamed in the sheet. Add the new name to `ALIASES` — do not rename the sheet back |
| Store codes lost their leading zeros | Something called `Number()`. `00421` became `421` and joins are silently dropping. Check `normalizeStoreCode` is on the path |
| Test stores appear in prod numbers | The loader warns and excludes on `/\b(test|uat|dummy|demo)\b/`. Widen the pattern if a new convention appears |
| Sheets API unavailable | Export CSV via Appendix A.2 to `docs/source/store_master.csv`. The connector reads it automatically |

### `sentry`, `jira`, `gcp-logging`, `api-latency`

| Connector | Common failure | Fix |
|---|---|---|
| `sentry` | Org-wide rate limit | Aggregate endpoints over per-issue loops. Do not add per-issue polling |
| `jira` | P0 count too high | A11 — the `NI` board is shared across four products. Set `JIRA_COMPONENT_FILTER`. Use `profileDiscriminators()` to find the right one |
| `jira` | "Unmapped Jira priority" warning | A new priority name exists. Add it to `PRIORITY_MAP` — the default of P2 could hide a P0 |
| `gcp-logging` | Slow or quota-heavy | You are using `entries.list` for counting. Switch to the log-based metric via Cloud Monitoring (§23.2) |
| `api-latency` | Breach alerts firing constantly | A10 — the SLOs are placeholders. `slo_confirmed` should be `false` until real thresholds exist |

---

## Common operations

```bash
# Run one connector for its default window
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://<host>/api/cron/bq-orders

# Run one connector for a specific window
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://<host>/api/cron/bq-orders?start=2026-08-01&end=2026-08-13"

# Run everything, sequentially (shared quota buckets)
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/all

# Post today's brief to Slack
curl "https://<host>/api/insights?post=slack"

# Verify every route in a real browser
npm run build && npx next start -p 3100 &
VERIFY_BASE_URL=http://127.0.0.1:3100 npm run verify:browser
```

## Refresh cadence (§6.4)

| Data | Cadence |
|---|---|
| Scan strip | 5 min |
| GA4 funnel aggregates | 60 min |
| Orders / revenue | 60 min, plus 02:00 IST full-day rebuild of trailing 7d |
| Catalogue daily report | Poll every 30 min |
| Sentry / errors | 15 min |
| Jira | 30 min |
| Store master | Daily 06:00 IST |
| AI daily brief | 08:00 IST + on demand |

All times IST. Timestamps are stored UTC and rendered IST. Never mix.

## Cost control

- Every BigQuery job carries `maximumBytesBilled` and a `connector=` label.
- Queries spanning more than 7 days dry-run first and refuse if over budget.
- `bq-ga4-events` is the main cost risk: suffix pruning is mandatory, never
  `SELECT *` on `events_*`, and aggregates are materialised into Postgres once.
- Set a GCP budget alert on `sng-prod`.

## Escalation

| Area | Channel |
|---|---|
| Production alerts | `#companion-prod-alerts` (`C0B0APYNZTQ`) |
| Catalogue | `#sng-catalogue-lack` (`C0AV6FU1YUU`) |
| NOC / store issues | `C0BFJQDV05N` |
| Infra / access (DOPS tickets) | `#kube-infra` (`CN40SQPSA`) |
