# Companion App (Trends) — Unified Business & Health Dashboard

One authenticated dashboard covering six domains for the Companion App at
Reliance Trends — business health, journey funnel, store adoption, catalogue
health, tech health, and issues — plus an AI insight layer.

**Production only.** One environment, one application id, one GA4 property, one
BigQuery project. A boot-time guard throws if any non-production value reaches
config, and `bq-orders` refuses to load rows carrying any other affiliate id.

---

## Quick start

```bash
npm install
npm run build
npm start            # http://localhost:3000
```

No credentials are required to run it. Every connector has a fixture fallback
and every fixture-backed card is visibly marked, so the dashboard is deployable
and demo-able from the first commit.

```bash
npm test             # 92 tests: baselines, EAN hygiene, metrics, AI scenarios, prod guard
npm run typecheck
npm run verify:browser   # drives real Chromium over all 11 routes
```

---

## The three rules that govern everything here

1. **§5 is a contract.** Every metric is defined once in `lib/metrics/registry.ts`
   with a formula, a source, and a grain. The API and UI import from there. A
   component that computes a percentage is a bug. `metricValue()` throws on an
   id that isn't in the registry.

2. **Data honesty is not optional.** Every number carries its source, grain and
   last-refreshed time — enforced by the type, since `KpiCard` accepts only a
   `MetricValue` and those fields are required. A missing event renders as
   *not instrumented*, never as zero. A broken connector serves the last good
   snapshot and says so.

3. **Nothing blocks on a credential.** Everything in §13 has a fixture fallback
   behind a flag.

---

## What's here

```
app/(dash)/        11 routes: hub, sales, journey, stores, catalogue,
                   app-health, issues, insights, connectors, reference, settings
app/api/           10 routes, all returning the §9.3 envelope
lib/metrics/       §5 — the metric dictionary and every formula, once
lib/connectors/    13 connectors, all implementing the same lifecycle
lib/assertions/    §6.3 — the gate that runs before any mart is written
lib/ai/            anomaly detection, RCA rules, prompts, SQL guard
lib/db/            §7 — the full Postgres schema in Drizzle
fixtures/          realistic data reproducing the §1 and §18.7 baselines
docs/decisions/    ADR-000 — the open assumptions register
docs/RUNBOOK.md    what each connector failure looks like and how to fix it
```

### The five data states

Empty, loading, stale, down, and **not-instrumented** are five distinct visual
states (`components/data-state/`). The last one matters most: it is the
difference between "nobody did this" and "we never measured it". The final step
of the core journey — invoice / de-tag — is almost certainly not instrumented
today, and the dashboard shows that as a gap rather than a 0%.

### The signature element

The **Scan Strip** renders the last 90 minutes of scan activity as vertical bars
at 1-minute resolution, failures as red ticks at the baseline. Read left to
right it looks like a barcode and behaves like one: dense where stores are busy,
gapped where they've gone quiet, red-flecked where the catalogue is failing.

---

## Reconciliation against known baselines

The build fails if the pipeline can't reproduce the real reported figures:

| Baseline | Source | Asserted in |
|---|---|---|
| 41,628 unique scans, 2,510 distinct missing, 94.0% coverage (30 Jul – 12 Aug 2026) | Daily scan report | `tests/baselines.test.ts` |
| ~1,360 trailing-28d orders, ₹10–12 L e-GMV | Internal reporting, Apr–May 2026 | `tests/baselines.test.ts` |
| 272 of 1,765 stores Companion-live (~15%) | §1 | `tests/baselines.test.ts` |

**A2 is why the e-GMV assertion exists.** A rupees-versus-paise error produces a
dashboard that is wrong by two orders of magnitude while looking entirely
normal, and it would be shown to Reliance leadership before anyone questioned
it.

---

## Three coverage measurements, permanently distinct

| Measurement | Denominator | Typical | Answers |
|---|---|---|---|
| Scan-observed | Valid customer scan attempts | ~94% | Of what customers tried to scan, how much worked |
| Store-visit audited | Random shelf sample by an auditor | ~55–70% | Of what's on the shelf, how much is scannable |
| True coverage | SAP catalogue master | unknown | Of what should exist, how much does |

The gap between the first two is not an error — customers mostly scan things
that work; an auditor scans at random. `/catalogue` shows them side by side,
because the difference is itself the finding. They are never blended.

---

## The AI layer writes; it does not decide

```
anomaly detector (MAD z-score, deterministic)
   → rule engine (candidate causes)
      → context builder (named numbers, never raw rows)
         → model (writes prose, cites metric ids)
```

Statistics decide what is anomalous. Rules decide what the candidates are. The
model turns that into language. A model outage degrades the dashboard to
correct-but-terse, never to broken — and output containing numbers absent from
the context is rejected in favour of the deterministic brief.

`tests/ai-scenarios.test.ts` is the §28.8 eval harness. The two cases that
matter most: a stale pipeline must not be reported as a sales collapse, and an
uninstrumented event must not be reported as a 0% rate.

---

## Configuration

See `.env.example`. Nothing is required to run. The ones that unblock the most:

| Variable | Unblocks |
|---|---|
| `GCP_SA_KEY_JSON` | `bq-orders`, `bq-ga4-events`, `bq-catalogue-master`, `ga4-api`, `gcp-logging` |
| `BQ_GA4_DATASET` + `BQ_GA4_PROJECT` | The whole funnel and scan-level catalogue analysis (§13.1 — **highest leverage**) |
| `SLACK_BOT_TOKEN` | `slack-catalogue-report`, `slack-alerts`, the daily digest |
| `DATABASE_URL` | Durable marts and run log (fixtures serve without it) |
| `ANTHROPIC_API_KEY` | The written brief (deterministic summary without it) |

Thresholds and SLOs live in the database, not in env, so ops can tune them
without a deploy.

---

## Status

Phase 0 and the Phase 1/2 metric and assertion scaffolding are complete: all 11
routes render, all 13 connectors are implemented against their real APIs with
fixture fallback, and 92 tests pass. Connectors flip from fixture to live as
each credential in §13 lands — no code change required.

**Read `docs/decisions/ADR-000-open-assumptions.md` before extending this.**
Fourteen things are deliberately unresolved, and four of them can invalidate
real work if guessed.
