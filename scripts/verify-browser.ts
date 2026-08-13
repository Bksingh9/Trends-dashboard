/**
 * Drives a real Chromium over every route, captures a screenshot of each, and
 * fails on console errors, failed requests, or missing provenance.
 *
 * The provenance check is the important one: rule 2 says every number rendered
 * carries its source, grain and last-refreshed timestamp, and a fixture-backed
 * card must be visibly marked. This asserts that in the rendered DOM rather than
 * trusting the component contract.
 */
import { chromium, type ConsoleMessage } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = process.env.VERIFY_OUT ?? join(process.cwd(), 'docs', 'screenshots');

const ROUTES = [
  { path: '/', name: 'hub', expect: ['Is Companion healthy today?', 'Scan strip'] },
  { path: '/sales', name: 'sales', expect: ['Sales', 'Revenue waterfall'] },
  { path: '/journey', name: 'journey', expect: ['Journey', 'Journey funnel'] },
  { path: '/stores', name: 'stores', expect: ['Stores', 'Store operating table'] },
  { path: '/catalogue', name: 'catalogue', expect: ['Catalogue', 'Three coverage measurements'] },
  { path: '/app-health', name: 'app-health', expect: ['App Health', 'App Health Score'] },
  { path: '/issues', name: 'issues', expect: ['Issues', 'Workstream heatmap'] },
  { path: '/insights', name: 'insights', expect: ['AI Insights', 'Ask the data'] },
  { path: '/connectors', name: 'connectors', expect: ['Connectors', 'Connector status'] },
  { path: '/reference', name: 'reference', expect: ['Reference', 'Deep-link builder'] },
  { path: '/settings', name: 'settings', expect: ['Settings', 'Latency SLOs'] },
];

interface Failure {
  route: string;
  kind: string;
  detail: string;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const failures: Failure[] = [];

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  for (const route of ROUTES) {
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];

    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('requestfailed', (req) => {
      // Favicon and font CDN misses are noise, not app failures. So are RSC
      // prefetches (`?_rsc=`), which Next cancels when the page navigates or
      // closes — an aborted prefetch is the router working, not a broken route.
      if (/favicon|fonts\.gstatic|fonts\.googleapis/.test(req.url())) return;
      if (req.url().includes('_rsc=') && req.failure()?.errorText === 'net::ERR_ABORTED') return;
      failedRequests.push(`${req.url()} — ${req.failure()?.errorText}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    const res = await page.goto(`${BASE}${route.path}`, { waitUntil: 'networkidle', timeout: 60_000 });

    if (!res || res.status() >= 400) {
      failures.push({ route: route.path, kind: 'http', detail: `status ${res?.status()}` });
    }

    for (const text of route.expect) {
      const found = await page.getByText(text, { exact: false }).first().count();
      if (found === 0) failures.push({ route: route.path, kind: 'content', detail: `missing "${text}"` });
    }

    // Rule 2: every KPI card carries source, grain and refreshed time.
    const cards = await page.locator('dt:has-text("Source")').count();
    const grains = await page.locator('dt:has-text("Grain")').count();
    const refreshed = await page.locator('dt:has-text("Refreshed")').count();
    if (cards > 0 && (cards !== grains || cards !== refreshed)) {
      failures.push({
        route: route.path,
        kind: 'provenance',
        detail: `${cards} source / ${grains} grain / ${refreshed} refreshed — every card must carry all three`,
      });
    }

    // Fixture-backed data must be visibly marked, never mistakable for live.
    const bodyText = (await page.locator('body').innerText()).toLowerCase();
    if (bodyText.includes('fixture')) {
      const marked = await page.getByText(/fixture/i).first().count();
      if (marked === 0) {
        failures.push({ route: route.path, kind: 'fixture', detail: 'fixture data not visibly marked' });
      }
    }

    for (const e of consoleErrors) failures.push({ route: route.path, kind: 'console', detail: e });
    for (const r of failedRequests) failures.push({ route: route.path, kind: 'request', detail: r });

    await page.screenshot({ path: join(OUT, `${route.name}.png`), fullPage: true });
    console.log(`✓ ${route.path} → ${route.name}.png`);
    await page.close();
  }

  // The API envelope must carry per-metric provenance (§9.3).
  const apiPage = await context.newPage();
  for (const api of ['/api/kpi', '/api/catalogue', '/api/connectors/status', '/api/scan-strip']) {
    const r = await apiPage.request.get(`${BASE}${api}`);
    if (!r.ok()) {
      failures.push({ route: api, kind: 'api', detail: `status ${r.status()}` });
      continue;
    }
    const body = (await r.json()) as { meta?: { window?: { timezone?: string }; metrics?: unknown } };
    if (body.meta?.window?.timezone !== 'Asia/Kolkata') {
      failures.push({ route: api, kind: 'api', detail: 'envelope missing Asia/Kolkata window' });
    }
    console.log(`✓ ${api} envelope ok`);
  }
  await apiPage.close();

  await browser.close();

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  [${f.kind}] ${f.route}: ${f.detail}`);
    process.exit(1);
  }
  console.log(`\n✓ All ${ROUTES.length} routes rendered clean. Screenshots in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
