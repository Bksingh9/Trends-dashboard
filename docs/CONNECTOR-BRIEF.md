# Connector brief — every remaining source

Status: open. Written 15 Aug 2026, after four sources met production for the
first time and three of the four turned out to be wrong.

This is a task prompt. Hand it back whole, or take one section at a time — each
`S-n` is independently shippable and leaves the tree green.

---

## 0. The method, which is not optional

Every connector in this build was written against a *guess* at its source's
shape. Every guess that has since met reality has been wrong:

| Source | What was assumed | What is actually true |
|---|---|---|
| `slack-catalogue-report` | Scan counts (`totalScans`, `uniqueFailed`…) | A **sync** report. None of those fields exist. Hourly, not daily. |
| `slack-alerts` | Free-text alerts to fingerprint | Structured Sentry payloads with typed fields |
| `bq-catalogue-master` | `gtin_value` is an EAN | 99.9% are `ALU` — internal article codes, not barcodes |
| `fynd-jio-impetus-prod` | A Loyalty analytics project (ADR-001) | A catalogue project. No `analytics_*` dataset exists |

So, in order, for every source below:

1. **Discover before writing.** `npm run discover` for BigQuery; read the
   channel for Slack; fetch the header row for Sheets; `gsutil ls` for GCS.
   Metadata reads are free — `__TABLES__` and `INFORMATION_SCHEMA` do not scan
   table bodies.
2. **Capture real payloads as committed fixtures.** See
   `fixtures/slack-samples.ts` and `fixtures/catalogue-report-samples.ts` for
   the pattern. A parser tested only against text its own author invented tests
   nothing but that author's imagination.
3. **Write the parser against those fixtures**, with every asserted number read
   off a real payload.
4. **Assert on parse rate, not row count.** A parser that understands one
   message in ten still returns rows and still looks healthy. `slack-alerts`
   has the pattern (`sentry_parse_rate`).
5. **Prove the load** with `npm run etl:seed <id>` — it runs the real
   `transform → assert → load` twice and compares row counts, because an upsert
   that is not idempotent returns a different number the second time.
6. **Then** run live and reconcile against a number somebody already believes.

### Non-negotiables

- **§5 is the contract.** Metric arithmetic lives in `lib/metrics/`. Arithmetic
  in a component is itself a bug.
- **Never invent a number to fill a hole.** Fixture fallback plus the visible
  §14.5 marker, always.
- **A new mart needs a writer.** `tests/connectors-live.test.ts` fails on any
  table the repository reads that no connector writes. It was added because
  `fact_scan_daily` and `fact_catalogue_gap` had no writer at all.
- **Every env var goes in `.env.example`.** Enforced by test. A credential
  documented nowhere is one nobody configures, and the connector sits grey
  forever with the reason invisible.
- **Never commit a service-account key.** `.gitignore` covers the common
  shapes; keys reach the app through `GCP_SA_KEY_JSON`.
- **Log non-obvious decisions in `docs/decisions/`.**

---

## S-1 · Google Sheets — store master and manual registers

**Connector:** `sheets-store-master` (exists, never run live).
**Blocked by:** §13.3 sheet contents, §13.2 read access.

The Companion store master is maintained by hand in Sheets and is the only
source for `dim_store` — store code, name, city, state, activation date,
`companion_live`. §19.3 applies with force: **store codes carry leading zeros**
and `00421` is not `421`. Anything that does `Number()` on a code silently
merges two stores.

Do:
1. Get `SHEET_STORE_MASTER_ID` and share the sheet with the service-account
   email (read-only is enough). The doctor's `checkSheets` proves the hop.
2. `values.get` on row 1 first. Commit the real header row as a fixture. The
   existing parser assumes column names that nobody has verified.
3. Header drift must **warn, not throw** — a renamed column is a Monday-morning
   event, and a dashboard that 500s on it is worse than one that says which
   column moved.
4. Also enumerate: `SHEET_GA4_EVENTS_ID` (the event dictionary) and
   `SHEET_TASKS_ID` (NOC task register). Both are referenced in config and
   neither has been opened.

**Done when:** `dim_store` loads live, 272 Companion-live stores reconcile
against §1's baseline, and a store code beginning `0` survives the round trip.

---

## S-2 · Slack — three channels, three different jobs

Parsers are rewritten and tested against real messages (22 tests). What is
missing is `SLACK_BOT_TOKEN` with `channels:history` (and `chat:write` for
alerting). Nothing else blocks these.

| Channel | ID | Carries | Connector |
|---|---|---|---|
| `#sng-catalogue-lack` | `C0AV6FU1YUU` | Hourly Catalog Sync Report, Tatsu Bot | `slack-catalogue-report` |
| `#companion-app-alerts` | `C0B0APYNZTQ` | Sentry alerts + nightly EOD digest | `slack-alerts` |
| NOC escalations | `C0BFJQDV05N` | Store escalations, free text | `slack-alerts` |

