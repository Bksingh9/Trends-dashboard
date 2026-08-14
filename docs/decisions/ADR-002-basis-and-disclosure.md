# ADR-002 — One basis per page, and disclose what you hide

Date: 2026-08-14
Status: Accepted
Supersedes: nothing
Relates to: §5 (metric contract), §6.3 (assertions), §14.5 (data-state markers), §15.4 / A3 (order status enum), §16.5.2 (three coverage measurements)

## Context

QA against the live deploy found six ways the dashboard produced numbers that
were individually correct and collectively unreadable. None of them was an
arithmetic error. Every one was a **basis** or **disclosure** failure: two
figures on the same screen counted different populations, or one figure was a
subset of what its label claimed, and nothing on the page said so.

Concretely:

- `/sales` headline cards are computed on confirmed orders, but the state
  table, the store table and the order-value histogram were computed on the raw
  order feed. The tables summed to neither e-GMV nor net revenue, and the
  histogram binned 1,414 orders under a label reading 1,289.
- `orders_per_active_store` genuinely runs at 0.24. `formatCount` rounded it to
  `0`, so a measured rate printed as what reads like "no orders at all".
- `daily_order_compliance` and `missing_new` returned `0` for windows that do
  not include the day they are measured against. A zero and an unmeasurable
  quantity rendered identically.
- Four tables rendered a capped subset while their headers reported the
  subset's length as the total.
- `/catalogue` showed 2,510 missing EANs above breakdowns that summed to 2,138.

## Decision

### 1. Metric arithmetic stays in `lib/metrics/`

Every fix here landed in `lib/metrics/compute.ts`, `lib/metrics/reconcile.ts`,
`lib/format/currency.ts` or `lib/services/modules.ts`. No component computes a
metric. The `confirmedOrders` filter that fixes the store, state and histogram
breakdowns is applied once in `salesModule`, not three times in the page.

### 2. A measured zero and an absent measurement are different types

`Presence` (`{ value, state, reason }`) is now the return type for any metric
whose measurability depends on the window rather than on the data. `presence()`
takes the value, a `hasData` predicate and the reason it would be unmeasurable;
`metricValue()` accepts it directly.

**A `missing` presence cannot be overridden by an explicit `state`.** The
service layer routinely passes `{ state: scans.state }` alongside a value, and
`scans.state` is often `live`. If that won, an unmeasurable quantity would
render green. A live connector says the *feed* is healthy; it says nothing
about whether this particular measurement exists in this particular window.

### 3. Both order bases stay published; breakdowns tie to the confirmed one

§15.4 / A3 leaves the order status enum unresolved, so `orders` (3,907) and
`orders_confirmed` (3,583) are both real numbers and both stay on the page.
Rather than pick one and hide the other, every breakdown on `/sales` is
computed on the confirmed basis and **names the number it ties to** in its
caption ("Store × revenue — 3,583 confirmed orders").

The alternative — folding the two into one card — was rejected because it would
resolve A3 by assertion rather than by evidence, which is the failure mode this
dashboard exists to prevent. When the enum is confirmed upstream, the losing
card is deleted and this ADR is superseded.

### 4. A capped table declares N, M, the sort key and the residual

`DataTable` now takes a `truncation` prop and does the slicing itself. Passing a
pre-sliced array is the bug: it makes the cap invisible to the component, so the
header reports the truncated length as the total. A unit test walks every `.tsx`
under `app/` and `components/` and fails on `rows={…​.slice(…)}`, so this cannot
come back.

The **residual** is a judgement call per table, not a formula:

- `/sales` store table: the sum of the hidden rows (`₹2.74 L · 312 orders`).
  Someone adding the revenue column needs the number that closes the gap.
- `/catalogue` open-gap register: total scan volume behind the hidden gaps —
  the sum that matters is impact, not row count.
- `/catalogue` store × coverage: a **floor**, not a sum. That table is sorted
  worst-first, so the hidden rows are the healthiest ones; "all at or above
  96.4% coverage" is the fact a reader needs, and a sum of coverages would be
  meaningless.

### 5. `/catalogue` labels its two populations instead of forcing them to match

The 372-EAN delta is not a hole. `missing_distinct` counts every EAN the scan
feed observed failing in the window (2,510); the reason breakdown, the aging
histogram and the register count only gaps still **open** (2,138). The 372 are
resolved or won't-fix.

We label rather than reconcile, because both figures answer real questions —
"how much is broken out there" and "how much is still on someone's plate" — and
collapsing them would lose one. The page carries an explicit line:

> 2,510 observed · 2,138 open · 372 resolved or won't fix

and both breakdown headings name the open count.

`reconcileGapRegister()` computes the split once, in the metric layer, and backs
a new §6.3 assertion, `gapRegisterCoverage`. The assertion guards the part that
would be a genuine defect: an EAN observed failing that has **no register row at
all**. Such a gap has no owner, no suspected reason and no aging clock, and it
would sit there indefinitely. That fails the gate; the expected open/closed
partition does not.

## Consequences

- Any new metric whose measurability depends on the window must return a
  `Presence`, or it will silently publish a zero.
- Any new capped table must pass `truncation` or the 1.5 test fails the build.
- If the `/catalogue` observed and registered populations ever diverge, the
  assertion fails the load and the mart keeps its last good snapshot (§6.3)
  rather than the page quietly widening its delta.
- 19 regression tests in `tests/data-honesty.test.ts` cover all of the above,
  including a guard that `orders_confirmed < orders` — without it, the
  basis tests would pass trivially if the fixture ever confirmed every order.
