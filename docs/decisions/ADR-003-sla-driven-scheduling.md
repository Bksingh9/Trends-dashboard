# ADR-003 — The freshness SLA is the schedule

Date: 2026-08-14
Status: Accepted
Relates to: §6.3 (assertion gate), §6.4 (ETL cadence), §7.8 (`etl_run_log`), §14.3 (rate limits), §14.5 (data-state markers), §4.9 (`/connectors`)

## Context

The connectors were a complete lifecycle (`extract → transform → assertions →
load`) with fixture fallback, an assertion gate and a run log — and none of it
was *running*. Concretely:

- One cron entry, `/api/cron/all`, once a day at 01:00 UTC. `bq-orders`
  declares a 26-hour SLA and `api-latency` declares 90 minutes; the daily
  schedule could not meet the second one, and nothing said so.
- The only way to trigger a connector was an endpoint gated on `CRON_SECRET`,
  which the browser does not have. A NOC engineer looking at a red connector at
  09:05 could not retry it.
- `/connectors` rendered once. A board left on a wall display showed whatever
  was true when the tab was opened.
- Nothing stopped two runs of the same connector overlapping.
- Most importantly: **a mart full of stale rows rendered as `live`.** `tryLive`
  returned `live` whenever the query succeeded. That is precisely the
  `avis_base_view` failure — the table existed, the SELECT worked, every card
  was green, and the data had stopped moving on 25 June.

## Decision

### 1. One heartbeat; the SLA decides what runs

`/api/cron/tick` fires on a schedule and runs whatever `lib/connectors/
scheduler` says is due. Due-ness is `minutesSince(lastSuccessfulRun) >= 0.9 ×
freshnessSlaMinutes` — read off the connector itself.

The alternative, one cron entry per connector, was rejected on three counts:
Vercel's Hobby plan allows two entries in total; a fourteenth connector would
mean editing `vercel.json` and redeploying; and a cron expression drifts away
from the SLA shown on `/connectors` until the two disagree and nobody can say
which is the truth. With one heartbeat, the page and the scheduler read the
same number and cannot diverge.

The consequence is that the heartbeat interval becomes a floor on every SLA. A
test asserts the `vercel.json` schedule is at least as tight as the tightest
declared SLA, and the page states the cadence in prose, so a schedule that has
fallen behind is visible rather than inferred.

### 2. Re-run windows are wider than the cadence

Late-arriving rows are the norm: GA4 finalises its daily export up to 48 hours
late, and an order placed at 23:58 IST lands in tomorrow's extract. A window
covering only "since the last run" loses those rows permanently, because
nothing ever looks at that date again. So every windowed connector re-covers at
least one full SLA period, enforced by a test.

Snapshot connectors — `sheets-store-master`, `bq-catalogue-master` — replace a
whole dimension per run and are exempt. Their `WINDOW_DAYS: 1` is a formality
of the lifecycle signature, not a claim about coverage, and `SNAPSHOT_CONNECTORS`
records which is which rather than leaving it to be inferred.

### 3. A stale mart serves `stale`, not `live`

This is the loop the incident was missing, and the highest-value change here.
`tryLive` now takes the ids of the connectors that keep each mart current, and
downgrades to `stale` — a real state in the §14.5 vocabulary, rendered
distinctly on the card — when any of them has:

- no completed run on record, or
- gone past its freshness SLA, or
- failed its last run (the mart is on its last good snapshot per §6.3).

Each case produces a warning naming the connector and the age, because "stale"
without "which feed, and by how much" is not actionable.

A successful SELECT proves the table exists. It says nothing about whether
anything is still filling it, and the dashboard must not treat the first as
evidence of the second.

### 4. Concurrency guard, with an expiry

A second run of a connector while the first is mid-flight is the one failure
the assertion gate cannot catch: both writers produce valid rows, and the
result reconciles against nothing. `isRunning` blocks it.

The expiry matters as much as the guard. A serverless invocation killed at its
time limit never writes its outcome, leaving a row at `running` forever — and
without an expiry that single orphan would block every future run of that
connector, which would then go permanently stale *with no error on the board*.
After ten minutes a `running` row is `abandoned`: the connector goes red and
names the killed run, rather than showing a permanent spinner or a false green.

The tick also stops itself at a wall-clock budget inside the route's
`maxDuration`, so it is never the thing that gets killed mid-write.

### 5. Manual control is a server action, not a secret in the browser

`refreshConnector` and `refreshAllDue` are server actions. Calling
`/api/cron/[connector]` from the page would mean shipping `CRON_SECRET` to the
browser. The action runs server-side with the session resolved, gated on the
§9.4 `thresholds` capability — a metered BigQuery scan is a write-shaped
action, and §9.4 gives `exec` read-only access.