Already established from reading them:

- The catalogue report is **hourly** (SLA corrected 36 h → 90 min).
- Inbound/outbound is **explicit in the source**; §20.3 had inferred it.
- The SAP pipeline is genuinely `0/0/0`, confirming §13.9 hourly.
- Sentry org is `fynd-f7`; the seven services are `avis, computron, silverbolt,
  cartorderproxy, hashira, gringotts, megatron`.
- `EAN already assigned to item code` is the top outbound defect — 2,742 of
  2,935 in one hour — and matches what `bq-catalogue-master` finds structurally.

Do:
1. Run all three live; confirm parse rate ≥ 90%.
2. **Land the sync report in a mart.** It currently has nowhere to go.
   Proposal: `fact_catalogue_sync_hourly` (pipeline × direction × error type ×
   hour). It is a *different measurement* from scan coverage — §16.5.2 forbids
   blending them into one coverage number.
3. Wire the EOD digest's per-service counts to `/app-health` rather than
   `fact_issues`. It is not an incident.
4. `chat:write` enables the §8.5 alert path and the §28 daily brief. Both are
   written and neither has ever sent a message.

**Done when:** three connectors green, the sync report trends hourly on
`/catalogue`, and the top defect agrees with `bq-catalogue-master` to within
the window difference.

---

## S-3 · BigQuery — `sng-prod`, the biggest unlock

**Blocked by:** IAM. The `fynd-jio-impetus-prod` key returns **403** on
`sng-prod:INFORMATION_SCHEMA`.

This one project unblocks most of the dashboard: `bq-orders` (revenue, AOV,
the §1 baselines), `bq-ga4-events` (funnel), `bq-ga4-scans` (coverage, Scan
Strip, the §18.7 baseline). Four P0 connectors waiting on one grant.

Do:
1. Get `roles/bigquery.dataViewer` + `jobUser` on `sng-prod` for a service
   account. Ask for a Companion-specific SA rather than reusing the catalogue
   one — a key that can read everything is a key nobody can safely rotate.
2. `npm run discover` to settle **§13.1**, the highest-leverage open question
   in the build: the GA4 export dataset name. `discoverGa4Dataset()` already
   probes for it and nobody needs to be asked.
3. Run `EVENT_INVENTORY_SQL` and commit the output to
   `docs/source/EVENT_DICTIONARY.md`. That settles §5.2 and answers the
   question Prince Chaudhary asked on 6 Aug that nobody replied to.
4. Reconcile: trailing-28d orders ≈ 1,360, e-GMV ₹10–12 L, unique coverage
   ≈ 94.0%, 2,510 distinct missing EANs. If the pipeline cannot reproduce
   those for the same window, **the pipeline is wrong, not the baseline** (§1).

**Done when:** the §1 and §18.7 baselines reproduce from live data, and
`tests/baselines.test.ts` passes against the mart rather than fixtures.

---

## S-4 · The real EAN master — still unfound

`rbl_catalog_structured_v7` is **not** it (see ADR-001's addendum: 49,955 of
50,000 rows are `ALU`). Without a real master, every §20.3 gap reason is
`absent_from_master`, which is the most alarming reason in the taxonomy and
would be entirely an artefact.

Candidates, in order:
1. `multi_brand_catalog` — unexplored, reachable now.
2. `rbl_catalog_raw_v5` — the raw layer may retain barcode-typed identifiers
   the structured layer dropped.
3. The Orbis item table §20.2 names — in `sng-prod`, so blocked on S-3.
4. `rbl_catalog_structured_v7.product_attributes` — 24.7 lakh rows, an EAV
   shape. A barcode may live in an attribute row rather than a column.

Method: `npm run discover -- <dataset> <table>`, then check the identifier-type
distribution **before** wiring anything. The `gtin_type` filter and the
`fail`-level cardinality assertion are the guardrails; do not weaken them.

**Done when:** ≥ 80% of EANs in `fact_scan_daily` resolve against
`dim_product`, and the §20.3 reason mix stops being dominated by
`absent_from_master`.

---

## S-5 · GCS — unexplored, and the likeliest home for the XLSX reports

Not currently a connector. The lead: every Tatsu sync report ends with
_"XLSX reports attached in thread"_. Those attachments carry the **per-product**
failure detail the Slack summary only totals — the actual EANs behind
"2,742 EAN already assigned to item code". That is the difference between
knowing the number and being able to fix it.

Do:
1. `gsutil ls` across the project. Look for catalogue exports, RRA inventory
   (§7.7 "true coverage", currently `not_instrumented`), and store-master
   snapshots.
