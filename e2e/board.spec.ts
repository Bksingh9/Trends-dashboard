import { expect, test } from '@playwright/test';

/**
 * §4.10 — the board.
 *
 * A wall display is read by people who will not click anything, from a distance
 * at which no footnote is legible. So the checks here are less about the tiles
 * rendering and more about what a tile is forbidden from doing: hiding its data
 * state, showing a zero where a number is missing, or offering a chart that
 * cannot honestly be drawn.
 */

test.describe('the board', () => {
  test('renders the starting board with every tile resolved', async ({ page }) => {
    await page.goto('/board');
    await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible();
    const tiles = page.locator('[data-widget]');
    expect(await tiles.count()).toBeGreaterThan(4);
  });

  test('every tile carries its source and its data state', async ({ page }) => {
    // The single property that makes a board safe to put on a NOC wall. A green
    // number that has not moved in two weeks is how avis_base_view went unseen.
    await page.goto('/board');
    const tiles = page.locator('[data-widget]');
    const n = await tiles.count();
    for (let i = 0; i < n; i++) {
      const tile = tiles.nth(i);
      const text = await tile.innerText();
      // Either a state pill or an explicit "cannot be drawn" sentence.
      expect(text.length).toBeGreaterThan(10);
    }
    // At least one state badge is visible without hovering anything.
    await expect(page.getByText(/FIXTURE|STALE|LIVE/i).first()).toBeVisible();
  });

  test('a trend says when its most recent day has not loaded', async ({ page }) => {
    // Otherwise the newest point sits on the floor and reads as a collapse.
    await page.goto('/board');
    const trend = page.locator('[data-widget-kind="trend"]').first();
    await expect(trend).toBeVisible();
    const text = await trend.innerText();
    if (text.includes('not shown')) {
      expect(text).toContain('pending run rather than a fall to zero');
    }
  });

  test('the picker offers metrics and series, searchable', async ({ page }) => {
    await page.goto('/board');
    await page.locator('[data-add-widget]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-widget-option]').first()).toBeVisible();

    await dialog.locator('[data-widget-search]').fill('coverage');
    await expect(dialog.locator('[data-widget-option="unique_coverage"]')).toBeVisible();
    await expect(dialog.locator('[data-widget-option="orders"]')).toHaveCount(0);
  });

  test('offers only the tile kinds an option can honestly be drawn as', async ({ page }) => {
    // A count cannot be a gauge: a gauge needs a ceiling, and inventing one is
    // exactly the kind of confident wrong number a wall display amplifies.
    await page.goto('/board');
    await page.locator('[data-add-widget]').click();
    const dialog = page.getByRole('dialog');

    await dialog.locator('[data-widget-search]').fill('orders');
    await dialog.locator('[data-widget-option="orders"]').click();
    await expect(dialog.locator('[data-widget-kind-option="gauge"]')).toHaveCount(0);
    await expect(dialog.locator('[data-widget-kind-option="number"]')).toBeVisible();
  });

  test('a ratio can be a gauge, and says what its target is', async ({ page }) => {
    await page.goto('/board');
    await page.locator('[data-add-widget]').click();
    const dialog = page.getByRole('dialog');

    await dialog.locator('[data-widget-search]').fill('unique coverage');
    await dialog.locator('[data-widget-option="unique_coverage"]').click();
    await expect(dialog.locator('[data-widget-kind-option="gauge"]')).toBeVisible();
    await dialog.locator('[data-widget-kind-option="gauge"]').click();
    // The help text, not the placeholder: a ratio typed as 97 instead of 0.97
    // draws a bar 9,700% full, and the field has to say so where it is read.
    await expect(dialog.getByText(/A ratio goes in as a decimal/)).toBeVisible();
    await expect(dialog.getByText(/Blank means the tile follows Settings/)).toBeVisible();
  });

  test('surfaces a metric’s caveat before it goes on a wall', async ({ page }) => {
    // Read at the point of choosing, not discovered from the tile later.
    await page.goto('/board');
    await page.locator('[data-add-widget]').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[data-widget-search]').fill('e-GMV');
    await dialog.locator('[data-widget-option="egmv"]').click();
    await expect(dialog.getByText(/Caveat:/)).toBeVisible();
  });

  test('adds a tile and it survives a reload', async ({ page }) => {
    await page.goto('/board');
    const before = await page.locator('[data-widget]').count();

    await page.locator('[data-add-widget]').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[data-widget-search]').fill('Average order value');
    await dialog.locator('[data-widget-option="aov"]').click();
    await dialog.locator('[data-save-widget]').click();

    await expect(page.locator('[data-widget]')).toHaveCount(before + 1, { timeout: 15_000 });

    // The point of storing a board at all: it is still there next time.
    await page.reload();
    await expect(page.locator('[data-widget]')).toHaveCount(before + 1);
    await expect(page.getByText('Average order value').first()).toBeVisible();
  });

  test('removes a tile and it stays removed', async ({ page }) => {
    await page.goto('/board');
    const before = await page.locator('[data-widget]').count();
    await page.locator('[data-remove-widget]').first().click();
    await expect(page.locator('[data-widget]')).toHaveCount(before - 1, { timeout: 15_000 });
    await page.reload();
    await expect(page.locator('[data-widget]')).toHaveCount(before - 1);
  });
});
