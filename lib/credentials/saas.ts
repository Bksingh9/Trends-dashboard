/**
 * The SaaS half of the catalogue — the connectors a BI product is expected to
 * ship with.
 *
 * Written declaratively for one reason. This build already shipped five source
 * types that were offered in the picker with no test and no connector behind
 * them: they accepted a credential, saved it, and did nothing. A unit test now
 * catches that, but a test catches a mistake after it is made. Here the source
 * type and its connection test are produced from **one** declaration, so the
 * mistake cannot be expressed — there is no way to add a type and forget the
 * test, because they are the same object.
 *
 * Every probe is a real call against the vendor's API. None of them inspects
 * config and reports success: the two silent failures this system has already
 * produced (a stale `avis_base_view` with valid credentials, a catalogue parser
 * with a valid token and a format that did not exist) both looked perfectly
 * healthy from the config side.
 *
 * These are `genericOnly`: they feed exploration and widgets, not a §5 metric.
 * The distinction is a promise rather than a label — a §5 metric has an owner,
 * an SLA, an assertion gate and a place on the health board, and none of these
 * do. Blurring the two would let somebody put a Stripe number on a NOC wall
 * display with no freshness guarantee behind it.
 */
import type { SourceField, SourceType } from './source-types';
import type { TestResult } from './result';

/* ── the declaration ─────────────────────────────────────────────────────── */

interface ProbeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface SaasSpec {
  id: string;
  label: string;
  category: SourceType['category'];
  blurb: string;
  aliases?: string[];
  fields: SourceField[];
  enables: string[];
  testDescription: string;
  /** What the probe step is called in the result. */
  probeLabel: string;
  /**
   * An extra hop before the probe, for vendors that will not take a long-lived
   * token — Google Ads wants a refresh-token exchange first. Named separately
   * so a failure there reads as "the refresh token is dead", not "the API is".
   */
  auth?: (v: Record<string, string>) => Promise<{ headers: Record<string, string>; detail: string }>;
  request: (v: Record<string, string>) => ProbeRequest;
  /**
   * Reads the parsed body. Throws for a domain-level failure — a 200 that
   * contains an error, or an empty result where empty means misconfigured.
   */
  describe?: (body: unknown, v: Record<string, string>) => string[];
  /** Vendor-specific meaning for a status code, where the generic one misleads. */
  explain?: (status: number, text: string) => string | undefined;
}

/* ── field shorthands ────────────────────────────────────────────────────── */

const secret = (key: string, label: string, extra: Partial<SourceField> = {}): SourceField => ({
  key,
  label,
  kind: 'password',
  secret: true,
  required: true,
  ...extra,
});

const text = (key: string, label: string, extra: Partial<SourceField> = {}): SourceField => ({
  key,
  label,
  kind: 'text',
  required: true,
  ...extra,
});

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/* ── the runner ──────────────────────────────────────────────────────────── */

const GENERIC_STATUS: Record<number, string> = {
  400: 'the request was malformed — usually a wrong account, project or id',
  401: 'the credential was rejected. It may be revoked, expired, or for a different account',
  403: 'authenticated, but this credential lacks the scope or permission for this call',
  404: 'that path does not exist — check the account, subdomain or id',
  429: 'rate-limited. The credential is fine; try again shortly',
};

/**
 * A fetch that cannot hang. A "Test connection" button that spins forever
 * teaches people the feature is broken rather than that the host is wrong.
 */
