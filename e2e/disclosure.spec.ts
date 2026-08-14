import { expect, test } from '@playwright/test';

/**
 * The disclosures a reader needs before they trust a number.
 *
 * These assert what is *on the screen*, not what the metric layer computed.
 * Every bug in this file's remit was invisible to the unit tests by
 * construction: the arithmetic was right and the page still misled, because a
 * table hid rows without saying so or two figures counted different populations
 * under headings that looked equivalent.
 */

test.describe('§6.3 — a capped table declares what it hides', () => {
  test('the sales store table states N, M, the sort key and the residual', async ({ page }) => {
    await page.goto('/sales');

    // "Top 200 of 272 by net revenue" — N, M and the sort key in one line.
    const header = page.getByText(/Top \d+ of \d+ by net revenue/);
    await expect(header).toBeVisible();

    const [n, m] = (await header.textContent())!.match(/\d+/g)!.map(Number);
    expect(n).toBeLessThan(m);

    // The header's claim has to match what the table actually rendered.
    const card = page.locator(`[data-rows-shown="${n}"][data-rows-total="${m}"]`);
    await expect(card).toHaveCount(1);
    expect(await card.locator('tbody tr').count()).toBe(n);

    // The residual accounts for exactly the rows that are not on screen…
    const residual = card.locator('[data-truncation-residual]');
    await expect(residual).toBeVisible();
    await expect(residual).toContainText(new RegExp(`\\+${(m - n).toLocaleString('en-IN')} stores not shown`));
    // …and says what they are worth, so a reader summing the column knows the gap.
    await expect(residual).toContainText('₹');
  });

  test('the catalogue register and coverage tables both disclose their caps', async ({ page }) => {
    await page.goto('/catalogue');
    const residuals = page.locator('[data-truncation-residual]');
    await expect(residuals).toHaveCount(2);

    await expect(page.getByText(/Top \d+ of \d+ by coverage, worst first/)).toBeVisible();
    await expect(page.getByText(/Top \d+ of \d+ by scan volume/)).toBeVisible();

    // The coverage residual is a floor, not a sum — the hidden stores are the
    // healthy ones, so what matters is that none of them is worse than the cut.
    await expect(residuals.first()).toContainText(/all at or above [\d.]+% coverage/);
    await expect(residuals.last()).toContainText(/scans behind them/);
  });
});

test.describe('§6.3 — figures that count different populations say so', () => {
  test('catalogue reconciles observed, open and closed missing EANs', async ({ page }) => {
    await page.goto('/catalogue');
    const line = page.locator('[data-gap-reconciliation]');
    await expect(line).toBeVisible();

    const text = (await line.textContent())!;
    const [observed, open, closed] = text.match(/[\d,]+/g)!.slice(0, 3).map((s) => Number(s.replace(/,/g, '')));
    expect(open + closed).toBe(observed);

    // The breakdowns below name the population they count, so the reader is
    // never left to infer why they do not sum to the card above.
    await expect(page.getByText(new RegExp(`Gap reasons — ${open.toLocaleString('en-IN')} open gaps`))).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Missing-EAN aging — ${open.toLocaleString('en-IN')} open gaps`)),
    ).toBeVisible();
  });

  test('sales breakdowns name the confirmed-order count they tie to', async ({ page }) => {
    await page.goto('/sales');
    // Both order cards stay on the page (§15.4 / A3 is unresolved), so every
    // breakdown has to say which of the two it agrees with.
    await expect(page.getByText(/\d[\d,]* confirmed orders/).first()).toBeVisible();
    expect(await page.getByText(/confirmed orders/).count()).toBeGreaterThanOrEqual(3);
  });
});

test.describe('§9.2 — a measured zero is never dressed as no data', () => {
  test('orders per active store shows its real sub-unit rate', async ({ page }) => {
    await page.goto('/stores');
    const card = page.locator('[data-metric-id="orders_per_active_store"]');
    // 0.24, not a rounded-away 0 that reads as "nobody is ordering".
    await expect(card).toContainText(/0\.\d\d/);
    await expect(card).toHaveAttribute('data-state', /live|fixture|cache/);
  });

  test('daily-order compliance is a real rate on a trailing window', async ({ page }) => {
    // Trailing windows end yesterday. Anchored to the wall clock this read
    // 0.0% — a total collapse of ordering that was really a date-range bug.
    const card = page.locator('[data-metric-id="daily_order_compliance"]');
    await page.goto('/stores');
    await expect(card).toHaveAttribute('data-state', /live|fixture|cache/);
    await expect(card).toContainText(/\d+\.\d%/);
    await expect(card).not.toContainText('0.0%');
  });
});
