# ADR-000 — Open assumptions register

**Status:** open · **Created:** 2026-08-13 · **Owner:** Brijkishor Singh (PM)

Fourteen things the spec does not know. Each is a place where guessing would
produce code that looks finished and fails on contact with real data.

**The rule for every row:** do not silently pick an answer. Verify it, or
implement the stated interim behaviour and surface the ambiguity in the UI. As
each is resolved, record the answer, the date, and who confirmed it here. An
assumption resolved quietly in a commit message is an assumption that will be
re-litigated in three months.

Never acceptable: picking the likely answer, hard-coding it, and moving on. The
two silent data failures this system has already produced — a BigQuery view
stale for two weeks while reporting itself healthy, and a catalogue report that
stopped generating unnoticed — both had the same shape: something plausible was
assumed and nothing checked it.

---

## Status at implementation time

| # | Assumption | Status | Interim behaviour implemented | Where |
|---|---|---|---|---|
| **A1** | `avis_base_view` column names | **OPEN** | Alias-driven column resolution; a rename produces a warning naming the headers found, not a column of nulls. Schema-discovery query committed. | `lib/connectors/bq-orders.ts` `COLUMN_ALIASES`, `SCHEMA_DISCOVERY_SQL` |
| **A2** | Monetary values are rupees, not paise | **OPEN** | `BQ_ORDERS_CURRENCY_DIVISOR` env, default 1. Test asserts AOV lands in ₹300–3,000 and trailing-28d e-GMV inside the ₹10–12 L band — a 100× error fails the build. | `lib/connectors/bq-orders.ts`, `tests/baselines.test.ts` |
| **A3** | Which `status` values count as confirmed | **OPEN** | Both variants computed and stored (`orders` and `orders_confirmed`, plus a per-row `status_confirmed`). UI shows the inclusive figure with an ambiguity marker naming the caveat. | `lib/metrics/compute.ts`, `components/data-state/AmbiguityMarker` |
| **A4** | GA4 → BQ dataset is `analytics_524294430` | **OPEN — highest leverage** | `discoverGa4Dataset()` probes `INFORMATION_SCHEMA.SCHEMATA` across candidate projects. No assumption is hard-coded; `BQ_GA4_DATASET` is empty until confirmed, and the connector reports itself blocked. | `lib/connectors/bq-ga4-events.ts` |
| **A5** | Scan-event params populated **in production** | **OPEN** | `PARAM_FILL_SQL` checks non-null rates per parameter, not just presence. `store_id` fill rate is the one to watch. | `lib/connectors/bq-ga4-events.ts` |
| **A6** | An invoice / de-tag event exists | **OPEN — likely NOT instrumented** | `invoice_detag` ships with `is_instrumented = false`. Renders hatched as "not instrumented", never as zero, and is listed on `/journey` as an instrumentation gap. | `fixtures/business.ts` `FUNNEL_STEPS`, `app/(dash)/journey/page.tsx` |
| **A7** | GA4 property timezone is IST | **OPEN** | All aggregation groups on `DATE(..., 'Asia/Kolkata')`. If the property is UTC, the funnel and revenue will not tie — the `ga4_purchases_vs_orders` cross-check catches a systematic gap. | `lib/format/dates.ts`, `lib/connectors/bq-ga4-events.ts` |
| **A8** | Scan params registered as GA4 custom dimensions | **OPEN** | `scanParamsAreRegistered()` is called before building the report request; unregistered dimensions are simply omitted rather than returning empty rows. | `lib/connectors/ga4-api.ts` |
| **A9** | Companion's GTM container id | **OPEN** | Not used anywhere. Only the Kiosk container (`GTM-MKCSW89D`) is known and it is a **different app** — it is referenced as a target taxonomy only. | `fixtures/business.ts` |
| **A10** | Latency SLOs (800/1200/1500/500/1000 ms) | **OPEN — placeholders** | `slo_confirmed` defaults to `false` per endpoint. `isBreaching()` returns false for unconfirmed SLOs; the UI labels them "placeholder" and alerting is gated. | `lib/db/settings.ts`, `lib/connectors/api-latency.ts` |
| **A11** | Which Jira component isolates Companion in `NI` | **OPEN** | `JIRA_COMPONENT_FILTER` is unset, so the JQL is project-only. `/issues` shows a persistent banner that the count inherits other products' bugs. `profileDiscriminators()` lists the real components and labels. | `lib/connectors/jira.ts`, `app/(dash)/issues/page.tsx` |
| **A12** | The reference dashboard's IA | **OPEN — never observed** | The hub-of-modules pattern was adopted from metadata plus the §29 mapping. Run the Appendix A.5 extraction before design lock and reconcile. | §3.2 IA implemented in `app/(dash)/` |
| **A13** | Store master contains id, code, city, no test stores | **OPEN** | Header alias table hard-fails with the actual headers on a missing required column; test-looking stores are warned and excluded at load. | `lib/connectors/sheets-store-master.ts` |
| **A14** | GA4 streaming (intraday) export enabled | **OPEN** | `hasIntraday()` probes for the table. The Scan Strip falls back to last-complete-day mode and says so — it never fakes liveness. | `lib/connectors/bq-ga4-events.ts`, `components/charts/ScanStrip.tsx` |

---

## The four that can invalidate real work

**A2 is the most dangerous single line in the spec.** A rupees-versus-paise error
produces a dashboard that is wrong by two orders of magnitude while looking
entirely normal, and it would be shown to Reliance leadership before anyone
questioned it. The baseline test in `tests/baselines.test.ts` is the guard: if
the pipeline cannot land trailing-28d e-GMV inside the ₹10–12 L band, the build
fails.

**A1, A5 and A12** are the others. A1 and A5 are answerable by a single query
once BigQuery access exists. A12 needs the Appendix A.5 capture.

## The six that close cheaply

A4, A6, A7, A8, A11 and A14 are each answerable by one query or one settings
page, with no permission beyond what Phase 2 already requires. Do these first.

**A4 first of all.** It gates the funnel, the Scan Strip, scan-level catalogue
analysis, and the long-term replacement of the Slack bot as the catalogue
source — and it may not need anyone's permission:

```sql
SELECT schema_name
FROM `sng-prod.INFORMATION_SCHEMA.SCHEMATA`
WHERE schema_name LIKE 'analytics_%';
```

---

## Deviations from the spec recorded here

**§0 env-guard secret exclusion.** `assertProductionOnly` skips values whose key
matches `(SECRET|TOKEN|PASSWORD|_KEY|KEY_JSON|CREDENTIALS|DATABASE_URL)$`.
Scanning an opaque secret for environment markers is pointless (a token is not an
environment identifier) and actively harmful: a base64 secret containing `-uat-`
would hard-fail boot for no reason. Every value that actually names an
environment is still covered. Tested in `tests/production-guard.test.ts`.

## Resolution log

| Date | Assumption | Answer | Confirmed by |
|---|---|---|---|
| _(none yet)_ | | | |
