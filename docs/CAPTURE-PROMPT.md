# Master capture-and-build prompt — all sources

For an agent with a **Chrome extension and a logged-in Fynd session**.

Written 15 Aug 2026. Repo: `Bksingh9/Trends-dashboard`, branch
`claude/companion-trends-dashboard-0uf9zs`.

---

## Why this document is shaped this way

The build container has **no egress to Fynd hosts**. `console.fynd.com`,
`api.fynd.com` and `kaily.fynd.com` all return no connection at all. GA4,
Sentry and Slack's web UI are equally unreachable. Google's APIs *are*
reachable, and one BigQuery service account works.

So the browser is not a convenience here — it is the only thing that can reach
half the sources. Its unique capability is **an authenticated session**, and
the tasks below are split accordingly:

- **CAPTURE** — only a logged-in browser can do it. This is the scarce resource.
- **BUILD** — the repo can do it, once the capture exists.

Do all the CAPTURE work in one pass while the session is live. Each capture is
small: a header row, a JSON response, a page of table names. Then build offline.

---

## The method, which is not optional

Four sources have now met production. **Three were wrong**, in ways no amount
of code review would have caught:

| Source | Assumed | Actually |
|---|---|---|
| `slack-catalogue-report` | Scan counts (`totalScans`, `uniqueFailed`…) | A **sync** report. Zero of those fields exist. Hourly, not daily. |
| `slack-alerts` | Free text to fingerprint | Structured Sentry payloads with typed fields |
| `bq-catalogue-master` | `gtin_value` is an EAN | 99.9% are `ALU` internal article codes |
| `fynd-jio-impetus-prod` | Loyalty analytics project | A catalogue project — no `analytics_*` dataset |

Therefore, for every source:

1. **Capture the real payload first.** Never write a parser against an
   imagined shape.
2. **Commit the capture as a fixture** — `fixtures/slack-samples.ts` and
   `fixtures/catalogue-report-samples.ts` are the pattern. Redact PII; keep
   structure.
3. **Parse against the fixture**, every asserted number read off a real payload.
4. **Assert on parse rate, not row count.** A parser that understands one
   message in ten still returns rows and still looks healthy
   (`slack-alerts` → `sentry_parse_rate`).
5. **Prove the load**: `npm run etl:seed <id>` runs the real
   `transform → assert → load` twice and compares counts, because a
   non-idempotent upsert returns a different number the second time.
6. **Then** run live and reconcile against a number somebody already believes.

### Non-negotiables

- §5 is the contract — metric arithmetic in `lib/metrics/`, never a component.
- Never invent a number. Fixture fallback + the visible §14.5 marker.
- A new mart needs a writer in the same commit (orphan-mart test enforces it).
- Every env var in `.env.example` (test enforces it).
- Never commit a service-account key or a bearer token.
- Log non-obvious decisions in `docs/decisions/`.

---

# PART A — CAPTURE (browser session required)

## A-1 · Kaily insights ⭐ highest value, wholly unreachable otherwise

`console.fynd.com/kaily/asia-south1/accounts/048572c4-12d3-47e2-a0eb-1260a2b44472/insights`

1. Open with **DevTools → Network → Fetch/XHR**, then reload.
2. For the call(s) that populate the page, record:
   - full request URL, method, and where the account UUID sits (path vs query)
   - auth mechanism — cookie, `Authorization: Bearer`, or an API-key header
     (**record the header *name*, never the value**)
   - any date-range or granularity parameters
   - **the complete response body, verbatim**
3. Change the date range on the page and capture a second response. That
   reveals the range parameter, which no amount of guessing will.
4. Note whether the response is paginated (`next`, `cursor`, `has_more`,
   `total` vs returned length).
5. In the same session, check for a warehouse: does anything at
   `console.fynd.com` expose a BigQuery/dataset name for Kaily? A nightly
   warehouse read beats polling a product API — cheaper, stabler, auditable.

**Also answer, in writing — this gates everything else:** does the AJIO
Companion journey embed a Kaily assistant, and is `048572c4-…` the Trends
tenant? If no, the correct deliverable is `ADR-004-kaily-scope.md` saying so,
and that is a complete success. §0 scopes this dashboard to Companion; Kaily is
a CoPilot product.

**Free and offline, do it anyway:** `npm install @kaily-ai/chat-sdk` and read
its types. Public package, real domain model, zero credentials.

## A-2 · Google Sheets — the three sheets nobody has opened

