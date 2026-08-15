import { expect, test } from '@playwright/test';

/**
 * §9.5 — adding a data source from the UI.
 *
 * The behaviour under test is the one that makes this a dashboard rather than a
 * repository: someone handed a token can connect a source without editing a
 * file or waiting for a deploy. The security properties are checked here too,
 * in the browser, because "the secret never reaches the client" is a claim
 * about what is on the wire and cannot be proven from a unit test.
 */

test.describe('the data sources page', () => {
  test('renders and offers to add a source', async ({ page }) => {
    await page.goto('/connectors/sources');
    await expect(page.getByRole('heading', { name: 'Data sources' })).toBeVisible();
    await expect(page.locator('[data-add-source]')).toBeVisible();
  });

  test('never sends a stored secret to the browser', async ({ page }) => {
    // The whole page payload, not just what is rendered: a secret hidden in a
    // prop or an RSC flight chunk is still a secret on the wire.
    const res = await page.goto('/connectors/sources');
    const body = (await res!.text()) ?? '';
    expect(body).not.toContain('SECRET-VALUE');
    expect(body).not.toContain('xoxb-SECRET');
    // …and what it does show is masked.
    if (body.includes('Companion workspace')) expect(body).toMatch(/••••/);
  });

  test('the picker opens, searches, and groups by category', async ({ page }) => {
    await page.goto('/connectors/sources');
    await page.locator('[data-add-source]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-source-type]').first()).toBeVisible();

    // Search is what keeps this usable past a dozen types.
    const search = dialog.locator('[data-source-search]');
    await search.fill('sheets');
    await expect(dialog.locator('[data-source-type="google-sheets"]')).toBeVisible();
    await expect(dialog.locator('[data-source-type="slack"]')).toHaveCount(0);

    // An alias, not the product name — somebody looking for Excel should land
    // somewhere useful rather than conclude it is unsupported.
    await search.fill('excel');
    await expect(dialog.locator('[data-source-type]').first()).toBeVisible();

    await search.fill('');
    await expect(dialog.locator('[data-source-type="slack"]')).toBeVisible();
  });

  test('choosing a type shows its fields and says what it turns on', async ({ page }) => {
    await page.goto('/connectors/sources');
    await page.locator('[data-add-source]').click();
    await page.locator('[data-source-type="slack"]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Bot token')).toBeVisible();
    await expect(dialog.getByText(/Turns on:/)).toBeVisible();
    await expect(dialog.getByText(/Test does:/)).toBeVisible();
    await expect(dialog.locator('[data-test-connection]')).toBeVisible();
  });

  test('a secret field is a password input, so it is not shoulder-readable', async ({ page }) => {
    await page.goto('/connectors/sources');
    await page.locator('[data-add-source]').click();
    await page.locator('[data-source-type="slack"]').click();

    const input = page.getByRole('dialog').locator('input[type="password"]').first();
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('autocomplete', 'new-password');
  });

  test('validates the shape of a credential before making any network call', async ({ page }) => {
    // A typo should cost nothing — no round trip, no rate-limit budget.
    await page.goto('/connectors/sources');
    await page.locator('[data-add-source]').click();
    await page.locator('[data-source-type="slack"]').click();

    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="password"]').first().fill('definitely-not-a-slack-token');
    await dialog.locator('[data-test-connection]').click();

    await expect(dialog.getByText(/xoxb-/)).toBeVisible({ timeout: 15_000 });
  });

  test('a failed test names the hop that failed, not just "failed"', async ({ page }) => {
    // "Connector down" sends someone hunting for an afternoon. "The key did not
    // parse" is a five-minute fix.
    await page.goto('/connectors/sources');
    await page.locator('[data-add-source]').click();
    await page.locator('[data-source-type="bigquery"]').click();

    const dialog = page.getByRole('dialog');
    await dialog.locator('textarea').first().fill('{"private_key":"nonsense","type":"service_account"}');
    await dialog.locator('input').nth(1).fill('some-project');
    await dialog.locator('[data-test-connection]').click();

    const result = dialog.locator('[data-test-result]');
    await expect(result).toBeVisible({ timeout: 30_000 });
    // Each hop attempted is listed with its own verdict.
    await expect(result).toContainText(/parses|Token exchange/i);
  });

  test('marks generic sources as exploration-only', async ({ page }) => {
    // A source that cannot move a §5 metric is a different promise from one
    // that can, and the picker says which before anyone connects it.
    await page.goto('/connectors/sources');
    await page.locator('[data-add-source]').click();
    await page.getByRole('dialog').locator('[data-source-search]').fill('rest');
    await expect(page.getByRole('dialog').getByText('explore only').first()).toBeVisible();
  });
});