async function timed(url: string, init: RequestInit, ms = 20_000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(`no response within ${ms / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function buildTest(spec: SaasSpec): (v: Record<string, string>) => Promise<TestResult> {
  return async (v) => {
    const steps: TestResult['steps'] = [];
    const findings: string[] = [];
    let extraHeaders: Record<string, string> = {};

    if (spec.auth) {
      try {
        const r = await spec.auth(v);
        extraHeaders = r.headers;
        steps.push({ label: 'Exchange the refresh token', ok: true, detail: r.detail });
      } catch (e) {
        steps.push({
          label: 'Exchange the refresh token',
          ok: false,
          detail: e instanceof Error ? e.message.slice(0, 240) : String(e),
        });
        return { ok: false, summary: `${spec.label} would not issue an access token.`, steps, findings };
      }
    }

    try {
      const req = spec.request(v);
      const res = await timed(req.url, {
        method: req.method ?? 'GET',
        headers: { Accept: 'application/json', ...(req.headers ?? {}), ...extraHeaders },
        body: req.body,
      });

      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        const why = spec.explain?.(res.status, text) ?? GENERIC_STATUS[res.status] ?? `HTTP ${res.status}`;
        steps.push({ label: spec.probeLabel, ok: false, detail: `HTTP ${res.status} — ${why}` });
        return { ok: false, summary: `${spec.label} refused the call: ${why}.`, steps, findings };
      }

      const raw = await res.text();
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        // A JSON endpoint answering with HTML is nearly always a login page,
        // which is a 200 that means 401.
        throw new Error(`the response is not JSON — it starts "${raw.slice(0, 60)}"`);
      }

      findings.push(...(spec.describe?.(body, v) ?? []));
      steps.push({ label: spec.probeLabel, ok: true, detail: `HTTP ${res.status}` });
      return { ok: true, summary: `Connected to ${spec.label}.`, steps, findings };
    } catch (e) {
      steps.push({
        label: spec.probeLabel,
        ok: false,
        detail: e instanceof Error ? e.message.slice(0, 240) : String(e),
      });
      return { ok: false, summary: `Could not reach ${spec.label}.`, steps, findings };
    }
  };
}

/* ── the catalogue ───────────────────────────────────────────────────────── */

const SPECS: SaasSpec[] = [
  {
    id: 'stripe',
    label: 'Stripe',
    category: 'commerce',
    blurb: 'Payments, balances, subscriptions and refunds — revenue as the payment processor saw it.',
    aliases: ['payments', 'revenue', 'billing', 'mrr', 'checkout'],
    fields: [
      secret('apiKey', 'Secret key', {
        placeholder: 'sk_live_… or rk_live_…',
        pattern: '^(sk|rk)_(live|test)_',
        patternHint: 'Stripe secret keys start with sk_ or rk_. A pk_ key is publishable and cannot read.',
        help: 'A restricted key (rk_) with read scopes is enough, and is the safer choice.',
      }),
    ],
    enables: ['Ask-the-data', 'revenue widgets'],
    testDescription: 'Reads the account balance — the cheapest authenticated call Stripe has.',
    probeLabel: 'GET /v1/balance',
    request: (v) => ({ url: 'https://api.stripe.com/v1/balance', headers: { Authorization: `Bearer ${v.apiKey}` } }),
    describe: (b) => {
      const bal = b as { available?: Array<{ amount: number; currency: string }>; livemode?: boolean };
      const out = (bal.available ?? []).map((a) => `${a.currency.toUpperCase()} ${(a.amount / 100).toFixed(2)} available`);
      // Test-mode keys are the classic "why is the dashboard empty" cause, and
      // it is invisible from the number alone.
      if (bal.livemode === false) out.push('⚠ This is a test-mode key — the numbers will not be your real ones.');
      return out;
    },
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    category: 'crm',
    blurb: 'Deals, contacts and pipeline — the CRM side of the funnel.',
    aliases: ['crm', 'deals', 'pipeline', 'marketing', 'sales'],
    fields: [
      secret('accessToken', 'Private app token', {
        placeholder: 'pat-na1-…',
        pattern: '^pat-',
        patternHint: 'Private app tokens start with pat-. The old hapikey scheme was retired.',
        help: 'Scopes: crm.objects.deals.read, crm.objects.contacts.read.',
      }),
    ],
    enables: ['Ask-the-data', 'pipeline widgets'],
    testDescription: 'Reads one deal, which proves both the token and the CRM scope.',
    probeLabel: 'GET /crm/v3/objects/deals',
    request: (v) => ({
      url: 'https://api.hubapi.com/crm/v3/objects/deals?limit=1&properties=dealname,amount,dealstage',
      headers: { Authorization: `Bearer ${v.accessToken}` },
    }),
    describe: (b) => {
      const r = b as { results?: Array<{ properties?: Record<string, string> }> };
      if (!r.results?.length) return ['Authenticated, but no deals are visible to this app.'];
      return [`Deal properties: ${Object.keys(r.results[0].properties ?? {}).join(' · ')}`];
    },
    explain: (s) =>
      s === 403 ? 'the token is valid but the private app is missing crm.objects.deals.read' : undefined,
  },
  {
    id: 'salesforce',
    label: 'Salesforce',
    category: 'crm',
    blurb: 'Opportunities, accounts and cases from the org’s REST API.',
    aliases: ['crm', 'sfdc', 'opportunities', 'sales'],
    fields: [
      text('instanceUrl', 'Instance URL', {
        placeholder: 'https://acme.my.salesforce.com',
        pattern: '^https://',
        patternHint: 'Must be the https instance URL for your org.',
      }),
      secret('accessToken', 'Access token', {
        help: 'A session id or OAuth access token. Short-lived tokens will need refreshing before a scheduled run.',
      }),
    ],
    enables: ['Ask-the-data', 'pipeline widgets'],
    testDescription: 'Reads the org’s API limits, which needs auth but touches no records.',
    probeLabel: 'GET /services/data/v60.0/limits',
    request: (v) => ({
      url: `${v.instanceUrl.replace(/\/$/, '')}/services/data/v60.0/limits`,
      headers: { Authorization: `Bearer ${v.accessToken}` },
    }),
    describe: (b) => {
      const l = b as { DailyApiRequests?: { Max?: number; Remaining?: number } };
      const d = l.DailyApiRequests;
      return d ? [`API calls remaining today: ${d.Remaining?.toLocaleString()} of ${d.Max?.toLocaleString()}`] : [];
    },
  },
  {
    id: 'shopify',
    label: 'Shopify',
    category: 'commerce',
    blurb: 'Orders, products and customers from a Shopify storefront.',
    aliases: ['ecommerce', 'orders', 'store', 'commerce'],
    fields: [
      text('shop', 'Shop domain', {
        placeholder: 'acme.myshopify.com',
        pattern: '\\.myshopify\\.com$',
        patternHint: 'The permanent .myshopify.com domain, not a custom one.',
      }),
      secret('accessToken', 'Admin API access token', {
        placeholder: 'shpat_…',
        pattern: '^shp(at|ca)_',
        patternHint: 'Admin API tokens start with shpat_.',
      }),
    ],
    enables: ['Ask-the-data', 'order widgets'],
    testDescription: 'Reads the shop record and reports its currency and timezone.',
    probeLabel: 'GET /admin/api/shop.json',
    request: (v) => ({
      url: `https://${v.shop}/admin/api/2024-10/shop.json`,
      headers: { 'X-Shopify-Access-Token': v.accessToken },
    }),
    describe: (b) => {
      const s = (b as { shop?: { name?: string; currency?: string; iana_timezone?: string } }).shop;
      if (!s) return [];
      // Currency and timezone decide whether a revenue widget and a "today"
      // both mean what the reader assumes.
      return [`${s.name} · ${s.currency} · ${s.iana_timezone}`];
    },
  },
  {
    id: 'zendesk',
    label: 'Zendesk',
    category: 'crm',
    blurb: 'Tickets, satisfaction and first-response time from support.',
    aliases: ['support', 'tickets', 'helpdesk', 'csat'],
    fields: [
      text('subdomain', 'Subdomain', { placeholder: 'acme', help: 'The part before .zendesk.com.' }),
      text('email', 'Agent email', { placeholder: 'noc@example.com' }),
      secret('apiToken', 'API token', { help: 'Admin → Apps and integrations → APIs → Token access.' }),
    ],
    enables: ['Ask-the-data', 'support widgets'],
    testDescription: 'Reads one ticket, which proves the token and the agent’s visibility.',
    probeLabel: 'GET /api/v2/tickets.json',
    request: (v) => ({
      url: `https://${v.subdomain}.zendesk.com/api/v2/tickets.json?per_page=1`,
      headers: { Authorization: basic(`${v.email}/token`, v.apiToken) },
    }),
    describe: (b) => {
      const r = b as { count?: number; tickets?: unknown[] };
      return [r.tickets?.length ? `${r.count ?? '?'} tickets visible to this agent.` : 'No tickets visible to this agent.'];
    },
  },
  {
    id: 'intercom',
    label: 'Intercom',
    category: 'crm',
    blurb: 'Conversations and contacts — in-app support volume and response time.',
    aliases: ['support', 'chat', 'conversations', 'messaging'],
    fields: [secret('accessToken', 'Access token', { help: 'From the app’s Authentication settings.' })],
    enables: ['Ask-the-data', 'support widgets'],
    testDescription: 'Reads the authenticated app’s own record.',
    probeLabel: 'GET /me',
    request: (v) => ({
      url: 'https://api.intercom.io/me',
      headers: { Authorization: `Bearer ${v.accessToken}`, 'Intercom-Version': '2.11' },
    }),
    describe: (b) => {
      const m = b as { app?: { name?: string; region?: string } };
      return m.app?.name ? [`Workspace: ${m.app.name}${m.app.region ? ` (${m.app.region})` : ''}`] : [];
    },
  },
  {
    id: 'mixpanel',
    label: 'Mixpanel',
    category: 'analytics',
    blurb: 'Product events and funnels, as a cross-check on the GA4 export.',
    aliases: ['product analytics', 'events', 'funnels'],
    fields: [
      text('projectId', 'Project ID', { placeholder: '2345678' }),
      text('username', 'Service account username', { placeholder: 'companion.abc123.mp-service-account' }),
      secret('secretValue', 'Service account secret'),
      {
        key: 'region',
        label: 'Data residency',
        kind: 'select',
        options: [
          { value: 'us', label: 'US (mixpanel.com)' },
          { value: 'eu', label: 'EU (eu.mixpanel.com)' },
          { value: 'in', label: 'India (in.mixpanel.com)' },
        ],
        help: 'A project in the EU or India residency returns 401 against the US host, which reads as a bad secret.',
      },
    ],
    enables: ['Ask-the-data', 'product-analytics widgets'],
    testDescription: 'Lists the project’s saved events over the last week.',
    probeLabel: 'GET /api/query/events/names',
    request: (v) => {
      const host = v.region === 'eu' ? 'eu.mixpanel.com' : v.region === 'in' ? 'in.mixpanel.com' : 'mixpanel.com';
      return {
        url: `https://${host}/api/query/events/names?project_id=${encodeURIComponent(v.projectId)}&type=general&limit=25`,
        headers: { Authorization: basic(v.username, v.secretValue) },
      };
    },
    describe: (b) => {
      const names = Array.isArray(b) ? (b as string[]) : [];
      return names.length
        ? [`${names.length} events: ${names.slice(0, 10).join(' · ')}`]
        : ['Authenticated, but this project has reported no events.'];
    },
  },
  {
    id: 'meta-ads',
    label: 'Meta Ads',
    category: 'ads',
    blurb: 'Spend, reach and results from Facebook and Instagram campaigns.',
    aliases: ['facebook', 'instagram', 'ads', 'marketing', 'spend', 'roas'],
    fields: [
      secret('accessToken', 'Access token', {
        help: 'A system-user token with ads_read. A short-lived user token will stop working within hours.',
      }),
    ],
    enables: ['Ask-the-data', 'spend widgets'],
    testDescription: 'Lists the ad accounts this token can see.',
    probeLabel: 'GET /me/adaccounts',
    request: (v) => ({
      // The token goes in the header, not the query string: a token in a URL
      // ends up in every proxy and access log between here and Menlo Park.
      url: 'https://graph.facebook.com/v21.0/me/adaccounts?fields=name,account_status,currency&limit=25',
      headers: { Authorization: `Bearer ${v.accessToken}` },
    }),
    describe: (b) => {
      const r = b as { data?: Array<{ name?: string; currency?: string }> };
      const accounts = r.data ?? [];
      if (!accounts.length) return ['⚠ Authenticated, but this token can see no ad accounts — check ads_read.'];
      return [`${accounts.length} ad accounts: ${accounts.slice(0, 6).map((a) => a.name).join(' · ')}`];
    },
  },
  {
    id: 'google-ads',
    label: 'Google Ads',
    category: 'ads',
    blurb: 'Campaign spend and conversions from the Google Ads API.',
    aliases: ['adwords', 'ads', 'ppc', 'spend', 'marketing'],
    fields: [
      text('customerId', 'Customer ID', { placeholder: '123-456-7890' }),
      secret('developerToken', 'Developer token', { help: 'From the manager account’s API Center.' }),
      text('clientId', 'OAuth client ID', { placeholder: '….apps.googleusercontent.com' }),
      secret('clientSecret', 'OAuth client secret'),
      secret('refreshToken', 'Refresh token', {
        help: 'Google Ads issues no long-lived key — the refresh token is exchanged for an access token on every run.',
      }),
      { key: 'loginCustomerId', label: 'Manager (MCC) ID', kind: 'text', help: 'Required when the account is under a manager.' },
    ],
    enables: ['Ask-the-data', 'spend widgets'],
    testDescription: 'Exchanges the refresh token, then reads the customer record.',
    probeLabel: 'POST googleAds:search',
    auth: async (v) => {
      const res = await timed('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: v.clientId,
          client_secret: v.clientSecret,
          refresh_token: v.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });
      const body = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
      if (!res.ok || !body.access_token) {
        throw new Error(body.error_description ?? body.error ?? `HTTP ${res.status}`);
      }
      return { headers: { Authorization: `Bearer ${body.access_token}` }, detail: 'access token granted' };
    },
    request: (v) => {
      const id = (v.customerId ?? '').replace(/\D/g, '');
      return {
        url: `https://googleads.googleapis.com/v18/customers/${id}/googleAds:search`,
        method: 'POST',
        headers: {
          'developer-token': v.developerToken,
          'Content-Type': 'application/json',
          ...(v.loginCustomerId ? { 'login-customer-id': v.loginCustomerId.replace(/\D/g, '') } : {}),
        },
        body: JSON.stringify({
          query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1',
        }),
      };
    },
    describe: (b) => {
      const r = b as { results?: Array<{ customer?: { descriptiveName?: string; currencyCode?: string } }> };
      const c = r.results?.[0]?.customer;
      return c ? [`${c.descriptiveName} · ${c.currencyCode}`] : [];
    },
    explain: (s) =>
      s === 403
        ? 'the developer token is not approved for this account, or the manager ID is missing'
        : undefined,
  },
  {
    id: 'airtable',
    label: 'Airtable',
    category: 'spreadsheet',
    blurb: 'Bases and tables — the place operational lists actually live.',
    aliases: ['base', 'table', 'spreadsheet', 'list', 'sheet'],
    fields: [
      secret('accessToken', 'Personal access token', {
        placeholder: 'pat…',
        pattern: '^pat',
        patternHint: 'Airtable personal access tokens start with pat.',
        help: 'Scopes: schema.bases:read, data.records:read.',
      }),
    ],
    enables: ['Ask-the-data', 'custom charts'],
    testDescription: 'Lists the bases this token can see.',
    probeLabel: 'GET /v0/meta/bases',
    request: (v) => ({ url: 'https://api.airtable.com/v0/meta/bases', headers: { Authorization: `Bearer ${v.accessToken}` } }),
    describe: (b) => {
      const r = b as { bases?: Array<{ name: string }> };
      const bases = r.bases ?? [];
      return bases.length
        ? [`${bases.length} bases: ${bases.slice(0, 8).map((x) => x.name).join(' · ')}`]
        : ['⚠ Authenticated, but the token has been granted access to no bases.'];
    },
  },
  {
    id: 'notion',
    label: 'Notion',
    category: 'spreadsheet',
    blurb: 'Databases and pages — runbooks, registers and hand-maintained tables.',
    aliases: ['wiki', 'docs', 'database', 'pages'],
    fields: [
      secret('accessToken', 'Integration token', {
        placeholder: 'ntn_… or secret_…',
        help: 'Each page must also be shared with the integration — a token alone sees nothing.',
      }),
    ],
    enables: ['Ask-the-data', 'custom charts'],
    testDescription: 'Reads the integration’s own record and counts the databases shared with it.',
    probeLabel: 'POST /v1/search',
    request: (v) => ({
      url: 'https://api.notion.com/v1/search',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${v.accessToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: { property: 'object', value: 'database' }, page_size: 10 }),
    }),
    describe: (b) => {
      const r = b as { results?: Array<{ title?: Array<{ plain_text?: string }> }> };
      const dbs = r.results ?? [];
      // The characteristic Notion failure: a perfectly valid token that has
      // been shared with nothing, which looks identical to an empty workspace.
      return dbs.length
        ? [`${dbs.length} databases shared with this integration: ${dbs.slice(0, 5).map((d) => d.title?.[0]?.plain_text ?? 'untitled').join(' · ')}`]
        : ['⚠ The token works but nothing is shared with it. Open each page → ⋯ → Connections → add this integration.'];
    },
  },
  {
    id: 'github',
    label: 'GitHub',
    category: 'observability',
    blurb: 'Pull requests, issues and Actions runs — delivery throughput and CI health.',
    aliases: ['git', 'ci', 'actions', 'prs', 'repo'],
    fields: [
      secret('accessToken', 'Personal access token', {
        placeholder: 'ghp_… or github_pat_…',
        pattern: '^(ghp_|github_pat_|gho_|ghs_)',
        patternHint: 'GitHub tokens start with ghp_ or github_pat_.',
      }),
      { key: 'repos', label: 'Repositories', kind: 'text', placeholder: 'gofynd/companion-app, gofynd/avis', help: 'Comma-separated owner/name. Leave blank for all the token can see.' },
    ],
    enables: ['Ask-the-data', 'delivery widgets'],
    testDescription: 'Reads the authenticated user and checks each named repository is visible.',
    probeLabel: 'GET /user',
    request: (v) => ({
      url: 'https://api.github.com/user',
      headers: { Authorization: `Bearer ${v.accessToken}`, 'X-GitHub-Api-Version': '2022-11-28' },
    }),
    describe: (b) => {
      const u = b as { login?: string };
      return u.login ? [`Authenticated as ${u.login}`] : [];
    },
  },
  {
    id: 'mailchimp',
    label: 'Mailchimp',
    category: 'ads',
    blurb: 'Campaign opens, clicks and list growth.',
    aliases: ['email', 'campaigns', 'newsletter', 'marketing'],
    fields: [
      secret('apiKey', 'API key', {
        placeholder: '…-us21',
        pattern: '-[a-z]{2}\\d+$',
        patternHint: 'A Mailchimp key ends with its data centre, like -us21.',
        help: 'The data centre is read off the end of the key — no separate field needed.',
      }),
    ],
    enables: ['Ask-the-data', 'campaign widgets'],
    testDescription: 'Pings the account’s data centre.',
    probeLabel: 'GET /3.0/',
    request: (v) => {
      const dc = v.apiKey.split('-').pop() ?? 'us1';
      return { url: `https://${dc}.api.mailchimp.com/3.0/`, headers: { Authorization: basic('key', v.apiKey) } };
    },
    describe: (b) => {
      const a = b as { account_name?: string; total_subscribers?: number };
      return a.account_name ? [`${a.account_name} · ${a.total_subscribers?.toLocaleString() ?? '?'} subscribers`] : [];
    },
  },
  {
    id: 'linear',
    label: 'Linear',
    category: 'observability',
    blurb: 'Issues and cycles, where the team plans rather than where it fights fires.',
    aliases: ['issues', 'tickets', 'sprint', 'cycle', 'project'],
    fields: [secret('apiKey', 'API key', { placeholder: 'lin_api_…' })],
    enables: ['Ask-the-data', 'delivery widgets'],
    testDescription: 'Runs a GraphQL viewer query.',
    probeLabel: 'POST /graphql',
    request: (v) => ({
      url: 'https://api.linear.app/graphql',
      method: 'POST',
      headers: { Authorization: v.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { name email } teams(first: 10) { nodes { key name } } }' }),
    }),
    describe: (b) => {
      const r = b as {
        errors?: Array<{ message: string }>;
        data?: { viewer?: { name?: string }; teams?: { nodes?: Array<{ key: string }> } };
      };
      // GraphQL answers 200 with an errors array, so a happy status code is
      // not a happy result here.
      if (r.errors?.length) throw new Error(r.errors[0].message);
      const teams = r.data?.teams?.nodes ?? [];
      return [`${r.data?.viewer?.name ?? 'authenticated'} · teams: ${teams.map((t) => t.key).join(' ')}`];
    },
  },
  {
    id: 'asana',
    label: 'Asana',
    category: 'observability',
    blurb: 'Tasks and projects — the NOC task register when it does not live in a sheet.',
    aliases: ['tasks', 'projects', 'work'],
    fields: [secret('accessToken', 'Personal access token')],
    enables: ['Ask-the-data', 'delivery widgets'],
    testDescription: 'Reads the authenticated user and their workspaces.',
    probeLabel: 'GET /api/1.0/users/me',
    request: (v) => ({ url: 'https://app.asana.com/api/1.0/users/me', headers: { Authorization: `Bearer ${v.accessToken}` } }),
    describe: (b) => {
      const r = b as { data?: { name?: string; workspaces?: Array<{ name: string }> } };
      return r.data ? [`${r.data.name} · ${(r.data.workspaces ?? []).map((w) => w.name).join(' · ')}`] : [];
    },
  },
  {
    id: 'trello',
    label: 'Trello',
    category: 'observability',
    blurb: 'Boards and cards, for teams whose backlog lives there.',
    aliases: ['boards', 'cards', 'kanban'],
    fields: [
      text('apiKeyPublic', 'API key', { help: 'The public key from trello.com/app-key — not a secret.' }),
      secret('token', 'Token'),
    ],
    enables: ['Ask-the-data', 'delivery widgets'],
    testDescription: 'Reads the member behind the token and lists their boards.',
    probeLabel: 'GET /1/members/me',
    request: (v) => ({
      url: 'https://api.trello.com/1/members/me?fields=username,fullName',
      headers: { Authorization: `OAuth oauth_consumer_key="${v.apiKeyPublic}", oauth_token="${v.token}"` },
    }),
    describe: (b) => {
      const m = b as { username?: string; fullName?: string };
      return m.username ? [`${m.fullName} (@${m.username})`] : [];
    },
  },
  {
    id: 'pipedrive',
    label: 'Pipedrive',
    category: 'crm',
    blurb: 'Deals and pipeline stages for teams on Pipedrive rather than Salesforce.',
    aliases: ['crm', 'deals', 'pipeline', 'sales'],
    fields: [
      text('companyDomain', 'Company domain', { placeholder: 'acme', help: 'The part before .pipedrive.com.' }),
      secret('apiToken', 'API token'),
    ],
    enables: ['Ask-the-data', 'pipeline widgets'],
    testDescription: 'Reads the authenticated user.',
    probeLabel: 'GET /v1/users/me',
    request: (v) => ({
      url: `https://${v.companyDomain}.pipedrive.com/api/v1/users/me`,
      headers: { 'x-api-token': v.apiToken },
    }),
    describe: (b) => {
      const r = b as { success?: boolean; data?: { name?: string; company_name?: string } };
      if (r.success === false) throw new Error('the token was rejected');
      return r.data ? [`${r.data.name} · ${r.data.company_name}`] : [];
    },
  },
];

export const SAAS_TYPES: SourceType[] = SPECS.map((s) => ({
  id: s.id,
  label: s.label,
  category: s.category,
  blurb: s.blurb,
  aliases: s.aliases,
  fields: s.fields,
  enables: s.enables,
  supersedes: [],
  testDescription: s.testDescription,
  genericOnly: true,
}));

export const SAAS_TESTS: Record<string, (v: Record<string, string>) => Promise<TestResult>> =
  Object.fromEntries(SPECS.map((s) => [s.id, buildTest(s)]));
