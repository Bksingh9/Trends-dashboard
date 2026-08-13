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

test.describe('tablet — the NOC floor device', () => {
  test('the module rail is present and every domain reachable', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const rail = page.getByRole('navigation', { name: 'Modules', exact: true });
    await expect(rail).toBeVisible();
    for (const label of ['Sales', 'Journey', 'Stores', 'Catalogue', 'App Health', 'Issues']) {
      await expect(rail.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('the store operating table is usable — the NOC daily rhythm runs on it', async ({ page }) => {
    await page.goto('/stores', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Stores' })).toBeVisible();
    const table = page.getByRole('region', { name: /Store operating table/ });
    await expect(table).toBeVisible();
    // The deep link is the highest-value action on this page; it must survive
    // the narrower viewport.
    await expect(page.getByRole('link', { name: 'open' }).first()).toBeVisible();
  });

  test('nothing overflows the viewport horizontally', async ({ page }) => {
    for (const path of ['/', '/stores', '/catalogue']) {
      await page.goto(path, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      // A horizontal scrollbar on the whole page means the layout broke; the
      // tables scroll internally by design, which is different.
      expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });

  test('the Scan Strip still reads at tablet width', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const strip = page.getByRole('region', { name: /Scan activity/ });
    await expect(strip).toBeVisible();
    const box = await strip.boundingBox();
    expect(box!.width).toBeGreaterThan(400);
  });
});