1. **Store master** — open it and capture **row 1 verbatim**, exact column
   names, spelling and order. Note the sheet/tab name and the ID from the URL
   (`/spreadsheets/d/<ID>/`).
2. Confirm whether store codes render as **text with leading zeros** (`00421`)
   or have been coerced to numbers (`421`). §19.3: if the sheet itself has lost
   the zeros, that is a data-quality finding to raise, not something to patch
   downstream.
3. Same for `SHEET_GA4_EVENTS_ID` (event dictionary) and `SHEET_TASKS_ID`
   (NOC task register) — both referenced in config, neither ever opened.
4. Share all three with the service-account email, Viewer is enough.

## A-3 · GA4 — settle §13.1, the highest-leverage unknown in the build

`analytics.google.com` → property `524294430`.

1. **Admin → Product Links → BigQuery Links.** Capture the **exact project and
   dataset name** of the export. This single string unblocks `bq-ga4-events`
   and `bq-ga4-scans`.
2. **Admin → Custom definitions.** Capture every registered custom dimension
   and its event-parameter name — this is open assumption **A8**.
3. **Reports → Realtime / Events.** Capture the event-name list; cross-check
   against `FUNNEL_STEPS` in `fixtures/business.ts`. Any funnel step with no
   matching event is a real instrumentation gap (§16.9), not a bug to hide.
4. Add the service account to the property (Viewer) so `ga4-api` can run.

## A-4 · Sentry — org `fynd-f7` (confirmed from real alerts)

1. Create an auth token with `org:read`, `project:read`, `event:read`.
2. Capture the **project slugs**; expect `avis, computron, silverbolt,
   cartorderproxy, hashira, gringotts, megatron`. Confirm rather than assume.
3. Capture one issue's JSON from the API (not the UI) so the parser has a real
   shape — the Slack path is a **fallback**, not the design.

## A-5 · Jira — settle A11

`gofynd.atlassian.net`, project from `JIRA_PROJECT_KEY`.

1. Create an API token.
2. **The open question:** the NI board is shared, so the Companion P0 count is
   currently wrong and `/issues` says so. Capture the **component or label**
   that identifies Companion issues. Without it the count stays wrong.
3. Capture one issue JSON, including the fields for workstream and journey step.

## A-6 · Slack — the attachments, which are the real prize

Parsers are already rewritten and tested against 22 real messages. What is
missing is a token and one thing only a browser can get.

1. Create a bot token: `channels:history`, `chat:write`, **`files:read`**.
2. **In `#sng-catalogue-lack`, open a Tatsu report thread and download the
   attached XLSX.** Every report ends *"XLSX reports attached in thread"*, and
   those files carry the **per-product** detail behind the summary — the actual
   EANs behind "2,742 EAN already assigned to item code". That is the
   difference between knowing the number and being able to fix it.
3. Capture the XLSX **column headers** (not the data — it may carry PII).
4. Note the file naming convention and whether it is per-hour or per-day.

## A-7 · GCS — unexplored

1. In the Cloud console, list buckets in the reachable projects.
2. Look for catalogue exports, **RRA inventory** (§7.7 "true coverage",
   currently `not_instrumented`), and store-master snapshots.
3. Capture bucket names, path conventions and one object listing. Do **not**
   download anything large — note sizes instead.

## A-8 · BigQuery IAM — the single biggest unlock

`sng-prod` returns **403** on `INFORMATION_SCHEMA` with the existing key.

Request `roles/bigquery.dataViewer` + `roles/bigquery.jobUser` on `sng-prod`
for a **Companion-specific** service account — not the catalogue one. A key
that reads everything is a key nobody can safely rotate.

This one grant unblocks four P0 connectors: `bq-orders` (revenue, AOV, the §1
baselines), `bq-ga4-events` (funnel), `bq-ga4-scans` (coverage, Scan Strip, the
§18.7 baseline).

---

# PART B — BUILD (offline, once captures exist)

Order is by leverage, not by section number.

## B-1 · `sng-prod` lands → reconcile the baselines

```bash
npm run discover                         # settles §13.1 if A-3 did not
npm run etl:seed bq-orders bq-ga4-scans  # prove the load path first
npm run etl:run -- bq-orders
```
Then reconcile: trailing-28d orders ≈ **1,360**, e-GMV **₹10–12 L**, unique
coverage **≈ 94.0%**, **2,510** distinct missing EANs. If the pipeline cannot
reproduce those for the same window, **the pipeline is wrong, not the
baseline** (§1). Commit `EVENT_INVENTORY_SQL` output to
`docs/source/EVENT_DICTIONARY.md` — that settles §5.2 and answers the question
Prince Chaudhary asked on 6 Aug that nobody replied to.

