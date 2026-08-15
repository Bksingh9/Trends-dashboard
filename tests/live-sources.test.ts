/**
 * The three defects that live credentials exposed, and the GA4 layer built on
 * top of them.
 *
 * All three had the same shape: code that reported success while doing less
 * than it claimed. None was visible without a real credential pointed at a real
 * warehouse, which is why they survived every previous review.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcile, HELP_EVENTS } from '@/lib/ga4/help-events';

/**
 * A real throwaway RSA key, generated here rather than pasted.
 *
 * The JWT is genuinely signed before the (stubbed) token exchange, so these
 * tests exercise the same signing path production does. A placeholder string
 * fails inside `createSign` with an OpenSSL decoder error, which would make
 * every test below fail for a reason that has nothing to do with what it
 * checks — and committing a real-looking key would trip secret scanning.
 */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Fakes BigQuery's `jobs.query` + `jobs.getQueryResults` pair.
 *
 * `pages` is how many pages of `rowsPerPage` rows exist. `completeAfter` is how
 * many polls the job takes to finish, so the "incomplete job read as empty" bug
 * can be reproduced.
 */
function fakeBigQuery(opts: { pages: number; rowsPerPage: number; completeAfter?: number }) {
  let polls = 0;
  const page = (index: number) => ({
    jobReference: { jobId: 'job-1', location: 'asia-south1' },
    jobComplete: polls >= (opts.completeAfter ?? 0),
    schema: { fields: [{ name: 'id', type: 'STRING' }] },
    rows:
      polls < (opts.completeAfter ?? 0)
        ? undefined
        : Array.from({ length: opts.rowsPerPage }, (_, i) => ({ f: [{ v: `p${index}r${i}` }] })),
    pageToken: index + 1 < opts.pages ? `tok-${index + 1}` : undefined,
    totalBytesProcessed: '1024',
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url.toString();
      if (href.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      if (init?.method === 'POST') {
        polls += 1;
        return new Response(JSON.stringify(page(0)), { status: 200 });
      }
      polls += 1;
      const token = new URL(href).searchParams.get('pageToken');
      const index = token ? Number(token.split('-')[1]) : 0;
      return new Response(JSON.stringify(page(index)), { status: 200 });
    }),
  );
}

const KEY = JSON.stringify({
  client_email: 'test@example.iam.gserviceaccount.com',
  private_key: privateKey,
  project_id: 'p',
});

describe('BigQuery reads every page', () => {
  /**
   * The defect: `jobs.query` returns at most the first page and hands back a
   * `pageToken` for the rest. That token was ignored. A 6.5 M-row catalogue
   * loaded 50,000 rows, the assertions passed on what arrived, and the run
   * reported `live` — while every EAN past the cut would have classified as
   * `absent_from_master`.
   */
  it('follows the page token instead of returning only the first page', async () => {
    vi.stubEnv('GCP_SA_KEY_JSON', KEY);
    vi.stubEnv('GCP_PROJECT_ID', 'p');
    fakeBigQuery({ pages: 4, rowsPerPage: 25 });
    const { runQuery } = await import('@/lib/gcp/bigquery');

    const r = await runQuery({ query: 'select 1', connector: 'test', pageSize: 25 });
    expect(r.rows).toHaveLength(100);
    expect(r.pages).toBe(4);
    expect(r.truncated).toBe(false);
  });

  it('stops at maxRows and says the answer is partial', async () => {
    vi.stubEnv('GCP_SA_KEY_JSON', KEY);
    vi.stubEnv('GCP_PROJECT_ID', 'p');
    fakeBigQuery({ pages: 10, rowsPerPage: 25 });
    const { runQuery } = await import('@/lib/gcp/bigquery');

    const r = await runQuery({ query: 'select 1', connector: 'test', pageSize: 25, maxRows: 60 });
    expect(r.rows).toHaveLength(60);
    // Truncation is reported, never inferred from the row count — a query
    // returning exactly maxRows and one cut off at maxRows look identical.
    expect(r.truncated).toBe(true);
  });

  it('does not call a single-page result truncated', async () => {
    vi.stubEnv('GCP_SA_KEY_JSON', KEY);
    vi.stubEnv('GCP_PROJECT_ID', 'p');
    fakeBigQuery({ pages: 1, rowsPerPage: 40 });
    const { runQuery } = await import('@/lib/gcp/bigquery');

    const r = await runQuery({ query: 'select 1', connector: 'test', pageSize: 50, maxRows: 40 });
    expect(r.rows).toHaveLength(40);
    expect(r.truncated).toBe(false);
  });

  it('waits for an incomplete job rather than reading it as empty', async () => {
    // `timeoutMs` bounds the request, not the query. A slow query returned
    // `jobComplete: false` with no rows and was reported as a successful run
    // over nothing.
    vi.stubEnv('GCP_SA_KEY_JSON', KEY);
    vi.stubEnv('GCP_PROJECT_ID', 'p');
    fakeBigQuery({ pages: 1, rowsPerPage: 12, completeAfter: 3 });
    const { runQuery } = await import('@/lib/gcp/bigquery');

    const r = await runQuery({ query: 'select 1', connector: 'test' });
    expect(r.rows).toHaveLength(12);
  });
});

