import { expect, test } from '@playwright/test';

/**
 * §10.4 — responsive behaviour.
 *
 * "Responsive to tablet (NOC uses tablets on the floor). Mobile gets the hub and
 * /stores table only — don't pretend a 12-column store matrix works on a phone."
 *
 * Split by device because both halves are real requirements: tablet must be
 * genuinely usable, and mobile must *restrict* rather than squeeze. The
 * playwright project decides which file runs at which viewport.
 */

test.describe('mobile — restricted on purpose', () => {
  test('shows a reduced nav with only the hub and stores', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const rail = page.getByRole('navigation', { name: 'Modules (compact)' });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Hub' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Stores' })).toBeVisible();
    // Squeezing a 12-column store matrix onto a phone helps nobody, so the
    // other modules are deliberately absent rather than broken.
    await expect(rail.getByRole('link', { name: 'Catalogue' })).toHaveCount(0);
  });

  test('says plainly that the full dashboard needs a bigger screen', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByText(/Full dashboard on tablet or desktop/)).toBeVisible();
  });

  test('the hub still answers its question', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Is Companion healthy today?' })).toBeVisible();
    // The six health lights are the whole point of the hub on a small screen.
    for (const domain of ['Business', 'Catalogue', 'Issues']) {
      await expect(page.getByRole('link').filter({ hasText: domain }).first()).toBeVisible();
    }
  });

  test('nothing overflows horizontally', async ({ page }) => {
    for (const path of ['/', '/stores']) {
      await page.goto(path, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });
});
