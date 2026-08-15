import { expect, test } from '@playwright/test';

/**
 * §10.2 — the type system, checked where it is actually applied.
 *
 * This exists because the type system was wired and did not work, and nothing
 * caught it. `next/font` set `--font-archivo` and friends on `<body>`, while
 * Tailwind's `@theme` consumed them at `:root` — one level above. Custom
 * properties inherit downward, so the references resolved to nothing and every
 * element in the product fell back to the system sans.
 *
 * It was invisible in review: the source looked correct, the build emitted the
 * woff2 files, and a screenshot of a dark dashboard in a fallback grotesque
 * looks fine unless you know what it should be.
 *
 * The functional loss was `.num`. Every figure in this product is meant to be
 * IBM Plex Mono for tabular numerals, so columns of orders, coverage
 * percentages and latencies line up digit over digit. In a proportional font
 * they do not, and a column of numbers you cannot scan is the whole reason the
 * choice was made.
 *
 * So this asserts computed style in a real browser rather than the presence of
 * a class name — the class was always there.
 */

test.describe('typography actually applies', () => {
  test('the font variables resolve on the element that consumes them', async ({ page }) => {
    await page.goto('/sales');
    const vars = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        archivo: cs.getPropertyValue('--font-archivo').trim(),
        inter: cs.getPropertyValue('--font-inter-tight').trim(),
        mono: cs.getPropertyValue('--font-plex-mono').trim(),
      };
    });
    // Empty here is the exact failure: `:root` is where `@theme` reads them.
    expect(vars.archivo, '--font-archivo is empty at :root').toContain('Archivo');
    expect(vars.inter, '--font-inter-tight is empty at :root').toContain('Inter Tight');
    expect(vars.mono, '--font-plex-mono is empty at :root').toContain('IBM Plex Mono');
  });

  test('every numeral is set in the mono face', async ({ page }) => {
    // §10.2's one dogmatic choice. Tabular figures are why.
    await page.goto('/sales');
    const num = page.locator('.num').first();
    await expect(num).toBeVisible();
    const family = await num.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain('IBM Plex Mono');

    const variant = await num.evaluate((el) => getComputedStyle(el).fontVariantNumeric);
    expect(variant).toContain('tabular-nums');
  });

  test('module titles use the display face, and body text does not', async ({ page }) => {
    await page.goto('/sales');
    const display = page.locator('.display').first();
    await expect(display).toBeVisible();
    expect(await display.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Archivo');

    // The display face is for titles only; if body picked it up, the
    // distinction the scale is built on has collapsed.
    const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(body).toContain('Inter Tight');
    expect(body).not.toContain('Archivo');
  });

  test('the type scale is present and ordered', async ({ page }) => {
    await page.goto('/sales');
    const scale = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl'].map((k) =>
        parseFloat(cs.getPropertyValue(`--text-${k}`)),
      );
    });
    expect(scale.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
    // A scale that is not monotonic is not a scale.
    for (let i = 1; i < scale.length; i++) expect(scale[i]).toBeGreaterThan(scale[i - 1]);
  });

  test('the fonts are self-hosted, not fetched from Google at runtime', async ({ page }) => {
    // next/font downloads at build time. A request to fonts.gstatic.com in the
    // browser means that stopped working, and it is both a privacy and a
    // latency regression.
    const external: string[] = [];
    page.on('request', (r) => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) external.push(r.url());
    });
    await page.goto('/sales', { waitUntil: 'networkidle' });
    expect(external).toEqual([]);
  });
});