describe('a credential that arrives after startup is actually used', () => {
  /**
   * `config` is built once at import from `process.env`. "Test connection" sets
   * `GCP_SA_KEY_JSON` for the length of one call, so every GCP test failed with
   * "GCP_SA_KEY_JSON not configured" — including the ones holding a good key,
   * and the message blamed the credential.
   */
  it('reads a key set after the config module was loaded', async () => {
    const { serviceAccountKey, resetTokenCache } = await import('@/lib/gcp/auth');
    resetTokenCache();
    expect(serviceAccountKey()).toBeNull();

    process.env.GCP_SA_KEY_JSON = KEY;
    expect(serviceAccountKey()?.client_email).toBe('test@example.iam.gserviceaccount.com');
    delete process.env.GCP_SA_KEY_JSON;
    expect(serviceAccountKey()).toBeNull();
  });

  it('does not hand one account’s token to another', async () => {
    // A single global token cache returns whichever token was fetched first.
    // Test account A, then B, and B reports "connected" on A's token — a
    // credential that was never checked, reported as working.
    vi.stubEnv('GCP_PROJECT_ID', 'p');
    const issued: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = String(init?.body ?? '');
        const assertion = new URLSearchParams(body).get('assertion') ?? '';
        const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString() || '{}');
        issued.push(claims.iss ?? '?');
        return new Response(JSON.stringify({ access_token: `tok-for-${claims.iss}`, expires_in: 3600 }), {
          status: 200,
        });
      }),
    );

    const { getAccessToken, resetTokenCache } = await import('@/lib/gcp/auth');
    resetTokenCache();

    process.env.GCP_SA_KEY_JSON = JSON.stringify({ client_email: 'a@x.iam.gserviceaccount.com', private_key: privateKey });
    const a = await getAccessToken(['scope-1']);
    process.env.GCP_SA_KEY_JSON = JSON.stringify({ client_email: 'b@x.iam.gserviceaccount.com', private_key: privateKey });
    const b = await getAccessToken(['scope-1']);

    expect(a).not.toBe(b);
    expect(issued).toEqual(['a@x.iam.gserviceaccount.com', 'b@x.iam.gserviceaccount.com']);
    delete process.env.GCP_SA_KEY_JSON;
  });
});

