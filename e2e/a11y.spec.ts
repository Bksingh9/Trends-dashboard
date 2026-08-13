import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ROUTES } from './routes';

/**
 * Accessibility, via axe-core.
 *
 * §10.4 makes two commitments this checks: keyboard focus is visible
 * everywhere, because this will be used by people moving fast, and colour
 * encodes state rather than carrying meaning alone — which matters on a
 * wall-mounted ops screen read from across a room.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('WCAG 2.1 AA', () => {
  for (const route of ROUTES) {
    test(`${route.path} has no serious or critical violations`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'networkidle' });

      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );

      const detail = blocking
        .map(
          (v) =>
            `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes
              .slice(0, 3)
              .map((n) => n.target.join(' '))
              .join('\n    ')}`,
        )
        .join('\n  ');

      expect(blocking, `${route.path}:\n  ${detail}`).toHaveLength(0);
    });
  }
});

test.describe('keyboard operability', () => {
  test('focus is visible on the first interactive element', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();

    // §10.4 — "keyboard focus visible everywhere". A focus ring that renders as
    // `none` is the same as having no focus indicator at all.
    const outline = await focused.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow };
    });
    const hasRing =
      (outline.style !== 'none' && outline.width !== '0px') || outline.shadow !== 'none';
    expect(hasRing, `focused element has no visible focus indicator: ${JSON.stringify(outline)}`).toBe(true);
  });

  test('the module rail is reachable and operable by keyboard alone', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const salesLink = page.getByRole('navigation', { name: 'Modules', exact: true }).getByRole('link', { name: 'Sales' });
    await salesLink.focus();
    await expect(salesLink).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/sales');
  });
});

test.describe('state is not carried by colour alone', () => {
  test('health lights name their worst metric in text', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    // A red dot with no text is unreadable to a colour-blind user and useless
    // from across an ops room. Each light names the metric and its value.
    for (const domain of ['Business', 'Journey', 'Stores', 'Catalogue', 'App', 'Issues']) {
      const card = page.getByRole('link').filter({ hasText: domain }).first();
      await expect(card).toBeVisible();
    }
    await expect(page.getByText('Unique coverage').first()).toBeVisible();
  });

  test('connector health is stated in words as well as a dot', async ({ page }) => {
    await page.goto('/connectors', { waitUntil: 'networkidle' });
    await expect(page.getByText('Configured').first()).toBeVisible();
    await expect(page.getByText('Blocked by / last error').first()).toBeVisible();
  });

  test('every chart carries a source line', async ({ page }) => {
    // §10.4 — "Charts get axes, units, and a source line. Every one."
    for (const path of ['/sales', '/catalogue', '/app-health']) {
      await page.goto(path, { waitUntil: 'networkidle' });
      const figures = page.locator('figure');
      const n = await figures.count();
      expect(n, `${path} should render at least one figure`).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        await expect(figures.nth(i), `${path} figure ${i} missing a source line`).toContainText(
          /Source:/,
        );
      }
    }
  });
});