## B-2 · Sheets → `dim_store` live

Fixture the captured header row; make header drift **warn, not throw** (a
renamed column is a Monday-morning event, and a 500 is worse than a message
naming the column). Verify a `0`-leading store code survives the round trip.
Reconcile to 272 Companion-live stores.

## B-3 · Slack → run live, and land the sync report

Three connectors green at ≥ 90% parse rate. Then **give the sync report a
mart** — it currently has nowhere to go. Proposal
`fact_catalogue_sync_hourly`, grained pipeline × direction × error type × hour.
It is a **different measurement** from scan coverage; §16.5.2 forbids blending
them into one number. Route the EOD digest's per-service counts to
`/app-health`, not `fact_issues` — it is not an incident.

## B-4 · XLSX attachments → per-EAN failure detail

New connector from A-6. Cap object size; run §27.4 checks before loading
anything with a customer identifier. Target: `/catalogue` names the actual
products behind the top defect, not just the count.

## B-5 · The real EAN master — still unfound

`rbl_catalog_structured_v7` is **not** it (ADR-001 addendum: 49,955 of 50,000
rows are `ALU`). Candidates: `multi_brand_catalog`, `rbl_catalog_raw_v5`, the
Orbis table in `sng-prod`, or `product_attributes` (24.7 lakh rows, EAV shape —
a barcode may live in an attribute row). Check the **identifier-type
distribution before wiring anything**. Do not weaken the `gtin_type` filter or
the `fail`-level cardinality assertion; they are what stopped the dashboard
reporting the entire catalogue as `absent_from_master`.

## B-6 · Kaily

Only if A-1 established relevance. **Read Kaily's aggregates, don't recompute
them** — recomputing "containment rate" from message logs guarantees a number
that disagrees with the one the Kaily team quotes, and then two teams argue
about arithmetic instead of the product. Their definition still enters §5
verbatim, `ambiguous: true` where it isn't crisp.

**§27.4 is the hard part.** Conversation logs are the highest-PII source in the
build: order rows carry a hashed customer id, chat carries whatever a person
typed, and the email surface means inbound addresses too. No free-text bodies
in any mart. Hash identifiers at ingest. Redact fixtures — a fixture is in git
forever. **A metric computable only by reading message content is a finding to
raise, not a licence to store it.**

## B-7 · Sentry, Jira, GA4 API, Amplitude

Sentry direct-API beats the Slack path. Jira needs the A-5 filter or the P0
count stays wrong. GA4 API: cross-check against the BQ export — **if they
disagree, the export wins** (sampling). Amplitude stays off until §24 is
answered: *which events exist here that GA4 lacks?* Two analytics sources that
disagree is worse than one.

---

## Acceptance for the whole programme

- `npm run etl:status` — every configured connector green, within its SLA.
- No mart read but unwritten.
- §1 and §18.7 baselines reproduce from **live** data;
  `tests/baselines.test.ts` passes against the mart, not fixtures.
- Every page renders `live`, or says exactly why not: `stale` names the feed
  and its age, `fixture` names the connector, `missing` gives the reason.
- Parse rate ≥ 90% on every text-derived source.
- `npm run test` and `npm run e2e` green **with and without** `DATABASE_URL`.
- No PII in any fixture, mart or log.
- Every open assumption closed, or restated in `ADR-000` with what would close it.

## Landmines already paid for — do not rediscover

- BigQuery rejects a job label containing `:`.
- `ON CONFLICT DO UPDATE` fails if one batch touches a row twice. Real
  catalogue data has duplicate `(ean, item_code)` pairs — dedupe on the natural
  key, and publish the collapsed count as a finding, because those duplicates
  *are* the §20.3 defect.
- `gtin_value` arrives float-formatted (`410219992001.0`) from a FLOAT64
  upstream. Strip the artefact; never `Number()` — it eats leading zeros.
- A successful `SELECT` proves the table exists, **not** that anything still
  fills it. That is the `avis_base_view` failure exactly.
- `fixtureFallback` does **not** call `load()`. Use `etl seed`.
- Seeded rows are flagged and render as `fixture` however many there are.
- `runQuery` returned exactly 50,000 rows — that was a **page**, not a total.
- Vercel Hobby runs cron once daily, so the tightest SLA silently becomes
  daily. `/api/cron/tick` reports the cadence it needs.
- A UUID in a console URL is a **tenant scope**, not a filter. The wrong one
  returns a valid-looking empty result rather than an error.