describe('GA4 help events', () => {
  const payload = (rows: unknown) => new Response(JSON.stringify(rows), { status: 200 });

  function stubGa4(byEvent: unknown, byDate: unknown, totals: unknown) {
    const queue = [byEvent, byDate, totals];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = typeof url === 'string' ? url : url.toString();
        if (href.includes('oauth2')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
        }
        // The two parallel reports resolve in either order; totals is awaited
        // afterwards, so it is always last.
        const next = call < 2 ? queue[call] : queue[2];
        call += 1;
        return payload(next);
      }),
    );
  }

  it('never sums events-per-user, because a ratio does not add', async () => {
    vi.stubEnv('GCP_SA_KEY_JSON', KEY);
    stubGa4(
      {
        rows: [
          { dimensionValues: [{ value: 'help_support_sheet_view' }], metricValues: [{ value: '71' }, { value: '29' }, { value: '2.45' }, { value: '0' }] },
          { dimensionValues: [{ value: 'help_support_tap' }], metricValues: [{ value: '80' }, { value: '25' }, { value: '3.20' }, { value: '0' }] },
          { dimensionValues: [{ value: 'help_support_call_tap' }], metricValues: [{ value: '19' }, { value: '11' }, { value: '1.72' }, { value: '0' }] },
        ],
      },
      { rows: [] },
      { rows: [{ metricValues: [{ value: '170' }, { value: '29' }, { value: '0' }] }] },
    );
    const { fetchHelpEvents } = await import('@/lib/ga4/help-events');
    const r = await fetchHelpEvents({ startDate: '2026-07-16', endDate: '2026-08-12' });

    // 2.45 + 3.20 + 1.72 = 7.37, which is plausible and meaningless.
    expect(r.summary.eventCountPerActiveUser).toBeCloseTo(170 / 29, 2);
    expect(r.summary.eventCount).toBe(170);
    // Users come from the property-level total, not the sum of three
    // overlapping per-event figures: the same person appears in more than one.
    expect(r.summary.totalUsers).toBe(29);
    expect(r.events[0].eventCount).toBe(80);
  });

  it('converts GA4’s YYYYMMDD to the ISO dates the rest of the codebase uses', async () => {
    vi.stubEnv('GCP_SA_KEY_JSON', KEY);
    stubGa4(
      { rows: [] },
      {
        rows: [
          { dimensionValues: [{ value: '20260801' }, { value: 'help_support_tap' }], metricValues: [{ value: '8' }] },
          { dimensionValues: [{ value: '20260801' }, { value: 'help_support_sheet_view' }], metricValues: [{ value: '10' }] },
          { dimensionValues: [{ value: '20260802' }, { value: 'help_support_call_tap' }], metricValues: [{ value: '2' }] },
        ],
      },
      { rows: [{ metricValues: [{ value: '20' }, { value: '5' }, { value: '0' }] }] },
    );
    const { fetchHelpEvents } = await import('@/lib/ga4/help-events');
    const r = await fetchHelpEvents();

    expect(r.timeSeries.map((p) => p.date)).toEqual(['2026-08-01', '2026-08-02']);
    expect(r.timeSeries[0].help_support_tap).toBe(8);
    expect(r.timeSeries[0].help_support_sheet_view).toBe(10);
    // A day with no rows for an event is zero on that day, which is correct —
    // the event fired zero times, not "we did not look".
    expect(r.timeSeries[0].help_support_call_tap).toBe(0);
  });

  it('names the remedy for each way GA4 refuses, because they have different owners', async () => {
    vi.stubEnv('GCP_SA_KEY_JSON', KEY);
    const cases: Array<[number, string, string]> = [
      [403, 'Google Analytics Data API has not been used in project 1 before', 'api_disabled'],
      [403, 'User does not have sufficient permissions', 'no_access'],
      [404, 'not found', 'bad_property'],
    ];
    const { fetchHelpEvents, Ga4Unavailable } = await import('@/lib/ga4/help-events');

    for (const [status, message, kind] of cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL) => {
          const href = typeof url === 'string' ? url : url.toString();
          if (href.includes('oauth2')) {
            return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: { message } }), { status });
        }),
      );
      await expect(fetchHelpEvents({ propertyId: '524294430' })).rejects.toMatchObject({ kind });
      await expect(fetchHelpEvents({ propertyId: '524294430' })).rejects.toBeInstanceOf(Ga4Unavailable);
    }
  });

  it('filters to exactly the three help events', () => {
    expect([...HELP_EVENTS]).toEqual([
      'help_support_sheet_view',
      'help_support_tap',
      'help_support_call_tap',
    ]);
  });

  it('says whether a reading agrees with the GA4 UI rather than leaving it to the reader', () => {
    // The Data API samples and the UI thresholds. Small divergence is expected;
    // large divergence is a finding, and the sentence has to say which.
    expect(reconcile({ eventCount: 170, totalUsers: 29 })).toMatch(/Within 0.0%/);
    expect(reconcile({ eventCount: 174, totalUsers: 29 })).toMatch(/Within 2.4%/);
    expect(reconcile({ eventCount: 300, totalUsers: 40 })).toMatch(/76.5% above/);
    expect(reconcile({ eventCount: 20, totalUsers: 4 })).toMatch(/88.2% below/);
  });
});
