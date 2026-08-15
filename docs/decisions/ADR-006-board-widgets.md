# ADR-006 — A board tile renders a §5 metric and cannot compute

**Date:** 2026-08-15
**Status:** Accepted
**Relates to:** §4.10, §5 (the metric contract), §9.2, §14.5

## Why a board is the dangerous surface

Every other page in this build argues its case. It has a header stating the
question, a caveat line, filters showing what is in scope, a source note under
each table, and a data-state pill on each card. A reader who wants to know
whether a number can be trusted has five ways to find out.

A wall display has none of that. It asserts, at a size readable across a room,
to people who will not click anything. Nobody standing six feet away reads a
footnote or hovers a tooltip.

So the board is the easiest place in this product to publish a confident wrong
number, and it is the reason the widget layer is built the way it is rather than
as the obvious "chart builder".

## Decision 1 — tiles render, they do not compute

`lib/widgets/` contains no metric arithmetic and neither does
`components/widgets/`. A tile takes a `MetricValue` that a §5 module already
produced, or a `SeriesPoint[]` produced by a declared resolver that only selects
and sorts.

A widget able to compute would be a metric definition living outside
`lib/metrics/` — which §5 forbids, and forbids for exactly this case. Two
definitions of "coverage" that agree today will not agree after the next change,
and the one on the wall is the one nobody will check.

## Decision 2 — the data state travels onto the tile

`fixture`, `stale`, `missing` and the source string are carried through
`ResolvedWidget` and drawn on every tile. This is the property that makes a
board safe to hang on a NOC wall: `avis_base_view` stopped reflecting new orders
for two weeks *while reporting itself healthy*, and a board is precisely where
that goes unnoticed longest.

Corollary: **a widget that cannot be drawn says so in words.** A tile pointing
at a renamed metric renders "not being published right now", never a zero. From
across a room a zero and a missing number look identical and only one of them is
news.

## Decision 3 — the picker is not a query builder

Options are §5 metrics and a declared list of series (`lib/widgets/series.ts`).
Not arbitrary columns.

A board where a tile can point at any array in any module is a board where
somebody eventually ranks stores by a column meaning something else, and the
tile looks identical either way. Every option here has a formula, a source and a
caveat in the registry, and the tile inherits all three — the picker shows the
caveat *before* the tile is added, not after it is on a wall.

Which chart kinds an option supports is decided by the option:

- A **leaderboard of a time series** ranks dates. Refused.
- A **gauge on a count** needs a ceiling nobody agreed to. Refused; counts get a
  number, a goal against an explicit target, or a traffic light.
- A **goal with no target** draws a bar against an invented ceiling. Refused for
  counts; allowed for ratios only because Settings supplies the target.
- A **status light with no threshold** renders grey, which reads as "fine".
  It states "this light cannot turn green or red" instead.

Validation runs on the server in `validateWidget`, at the moment somebody can
still fix the choice — not at render, where the result is a permanent broken
tile nobody can explain.

## Decision 4 — targets come from Settings

A goal, gauge or status with no explicit target falls back to the matching
threshold in `app_setting`. Changing a target on /settings moves the board.

Two places disagreeing about what "good" means is how a green light ends up on a
wall above a number somebody else considers a breach. Where no threshold exists,
the tile says so rather than inventing one.

## Two defects this found, recorded because both were mine

**The metric→module map was wrong in eight places.** `METRIC_MODULE` is
hand-written so that a board of four store tiles does not have to run every
module to draw one. I wrote it from the metric ids I expected rather than the
ids the modules emit, and eight tiles would have rendered "not being published
right now" — honest, useless, and entirely avoidable. `widgets.test.ts` now runs
every module and checks the map in both directions.

**A trend plunged to zero on the last day.** `dateRange(w)` emits every calendar
day and a day with no rows aggregates to zero, so the newest point sat on the
floor until its partition landed. On a page that reads as a gap; at four feet of
line on a wall it reads as a collapse, and it is the last thing on the chart
where the eye goes first. Trailing empty days are now trimmed and counted, with
the tile saying "*n* most recent days not shown — a pending run rather than a
fall to zero". Interior zeros are kept, because a zero mid-window is real.

## What was not built

No drag-to-reorder, no multi-board switcher in the UI, no auto-refresh timer.
`dashboard_widget.board` is a column, so multiple boards are a query away rather
than a migration, and position is an integer, so ordering is storage-ready. They
were left out because none of them changes whether a number on the wall can be
trusted, and that was the whole point of this piece.
