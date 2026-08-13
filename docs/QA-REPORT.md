# QA report

End-to-end review of the Companion dashboard. Findings are listed with what was
actually wrong and what changed, not just a pass/fail count.

**Result:** 186 unit tests, 54 end-to-end tests across desktop/tablet/mobile,
zero serious or critical WCAG 2.1 AA violations across all 12 routes, ESLint and
TypeScript clean.

---

## Defects found and fixed

### A11y — 1. Interactive blue failed WCAG AA contrast · 7 routes · serious
`--ion #4c6fff` measured **4.06–4.46:1** against the dark surfaces, under the
4.5:1 floor for normal text — and these links render at 11px. Lightened to
`#6b88ff` (**5.32–5.85:1**), which reads as the same blue and also sharpens the
focus ring, since the ring uses the same token.

### A11y — 2. Scrollable tables unreachable by keyboard · 5 routes · serious
The `overflow-auto` containers had no `tabIndex`, so a keyboard user could tab to
links *inside* a table but could not scroll it. These tables are the NOC's
primary working surface. Added `tabIndex={0}`, `role="region"` and a label.

### A11y — 3. Funnel step numbers unreadable over the filled bar · serious
`--muted` on the ion-tinted funnel fill measured **3.47:1**. Because the bar's
width is data-dependent, the same text can sit over the fill *or* the surface, so
a new `--color-muted-on-fill` token (**5.56:1** on the fill, higher on the
surface) covers both cases.

### A11y — 4. Disabled Loyalty row dimmed below legibility · serious
`opacity-40` dropped `--muted` to an effective `#6a6f75` = **3.34:1**. A disabled
row still has to be readable; the hatch already carries the "off" signal, so the
opacity came off the text.

### A11y — 5. Two nav landmarks shared the accessible name "Modules"
The desktop rail and the compact mobile rail were indistinguishable to a screen
reader. The mobile one is now "Modules (compact)".

### Layout — 6. Mobile horizontal overflow · `/` 128px, `/stores` 342px
§10.4 promises the hub and `/stores` work on a phone; both overflowed. Two
causes, same root: **`min-width: auto` on grid and flex items.**
- `DataTable`'s root is a grid item, so it sized to the table's intrinsic 736px
  and dragged the page wide — the child's `overflow-auto` cannot help once the
  parent is already too wide.
- `KpiCard`'s source line used `truncate` without `min-w-0`, so it refused to
  shrink.
- `ModuleHeader`'s `max-w-md` (448px) exceeded a 412px viewport.

### Correctness — 7. Test-EAN canary query was unbounded by date
`lastActualResult` could come from a scan months old and read as current. A
canary that reports a stale "as expected" is worse than no canary, because it
actively reassures. Now bounded by the run window.

### Correctness — 8. Two catalogue figures had no source line
§10.4 says every chart gets axes, units and a source line. Gap reasons and
missing-EAN aging had none. Added.

### Robustness — 9. Malformed date params returned HTTP 500
`/api/kpi?start=not-a-date` crashed the route. A dashboard should never 500 on a
query string — a stale bookmark shouldn't look like an outage. Invalid ranges now
fall back to the default window with a warning in the envelope; a reversed range
is swapped and says so; `2026-02-31` is rejected as the non-existent date it is.

### Security — 10. Cron secret compared with `===`
A plain equality check on a secret leaks its prefix length through timing.
Replaced with `timingSafeEqual`, wrapped so a length mismatch returns false
rather than throwing (the throw would itself be an oracle).

### Security — 11. `/api/ask` had no rate limit
§28.9 requires one and it was missing. Each request can cost a model call and a
database query. Now 20/minute per user, returning 429 with `Retry-After`.

---

## Verified working, not just green

- **Fail-closed cron auth.** With no `CRON_SECRET` set, production denies (401)
  and only non-production allows. Confirmed live.
- **Assertion gate blocks bad loads.** A stale feed, zero rows, duplicate order
  ids, or a non-production affiliate id each hard-fail and leave the mart
  untouched — the `avis_base_view` failure mode, and its disguised variant
  (fresh timestamp, collapsed row count), both caught.
- **Retry policy.** `quotaExceeded`, `401`, `403` are never retried; transient
  errors are, with a bounded attempt budget.
- **No NaN or Infinity** anywhere across every module, including single-day and
  empty windows. Every rate stays within 0–1.
- **Adversarial SQL.** 20 injection and privilege-escalation attempts rejected,
  including `pg_read_file`, `dblink`, statement chaining, and reads of the real
  but non-allowlisted `app_setting` and `etl_run_log` tables.
- **Query params are opaque.** `'; DROP--` survives as a literal string; params
  are only ever bound parameters or in-memory filters.

## Known, accepted

**`npm audit` reports 4 high advisories** in `postcss` and `sharp`, both
transitive through Next 15.5.23. The advisories are real; exposure here is not.
The postcss issues need attacker-controlled CSS or `sourceMappingURL`, and sharp
is Next's image optimiser, which this dashboard does not use — it renders no
user-supplied images. The only fix is Next 16, a major upgrade. Worth doing
deliberately, not as a drive-by during QA.

## Running it

```bash
npm run qa    # lint → typecheck → unit → build → e2e
npm run e2e:a11y
```

CI runs the same on every push and uploads route screenshots.