Force bypasses the SLA check but never the concurrency guard: a manual retry
during a scheduled run is exactly the double-write the guard exists for.

`/api/cron/[connector]` remains, repurposed as the explicit override for
runbook steps and named-window backfills.

### 6. The board refreshes itself

`/connectors` polls every 30 seconds via `router.refresh()`, which re-runs the
server component and keeps scroll position — a full reload would throw a wall
display back to the top of the page twice a minute. It can be paused, because
an engineer mid-read should not have the row move under them.

Polling rather than a socket: this is a dozen rows of JSON on an internal
dashboard, and a WebSocket buys nothing here but a reconnect state machine.

## Consequences

- **Every SLA on `/connectors` is now enforceable rather than decorative**, and
  a card whose data has gone stale says so instead of showing green.
- The heartbeat must fire at least every 15 minutes for the current SLAs. On a
  plan that only permits daily crons, the tightest SLA silently becomes daily —
  the `/api/cron/tick` response reports the required cadence so this is visible
  in the response itself, not discovered later.
- Adding a connector requires no schedule change. It declares an SLA and a
  re-run window, and the scheduler picks it up.
- In this environment no credentials are configured, so every connector is a
  known §13 blocker and the board is entirely grey. That is the correct
  rendering, not a failure: the scheduler skips unconfigured connectors rather
  than running them to watch them fall back to fixtures, which would fill the
  log with noise that hides real failures. The moment a credential lands, the
  connection doctor proves each hop and the next tick runs it.

---

## Addendum — the load path, proven (2026-08-14)

Running the connectors against a real Postgres turned up the gap the rest of
this ADR could not see: **`load()` had never executed, for any connector.**

`fixtureFallback` deliberately does not load — it hands fixture rows straight to
the UI. Since no credential is configured, every connector took that path every
time. So the idempotent upsert each connector declares (§27.5) was code nobody
had ever run, and the first production load would have been its first test: on
real data, against a real mart, with nothing to compare against.

### `etl seed`

A production-guarded mode that drives each connector's real `transform →
assertions → load` over its fixtures. It runs twice and compares row counts,
because an upsert that is not idempotent returns a different number the second
time and that is the cheapest possible way to find out.

It found real defects immediately:

- **`bq-catalogue-master` had no fixture at all**, so it hard-failed its own
  `rowVolume` gate and its load path stayed untested. It now has a product
  master derived from the *same scan rows* as the gap register — which matters,
  because the §20.3 gap reasons are a join between what customers scanned and
  what the master contains. A product fixture invented independently would make
  every gap classify as `absent_from_master`. Each reason in the taxonomy is
  encoded as master-side data (missing row, null category, duplicate item code,
  inactive flag) so every branch of the classifier has a row to land on.
- **`ga4-api` and `amplitude` still have no fixture.** They are deferred
  (§13.8, §24), and the seed now reports them as `none — load path unexercised`
  rather than a green zero. A test names them explicitly, so a fifteenth
  connector without a fixture fails rather than passing silently.
- Seeding a connector's own incremental window (2 days for `bq-orders`) is
  correct for the connector and useless for the person who then opens `/sales`
  and finds a 90-day chart with two days on it. It defaults to 90 days.

### Seeded is not live, and not stale either

Fixture rows in a real table are indistinguishable from real ones at the row
level — the row count and the query success prove nothing about provenance. So
the run is flagged `seeded` in `etl_run_log`, and `freshnessOf` reads that flag
and reports the mart as `fixture` whatever it holds, naming the connector. The
board shows the connector grey with a `seeded` badge rather than green: green
would mean the dashboard vouches for data that came out of a fixture file.

`fixture` outranks `stale` in that precedence, because calling a fixture stale
implies it was ever current.

Seeding refuses to run under `NODE_ENV=production` behind an escape hatch that
is deliberately awkward to type (`ALLOW_FIXTURE_SEED=i-understand`), because
reaching for it should be a decision rather than a reflex.

### What this does and does not prove

Verified against a real PostgreSQL 16: 12 of 14 connectors load, all of them
idempotently, 11,664 rows across the marts; the pages read those marts and
render them as `fixture` with the honest warning. The full E2E suite passes
identically with and without `DATABASE_URL`, so neither path is a special case.

It does **not** prove any connector can talk to its real upstream. That still
needs credentials. What it does mean is that when a credential arrives, the only
untested step left is `extract` — and the connection doctor is built to prove
exactly that hop.
