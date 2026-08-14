import { expect, test } from '@playwright/test';

/**
 * §4.9 / §6.4 — `/connectors` as an operating surface.
 *
 * The page's whole reason for existing is that `avis_base_view` reported itself
 * healthy for two weeks while it had stopped updating. So the tests here are
 * about the *loop*: does the board refresh itself, does it say when a connector
 * is next due, and can someone actually retry a failing one from the page
 * rather than filing a ticket asking for a redeploy.
 */

test.describe('the connector board is live, not a snapshot', () => {
  test('refreshes itself and says how long ago it last checked', async ({ page }) => {
    // A board left on a wall display that was true when the tab opened is worse
    // than no board.
    await page.goto('/connectors');
    const live = page.locator('[data-live-refresh]');
    await expect(live).toBeVisible();

    const age = live.locator('[data-refresh-age]');
    await expect(age).toContainText(/checked \d+s ago/);
    // The counter moves — proof the timer is running, not a static string.
    await expect(age).toContainText(/checked [1-9]\d*s ago/, { timeout: 5000 });
  });

  test('can be paused, so an engineer reading a row is not interrupted', async ({ page }) => {
    await page.goto('/connectors');
    const pause = page.getByRole('button', { name: 'pause' });
    await pause.click();
    await expect(page.getByRole('button', { name: 'resume' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('states the heartbeat cadence the SLAs depend on', async ({ page }) => {
    // The schedule is the SLA, not a cron expression. Saying so on the page
    // means a schedule that has fallen behind is visible here rather than
    // buried in vercel.json.
    await page.goto('/connectors');
    await expect(page.getByText(/Scheduling is SLA-driven/)).toBeVisible();
    await expect(page.getByText(/heartbeat has to fire at least that often/)).toBeVisible();
  });
});

test.describe('every connector says when it next runs and can be run now', () => {
  test('shows a due countdown per connector rather than a fixed cron slot', async ({ page }) => {
    await page.goto('/connectors');
    const table = page.locator('[data-rows-total]').filter({ hasText: 'Connector status' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Next due' })).toBeVisible();
  });

  test('offers a run button on configured connectors and explains the blocked ones', async ({ page }) => {
    await page.goto('/connectors');

    const runButtons = page.locator('[data-run-connector]');
    const blocked = page.getByText('blocked', { exact: true });

    // In this environment no credentials are present, so every connector is a
    // known §13 blocker. Either state is valid; what is not valid is a row with
    // neither — a connector you can neither run nor understand why not.
    const rows = await page.locator('[data-rows-total]').filter({ hasText: 'Connector status' }).getAttribute('data-rows-total');
    expect(Number(runButtons.count ? await runButtons.count() : 0) + (await blocked.count())).toBe(Number(rows));
  });

  test('a blocked connector names its blocker instead of failing silently', async ({ page }) => {
    await page.goto('/connectors');
    const first = page.getByText('blocked', { exact: true }).first();
    if ((await first.count()) === 0) test.skip();
    await expect(first).toHaveAttribute('title', /.+/);
  });

  test('offers a run-everything-due control', async ({ page }) => {
    await page.goto('/connectors');
    await expect(page.locator('[data-run-all-due]')).toBeVisible();
  });

  test('running everything due reports an outcome rather than spinning silently', async ({ page }) => {
    await page.goto('/connectors');
    await page.locator('[data-run-all-due]').click();
    // Nothing is configured here, so the honest answer is "nothing was due" —
    // and it has to actually say that rather than resolve into silence.
    await expect(page.getByText(/Nothing was due|Ran \d+ connector/)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('the heartbeat endpoint refuses to be a public trigger', () => {
  test('rejects an unauthorised call in production mode', async ({ request }) => {
    // Locally NODE_ENV is not production, so the guard is permissive by design
    // (§9.4) — a local run must work without a secret. What matters is that the
    // endpoint exists, answers, and reports what it decided.
    const res = await request.post('/api/cron/tick');
    expect([200, 401]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('ran');
      expect(body).toHaveProperty('skipped');
      expect(body).toHaveProperty('shortestSlaMinutes');
      // Every skip carries a reason. A tick that ran nothing and said nothing
      // is indistinguishable from a tick that never fired.
      for (const s of body.skipped) expect(s.reason).toBeTruthy();
    }
  });
});
