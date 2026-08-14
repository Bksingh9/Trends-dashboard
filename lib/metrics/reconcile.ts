/**
 * §6.3 — Reconciliation between figures that must tie.
 *
 * Two numbers on `/catalogue` were both correct and did not agree: the
 * `missing_distinct` card read 2,510 while the reason breakdown and the aging
 * histogram summed to 2,138. Nothing was broken — the card counts every EAN the
 * scan feed observed failing in the window, and the breakdowns count only gaps
 * still open, so 372 resolved and won't-fix rows sat in the difference. But a
 * reader has no way to know that from the page, and "the catalogue numbers do
 * not add up" is exactly the kind of doubt that costs a dashboard its audience.
 *
 * So the split is computed once, in the metric layer, and rendered as an
 * explicit three-part line. The same function backs an assertion, so if the two
 * populations ever diverge for a *real* reason — an EAN observed failing that
 * never made it into the register — the pipeline says so instead of the page
 * quietly widening its delta.
 */

export interface GapReconciliation {
  /** Distinct EANs the scan feed observed failing in the window. */
  observed: number;
  /** Rows in the gap register for the same window. */
  registered: number;
  /** Register rows still open — the population behind reasons and aging. */
  open: number;
  /** Register rows resolved or marked won't-fix. */
  closed: number;
  /**
   * Observed but never registered. Must be zero: an EAN that failed a scan and
   * has no register row is a gap nobody owns and nobody will ever close.
   */
  unregistered: number;
  reconciled: boolean;
  /** The disclosure line, in the words the page uses. */
  line: string;
}

export function reconcileGapRegister(input: {
  observedDistinctMissing: number;
  gaps: Array<{ status: string }>;
}): GapReconciliation {
  const registered = input.gaps.length;
  const closed = input.gaps.filter((g) => g.status === 'resolved' || g.status === 'wontfix').length;
  const open = registered - closed;
  // Clamped at zero: a register holding *more* rows than the scan feed observed
  // is a different problem (a stale row that has stopped being scanned), and it
  // is not the one this number is asking about.
  const unregistered = Math.max(0, input.observedDistinctMissing - registered);

  const n = (v: number) => v.toLocaleString('en-IN');
  const line =
    unregistered > 0
      ? `${n(input.observedDistinctMissing)} observed · ${n(open)} open · ${n(closed)} closed · ${n(unregistered)} observed but not registered`
      : `${n(input.observedDistinctMissing)} observed · ${n(open)} open · ${n(closed)} resolved or won't fix`;

  return {
    observed: input.observedDistinctMissing,
    registered,
    open,
    closed,
    unregistered,
    reconciled: unregistered === 0,
    line,
  };
}