2. Decide the fetch path: GCS object, or Slack `files.list` on the thread. Slack
   is likely simpler and needs only `files:read`.
3. New connector `gcs-catalogue-exports` (or `slack-report-attachments`) →
   a per-EAN failure mart.
4. **Cost and PII gates:** an XLSX is unbounded. Cap the object size, and run
   §27.4 checks before loading anything with a customer identifier in it.

**Done when:** the per-EAN detail behind the top defect is queryable, and
`/catalogue` can name the actual products rather than only the count.

---

## S-6 · Kaily — establish relevance first

> Full task prompt: **`docs/KAILY-BRIEF.md`**. Reference surface:
> `console.fynd.com/kaily/asia-south1/accounts/048572c4-…/insights` — which is
> egress-blocked from the build container, so everything known about the API is
> read off the URL and off Slack, not verified.

Kaily is Fynd's AI agent platform (`@kaily-ai/chat-sdk`; agents, threads, tool
calls, an email surface on `inbox.kaily.fyndmail.com`; CoPilot product line).

**I have not confirmed it produces Companion-relevant data.** Treat that as the
first task, not an assumption — this brief exists because of what assumptions
cost the last four sources.

Do:
1. Answer, before writing any code: *does Companion or Trends use Kaily?* If a
   shopping assistant runs inside the AJIO Companion journey, its conversations
   are a genuine §4.3 journey source. If Kaily is only a separate product, it
   belongs in a different dashboard and the honest answer is to say so.
2. If relevant, find the store: BigQuery dataset, its own API, or Postgres.
3. Candidate metrics — assistant sessions, containment rate, hand-off to human,
   tool-call success, latency. Add them to §5 **first**; if a metric is not in
   §5, it does not exist.
4. §27.4 applies hard. Conversation logs are the highest-PII source in this
   entire brief. Hash customer ids at ingest; no free-text message bodies in
   any mart without an explicit decision recorded in `docs/decisions/`.

**Done when:** either a `/assistant` module backed by real conversation
aggregates, or an ADR recording that Kaily is out of scope and why.

---

## S-7 · The remainder

| Source | Needs | Notes |
|---|---|---|
| **Sentry API** | `SENTRY_AUTH_TOKEN` (`org:read`, `project:read`, `event:read`) | Org `fynd-f7` confirmed. Direct API beats parsing Slack — the Slack path is a fallback, not the design. |
| **Jira** | `JIRA_EMAIL`, `JIRA_API_TOKEN` | A11 open: the NI board is shared, so the P0 count is wrong until a Companion component/label filter is agreed. `/issues` already warns. |
| **GA4 Data API** | SA added to property `524294430` | A8 open: custom dimensions unregistered. Cross-check against the BQ export — if they disagree, the export wins (sampling). |
| **Amplitude** | `AMPLITUDE_API_KEY` + `MODULE_AMPLITUDE` | §24 says justify first: *which events exist here that GA4 lacks?* Two analytics sources that disagree is worse than one. Has no fixture, so its load path is untested. |
| **API latency** | §13.7 undecided | APM vs logs vs synthetic. SLOs are placeholders (A10) and the UI already labels them as such — do not let them start claiming breaches. |
| **`ga4-api`** | — | No fixture, load path unexercised. Named in `tests/connectors-live.test.ts` as deliberately deferred. |

---

## Acceptance for the whole brief

- `npm run etl:status` shows every configured connector green, each within its
  declared freshness SLA.
- No mart is read but unwritten (`tests/connectors-live.test.ts`).
- §1 and §18.7 baselines reproduce from live data.
- Every page renders `live`, or says exactly why not — `stale` names the feed
  and its age, `fixture` names the connector, `missing` gives the reason.
- Parse rate ≥ 90% on every text-derived source.
- `npm run test` and `npm run e2e` green with **and** without `DATABASE_URL`.
- Every open assumption either closed, or restated in `ADR-000` with what would
  close it.

## Landmines already found — do not rediscover these

- BigQuery rejects a job label containing `:`.
- `ON CONFLICT DO UPDATE` fails if one batch touches a row twice. Real
  catalogue data contains duplicate `(ean, item_code)` pairs — dedupe on the
  natural key before loading, and publish the collapsed count as a finding.
- `gtin_value` arrives float-formatted (`410219992001.0`) from a FLOAT64
  upstream. Strip the artefact; never `Number()` — that eats leading zeros.
- A successful `SELECT` proves the table exists, not that anything still fills
  it. That is the `avis_base_view` failure exactly.
- `fixtureFallback` does **not** call `load()`. Use `etl seed` to exercise it.
- Seeded rows are flagged and render as `fixture` however many there are.
- Vercel Hobby runs cron once daily, so the tightest SLA silently becomes
  daily. `/api/cron/tick` reports the cadence it needs.
