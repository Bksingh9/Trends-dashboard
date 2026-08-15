# ADR-005 — Journeys are discovered from whole session paths, not modelled from adjacency

**Date:** 2026-08-15
**Status:** Accepted
**Relates to:** §16.4 (session explorer), §5.2, §28.5

## The problem

`/journey` measures eleven steps declared by hand in `FUNNEL_STEPS`. That is the
right instrument for a funnel the business has already agreed on, and it is
structurally blind to everything else: a route that does not appear in the list
cannot appear on the page. Sessions taking it do not show up as a different
journey — they show up as a shortfall at step 2 of the only journey there is.

On the fixture, 18% of sessions never open the scanner at all. The declared
funnel renders that as "scanner_open is at 42%" and nothing else. Whether those
sessions were lost or simply went another way is not a question it can express.

## Decision 1 — materialise whole paths

`fact_journey_path` stores one row per distinct ordered event sequence with the
exact session count, extracted in BigQuery with
`ARRAY_AGG(event_name ORDER BY event_timestamp)`.

The cheaper design is an adjacency table — `(from_event, to_event, sessions)` —
and a walk that multiplies edge probabilities. It was rejected. That walk is a
first-order Markov chain, which assumes step 5 does not depend on step 2. A
session that reached checkout from a scan behaves nothing like one that reached
it from search; averaging them yields a funnel matching neither, and it does so
*confidently*, with no marker distinguishing the estimate from a count.

Costs of the choice, accepted:

- The extraction reads every event row, so it is the second most expensive query
  in the build. It runs on a 52-hour SLA and under `maxBytesBilled` like the rest.
- The row count needs a floor. Paths under `MIN_PATH_SESSIONS = 5` collapse into
  one `(other)` row per day and platform — **collapsed, not dropped**, so the
  totals still reconcile and `journey_path_coverage` has an honest denominator.
- Sequences are capped at 10 steps and consecutive duplicates are collapsed.

## Decision 2 — a fork is not a drop

This is the part that was wrong first and matters most.

The initial implementation computed, for each step, `lost = previous.sessions −
this.sessions`. Arithmetically correct. It produced:

> **85% drop at Search** — 48,953 of 57,580 sessions left after Session start.

Those sessions had opened the scanner. They were still in the app and converting
better than the ones being counted as retained. The sentence would have sent
someone to debug a search screen that was working perfectly.

Sessions reaching a step are now split three ways and the three are never added
together in a headline:

| | meaning | is it a problem |
|---|---|---|
| carried through | went to this step | no |
| `diverted` | went to a sibling step | a choice, worth understanding |
| `exited` | did nothing further at all | **yes — this is the hole** |

Consequences that fall out of this:

- **Ranking** is by `exited` at the worst step, not by `1 − retention`.
- **A branch is measured from its fork.** `entrySessions` is counted at the step
  where the journey became distinct, not at `session_start`. Steps before the
  fork are marked `shared`, rendered grey, and excluded from that journey's
  drop-off accounting — charging a shared prefix's exits to one branch ranked
  journeys by how early they forked and printed the same finding twice.
- **`journey_worst_exit_rate`** replaced a `journey_worst_dropoff` metric that
  used `1 − retention`. The two differ wherever sessions forked, and a headline
  card reading 63.2% directly above a finding reading 48% about the same step is
  how a dashboard loses its reader.
- **Branch detection compares siblings, not parent.** A fork is its own journey
  when it holds ≥25% of its *heaviest sibling*. Measured against the parent —
  the natural-looking choice — most of the parent is exits, so every genuine
  fork scores small and is discarded. On the fixture a fork taking half the main
  route's traffic scored 0.18 of its parent and vanished.

## Decision 3 — outcome is read from revenue

A journey "converts" if it ends on an event whose `revenue_sessions > 0` in
`fact_event_node`, sourced from GA4's own `ecommerce.purchase_revenue`.

Hardcoding `purchase` would be picking the answer again, and would silently
exclude a second checkout flow shipped under another event name — the exact
class of blindness this whole module exists to remove. A test asserts that a
journey ending in `order_placed`, a name appearing nowhere in this codebase, is
detected as converting.

`revenueAtRisk` is `null` unless completers of *that journey* actually carried
revenue. Borrowing a neighbouring journey's rate would put a rupee figure on
screen that no measurement supports.

## Decision 4 — the model writes the sentence and nothing else

`discoverJourneys()` and `journeyFindings()` decide which journeys exist, which
is worst, and what the finding is — all from exact counts, before any API call.
`narrateJourney()` turns the already-chosen winner into English.

If the key expires, every number, ranking and finding is unchanged and the prose
degrades to a sentence assembled from the same facts. The card says which of the
two it is showing.

A model able to reorder the journeys would be a model able to bury the worst one
with nothing on screen to reveal it. The daily brief's fabricated-number guard
applies here too: any figure in the output that is not in the payload discards
the generated text.

## What was not decided

The declared funnel stays. `/journey` and `/journey/discovered` are separate
pages that link to each other. Merging them would hide the case worth reading —
a route carrying real traffic that `FUNNEL_STEPS` cannot see.

The fixture's branch weights (6% failed-scan recovery, 18% browse-without-scan,
28% bag abandon) are **assumptions**, sourced from the §16 event dictionary and
the Slack catalogue reports but not measured. They shape the fixture only, and
everything served from it carries the §14.5 fixture marker. They are recorded
here so nobody later mistakes them for findings.
