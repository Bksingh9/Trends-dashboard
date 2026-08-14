import { expect, test } from '@playwright/test';

/**
 * §9.3 / §4.2 — the filter bar and the address bar are the same thing.
 *
 * These run in a browser because the property under test is not "the parser
 * works" — the unit tests cover that — but "what a NOC engineer sees after
 * clicking is what the person they send the link to sees". That only breaks in
 * the round trip between the control, the URL and the server render.
 */

/** Scoped to the filter bar: "State" also names the state-rollup table region. */
const bar = (page: import('@playwright/test').Page) => page.locator('[data-filter-bar]');

test.describe('URL is the state', () => {
  test('a filtered URL renders filtered, and says so', async ({ page }) => {
    await page.goto('/sales?state=Maharashtra');

    const scope = page.locator('[data-scope]');
    await expect(scope).toBeVisible();
    await expect(scope).toContainText('Maharashtra');

    // The state table is the proof: filtering to one state must leave one row.
    const stateTable = page.locator('[data-rows-total]').filter({ hasText: 'State × revenue' });
    await expect(stateTable).toHaveAttribute('data-rows-total', '1');
  });

  test('choosing a filter writes it to the URL and narrows the page', async ({ page }) => {
    await page.goto('/stores');
    const liveCount = async () =>
      Number((await page.locator('[data-metric-id="stores_live"]').innerText()).replace(/[^\d]/g, ''));
    const before = await liveCount();

    const select = bar(page).getByLabel('State');
    const value = (await select.locator('option').nth(1).getAttribute('value'))!;
    await select.selectOption(value);

    // URLSearchParams encodes a space as `+`, not `%20` — match the key only.
    await page.waitForURL(/[?&]state=/);
    await expect(page.locator('[data-scope]')).toContainText(value);

    expect(await liveCount()).toBeLessThan(before);
  });

  test('the filtered URL is shareable — a reload lands on the same view', async ({ page }) => {
    await page.goto('/stores');
    const select = bar(page).getByLabel('City');
    const city = (await select.locator('option').nth(1).getAttribute('value'))!;
    await select.selectOption(city);
    await page.waitForURL(/city=/);

    // The link as a colleague would receive it — no client state carried over.
    const shared = page.url();
    await page.goto(shared);
    await expect(page.locator('[data-scope]')).toContainText(city);
    // The control reflects the URL, not a client-side memory of the click.
    await expect(bar(page).getByLabel('City')).toHaveValue(city);
  });

  test('Clear removes every filter and returns to the unfiltered view', async ({ page }) => {
    await page.goto('/stores?state=Maharashtra&compare=same_weekday_last_week');
    await expect(page.locator('[data-scope]')).toBeVisible();

    await page.getByRole('button', { name: 'Clear' }).click();
    await page.waitForURL((u) => !u.search);
    await expect(page.locator('[data-scope]')).toHaveCount(0);
  });

  test('switching the comparison relabels the deltas', async ({ page }) => {
    await page.goto('/sales');
    await expect(page.locator('[data-compare-label]')).toContainText('vs previous period');

    await bar(page).getByLabel('Comparison period').selectOption('same_weekday_last_week');
    await page.waitForURL(/compare=same_weekday_last_week/);
    await expect(page.locator('[data-compare-label]')).toContainText('vs same weekday last week');
  });

  test('a garbage query string degrades to the default view with a warning', async ({ page }) => {
    // A dashboard that 500s on a stale bookmark is worse than one that says
    // which part of the bookmark it could not use.
    await page.goto('/sales?start=lol&end=wat&compare=nonsense&platform=windowsphone');
    await expect(page.locator('h1')).toContainText('Sales');
    await expect(page.getByText(/Ignored an invalid date range/)).toBeVisible();
    await expect(page.getByText(/Ignored compare=nonsense/)).toBeVisible();
  });

  test('a store code that matches nothing says so instead of showing an empty page', async ({ page }) => {
    await page.goto('/sales?store=99999');
    await expect(page.getByText(/No store matches "99999"/)).toBeVisible();
  });

  test('app health admits it cannot honour a store filter', async ({ page }) => {
    // The fact table is a national daily aggregate. Silently serving national
    // numbers under a store-scoped URL is the failure being prevented.
    await page.goto('/app-health?store=00421');
    await expect(page.getByText(/no store or platform dimension/)).toBeVisible();
  });

  test('the journey funnel splits by platform rather than blending', async ({ page }) => {
    await page.goto('/journey?platform=ios');
    const table = page.locator('table').filter({ hasText: 'Platform' }).first();
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table).toContainText('iOS');
    await expect(table).not.toContainText('Android');
  });
});
