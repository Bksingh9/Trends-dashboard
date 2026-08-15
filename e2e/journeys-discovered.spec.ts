import { expect, test } from '@playwright/test';

/**
 * §16.4 — the discovered-journeys page.
 *
 * The checks below are mostly about honesty rather than rendering. The page
 * makes three claims that are easy to break silently: that a fork is drawn as a
 * fork, that a sentence written by a model is labelled as one, and that an
 * empty mart says "the connector has not run" rather than drawing a flat funnel.
 */

test.describe('journeys, discovered', () => {
  test('renders at least one journey with its steps', async ({ page }) => {
    await page.goto('/journey/discovered');
    await expect(page.getByRole('heading', { name: 'Journeys, discovered' })).toBeVisible();

    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();
    // Every card is a real path, so it has more than one step.
    await expect(cards.first().locator('ol li')).not.toHaveCount(0);
  });

  test('shows the shared prefix of a forked journey as shared', async ({ page }) => {
    // If this stops appearing, either branching has stopped working or a fork's
    // shared steps are being charged to one branch — the bug ADR-005 records.
    await page.goto('/journey/discovered');
    const cards = page.locator('article');
    if ((await cards.count()) > 1) {
      await expect(page.getByText('shared').first()).toBeVisible();
    }
  });

  test('separates sessions that left from sessions that went elsewhere', async ({ page }) => {
    await page.goto('/journey/discovered');
    const body = await page.locator('main').innerText();
    // "N left" and "N → Somewhere" are different lines on purpose.
    expect(body).toMatch(/left/);
    expect(body).toMatch(/→/);
  });

  test('says whether a narrative was written by a model or assembled', async ({ page }) => {
    // A generated sentence that looks measured is the failure mode; the page
    // must always state which it is showing.
    await page.goto('/journey/discovered');
    await expect(
      page.getByText(/Assembled from the figures above|Written by the model from the figures above/).first(),
    ).toBeVisible();
  });

  test('never claims a drop where sessions merely forked', async ({ page }) => {
    await page.goto('/journey/discovered');
    const body = await page.locator('main').innerText();
    // The original wording of the bug. Findings now read "N leave after X".
    expect(body).not.toMatch(/\d+% drop at /);
  });

  test('states the tail rather than quietly excluding it', async ({ page }) => {
    await page.goto('/journey/discovered');
    await expect(page.getByText(/sessions in this window across \d+ distinct events/)).toBeVisible();
  });

  test('links to the declared funnel, and the declared funnel links back', async ({ page }) => {
    await page.goto('/journey/discovered');
    await expect(page.getByRole('link', { name: 'The declared funnel' })).toBeVisible();

    await page.goto('/journey');
    await expect(page.getByRole('link', { name: 'see Journeys found' })).toBeVisible();
  });

  test('the API returns journeys and findings without narration', async ({ request }) => {
    const res = await request.get('/api/journeys?days=28');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data.journeys)).toBe(true);
    expect(Array.isArray(body.data.findings)).toBe(true);
    // Prose costs a model call per journey; an endpoint a dashboard polls must
    // not spend tokens on something nobody asked for.
    expect(JSON.stringify(body)).not.toContain('narrative');
  });
});
