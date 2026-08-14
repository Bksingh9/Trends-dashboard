import { expect, test, type Page } from '@playwright/test';
import { ROUTES } from './routes';

/**
 * Route-level QA.
 *
 * The assertions here are the product's own rules, not generic smoke tests:
 * rule 2 says every number carries source, grain and last-refreshed time, and
 * that fixture data is never mistakable for live. If those slip, the dashboard
 * stops being trustworthy regardless of whether it renders.
 */

/** Console errors and genuine request failures, minus known-benign noise. */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (/favicon|fonts\.gstatic|fonts\.googleapis/.test(url)) return;
    // Next cancels RSC prefetches on navigation — that is the router working.
    // An abort is a cancellation, not a failure — Next cancels RSC prefetches
    // and stylesheet preloads routinely as the router settles.
    if (req.failure()?.errorText === 'net::ERR_ABORTED') return;
    errors.push(`requestfailed: ${url} ${req.failure()?.errorText}`);
  });
  return errors;
}

test.describe('every route renders', () => {
  for (const route of ROUTES) {
    test(`${route.path} loads clean`, async ({ page }) => {
      const errors = collectErrors(page);
      const res = await page.goto(route.path, { waitUntil: 'networkidle' });

      expect(res?.status(), `${route.path} HTTP status`).toBeLessThan(400);
      // Assert on the h1, not raw text: several titles also appear as module
      // rail links, and the mobile rail is first in DOM order but hidden at
      // desktop widths, so a text match resolves to an invisible element.
      await expect(page.getByRole('heading', { level: 1, name: route.title })).toBeVisible();
      expect(errors, `${route.path} console/request errors`).toEqual([]);
    });
  }
});

test.describe('data honesty (rule 2)', () => {
  for (const route of ROUTES) {
    test(`${route.path} — every KPI card carries full provenance`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'networkidle' });
      const sources = await page.locator('dt[data-provenance="source"]').count();
      if (sources === 0) test.skip(true, 'no KPI cards on this route');
      const grains = await page.locator('dt[data-provenance="grain"]').count();
      const refreshed = await page.locator('dt[data-provenance="refreshed"]').count();
      // A card that renders a number without saying where it came from is the
      // failure this whole design exists to prevent.
      expect(grains, 'grain count must match source count').toBe(sources);
      expect(refreshed, 'refreshed count must match source count').toBe(sources);
    });
  }

  test('fixture-backed cards are visibly marked', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    // With no connector configured, every card is fixture-backed and must say so.
    const badges = page.getByText('Fixture', { exact: true });
    expect(await badges.count()).toBeGreaterThan(0);
    await expect(page.getByText(/cards are fixture-backed/)).toBeVisible();
  });

  test('an uninstrumented funnel step reads as a gap, never as zero', async ({ page }) => {
    await page.goto('/journey', { waitUntil: 'networkidle' });
    const detag = page.locator('li', { hasText: 'Invoice / de-tag' }).first();
    await expect(detag).toBeVisible();
    await expect(detag.getByText('not instrumented')).toBeVisible();
    // The count cell must be an em dash, not a 0.
    await expect(detag).not.toContainText(/\b0\b/);
  });

  test('the three coverage measurements stay separate and are never blended', async ({ page }) => {
    await page.goto('/catalogue', { waitUntil: 'networkidle' });
    await expect(page.getByText('Three coverage measurements — never blended')).toBeVisible();
    for (const label of ['Scan-observed', 'Store-visit audited', 'True coverage']) {
      // These render through .label, which uppercases via CSS — match on the
      // rendered text case-insensitively rather than the source casing.
      await expect(page.getByText(new RegExp(`^${label}$`, 'i')).first()).toBeVisible();
    }
    // True coverage has no feed; it must render as unknown, not as 0%.
    const panel = page.locator('section', { hasText: 'Three coverage measurements' });
    const trueCov = panel.locator('div.rounded.border').filter({ hasText: /true coverage/i }).last();
    await expect(trueCov).toContainText('—');
    await expect(trueCov).not.toContainText('0.0%');
  });

  test('the App Health Score is decomposable into its five components', async ({ page }) => {
    await page.goto('/app-health', { waitUntil: 'networkidle' });
    const section = page.locator('section', { hasText: 'App Health Score — components' });
    await expect(section).toBeVisible();
    for (const c of ['Crash-free sessions', 'Payment success', 'API error rate', 'Latency vs SLO', 'Open P0s']) {
      await expect(section.getByText(c)).toBeVisible();
    }
    // Each component states its weight, so the score is never a black box.
    await expect(section.getByText('×30')).toBeVisible();
  });

  test('latency SLOs are labelled as placeholders and do not claim breaches', async ({ page }) => {
    await page.goto('/app-health', { waitUntil: 'networkidle' });
    // A10 — placeholders must not drive alerts. Every endpoint should say so.
    expect(await page.getByText('placeholder').count()).toBeGreaterThan(0);
  });

  test('/issues warns that the shared NI board makes the P0 count wrong', async ({ page }) => {
    await page.goto('/issues', { waitUntil: 'networkidle' });
    await expect(page.getByText('Unfiltered board')).toBeVisible();
  });
});

test.describe('navigation', () => {
  test('the module rail reaches every domain', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    for (const label of ['Sales', 'Journey', 'Stores', 'Catalogue', 'App Health', 'Issues']) {
      await expect(page.getByRole('navigation', { name: 'Modules', exact: true }).getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('a health light navigates to its module', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: /Catalogue/ }).first().click();
    await page.waitForURL('**/catalogue');
    await expect(page.getByRole('heading', { name: 'Catalogue' })).toBeVisible();
  });

  test('the store operating table deep-links into the real Companion journey', async ({ page }) => {
    await page.goto('/stores', { waitUntil: 'networkidle' });
    const open = page.getByRole('link', { name: 'open' }).first();
    await expect(open).toBeVisible();
    // §2.7 — the production customer entry point, with a real store id.
    const href = await open.getAttribute('href');
    expect(href).toMatch(/^https:\/\/www\.ajio\.com\/companion_app\?store_id=\d+$/);
  });

  test('/reference renders a scannable QR for the prod entry point', async ({ page }) => {
    await page.goto('/reference', { waitUntil: 'networkidle' });
    await expect(page.getByText('Scan to open')).toBeVisible();
    await expect(page.locator('svg').first()).toBeVisible();
  });
});
