/**
 * "Test connection" — the button that makes this a dashboard rather than a form.
 *
 * Every test attempts the **real call**, never a config inspection. Both silent
 * failures this system has already produced looked perfectly healthy from the
 * config side: `avis_base_view` had valid credentials and stale data, and the
 * catalogue parser had a valid token and a format that did not exist.
 *
 * Each result names the hop that failed. "Connector down" sends someone hunting
 * for an afternoon; "the key parsed, the token exchanged, the dataset is not
 * visible to this service account" is a five-minute fix.
 */
import { getSourceType } from './source-types';

export interface TestResult {
  ok: boolean;
  /** One line, in the words the UI will show. */
  summary: string;
  /** Each hop attempted, in order, so a failure is located rather than guessed. */
  steps: Array<{ label: string; ok: boolean; detail: string }>;
  /** Anything worth knowing that is not a pass/fail — discovered names, counts. */
  findings?: string[];
}

const fail = (summary: string, steps: TestResult['steps']): TestResult => ({ ok: false, summary, steps });

async function step(
  steps: TestResult['steps'],
  label: string,
  fn: () => Promise<string>,
): Promise<boolean> {
  try {
    steps.push({ label, ok: true, detail: await fn() });
    return true;
  } catch (e) {
    steps.push({ label, ok: false, detail: e instanceof Error ? e.message.slice(0, 240) : String(e) });
    return false;
  }
}

/* ── per-type tests ──────────────────────────────────────────────────────── */

async function testBigQuery(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  let parsed: { client_email?: string; project_id?: string } = {};
  const parsedOk = await step(steps, 'Service-account key parses', async () => {
    parsed = JSON.parse(v.serviceAccountJson);
    if (!parsed.client_email) throw new Error('No client_email in the key');
    return parsed.client_email;
  });
  if (!parsedOk) return fail('The key could not be read as JSON.', steps);

  const { getAccessToken } = await import('@/lib/gcp/auth');
  const tokenOk = await step(steps, 'Token exchange with Google', async () => {
    const t = await getAccessTokenWith(v.serviceAccountJson, getAccessToken);
    return `granted, ${t.length} chars`;
  });
  if (!tokenOk) {
    return fail('Google rejected the key. It may be revoked, or the clock may be skewed.', steps);
  }

  const project = v.projectId || parsed.project_id || '';
  const listed = await step(steps, `Datasets visible in ${project}`, async () => {
    const { listDatasets } = await import('@/lib/gcp/bigquery');
    const ds = await withEnv({ GCP_SA_KEY_JSON: v.serviceAccountJson, GCP_PROJECT_ID: project }, () =>
      listDatasets(project),
    );
    if (ds.length === 0) throw new Error('No datasets — the account authenticated but can see nothing');
    findings.push(`${ds.length} datasets: ${ds.slice(0, 8).join(', ')}${ds.length > 8 ? '…' : ''}`);
    const ga4 = ds.find((d) => d.startsWith('analytics_'));
    if (ga4) findings.push(`GA4 export found: ${ga4} — this settles §13.1`);
    else findings.push('No analytics_* dataset here. The GA4 export may be in another project.');
    return `${ds.length} datasets`;
  });

  return listed
    ? { ok: true, summary: `Connected to ${project}.`, steps, findings }
    : fail(`Authenticated, but ${project} is not readable by ${parsed.client_email}.`, steps);
}

async function testPostgres(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  const ok = await step(steps, 'Connect and SELECT 1', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(v.url, { max: 1, connect_timeout: 10, idle_timeout: 5 });
    try {
      await sql`select 1`;
      const [{ version }] = await sql<{ version: string }[]>`select version()`;
      findings.push(version.split(',')[0]);
      const tables = await sql<{ n: string }[]>`
        select count(*)::text as n from information_schema.tables where table_schema = 'public'`;
      findings.push(
        Number(tables[0].n) === 0
          ? 'No tables yet — run `npm run db:push` to create the marts.'
          : `${tables[0].n} tables in the public schema.`,
      );
      return 'connected';
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  if (ok && v.readonlyUrl) {
    // A "read-only" URL that can write is the dangerous case: it looks like a
    // guard and is not one. §28.9 leans on this being real.
    await step(steps, 'Read-only role really is read-only', async () => {
      const postgres = (await import('postgres')).default;
      const sql = postgres(v.readonlyUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 });
      try {
        await sql`select 1`;
        try {
          await sql`create table if not exists __rw_probe__ (x int)`;
          await sql`drop table if exists __rw_probe__`;
          return 'WARNING: this role can create tables — it is not read-only';
        } catch {
          return 'confirmed: writes are rejected';
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  }

  return ok
    ? { ok: true, summary: 'Database reachable.', steps, findings }
    : fail('Could not connect. Check the host, port, credentials and any IP allowlist.', steps);
}

async function testSlack(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  let team = '';
  const authOk = await step(steps, 'auth.test', async () => {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${v.botToken}` },
    });
    const body = (await res.json()) as { ok: boolean; error?: string; team?: string; user?: string };
    if (!body.ok) throw new Error(body.error ?? 'rejected');
    team = body.team ?? '';
    return `${body.user} in ${body.team}`;
  });
  if (!authOk) return fail('Slack rejected the token.', steps);

  for (const [label, id] of [
    ['Catalogue report channel', v.catalogueChannel],
    ['Alerts channel', v.alertsChannel],
    ['NOC channel', v.nocChannel],
  ] as const) {
    if (!id) continue;
    await step(steps, `${label} readable`, async () => {
      const res = await fetch(`https://slack.com/api/conversations.history?channel=${id}&limit=1`, {
        headers: { Authorization: `Bearer ${v.botToken}` },
      });
      const body = (await res.json()) as { ok: boolean; error?: string; messages?: unknown[] };
      if (!body.ok) {
        throw new Error(
          body.error === 'not_in_channel'
            ? 'the bot is not in this channel — invite it'
            : body.error === 'missing_scope'
              ? 'the token lacks channels:history'
              : (body.error ?? 'failed'),
        );
      }
      const n = body.messages?.length ?? 0;
      if (n === 0) findings.push(`${label} is readable but empty in the window checked.`);
      return `${n} message read`;
    });
  }

  const failed = steps.filter((s) => !s.ok);
  return failed.length === 0
    ? { ok: true, summary: `Connected to ${team}.`, steps, findings }
    : { ok: false, summary: `Token works, but ${failed.length} channel(s) are not readable.`, steps, findings };
}

async function testSentry(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];
  const ok = await step(steps, `Projects in ${v.org}`, async () => {
    const res = await fetch(`https://sentry.io/api/0/organizations/${v.org}/projects/`, {
      headers: { Authorization: `Bearer ${v.authToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as Array<{ slug: string }>;
    const slugs = list.map((p) => p.slug);
    findings.push(`${slugs.length} projects: ${slugs.slice(0, 10).join(', ')}`);
    for (const want of (v.projects ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!slugs.includes(want)) findings.push(`⚠ "${want}" is not a project in this org`);
    }
    return `${slugs.length} projects`;
  });
  return ok
    ? { ok: true, summary: `Connected to ${v.org}.`, steps, findings }
    : fail('Sentry rejected the token, or the organisation slug is wrong.', steps);
}

async function testJira(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];
  const auth = Buffer.from(`${v.email}:${v.apiToken}`).toString('base64');
  const ok = await step(steps, 'JQL search', async () => {
    const jql = v.projectKey ? `project = ${v.projectKey}` : 'order by created DESC';
    const res = await fetch(`${v.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=1`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { total?: number };
    findings.push(`${body.total ?? 0} issues match ${jql}`);
    if (!v.componentFilter) {
      findings.push('No component filter set — A11: the board is shared, so the P0 count will be wrong.');
    }
    return `${body.total ?? 0} issues`;
  });
  return ok
    ? { ok: true, summary: 'Jira reachable.', steps, findings }
    : fail('Jira rejected the credentials, or the base URL is wrong.', steps);
}

async function testSheets(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];
  let email = '';
  const parsedOk = await step(steps, 'Service-account key parses', async () => {
    email = (JSON.parse(v.serviceAccountJson) as { client_email?: string }).client_email ?? '';
    if (!email) throw new Error('No client_email in the key');
    return email;
  });
  if (!parsedOk) return fail('The key could not be read as JSON.', steps);

  const ok = await step(steps, 'Read row 1 of the store master', async () => {
    const { getAccessToken } = await import('@/lib/gcp/auth');
    const token = await getAccessTokenWith(v.serviceAccountJson, getAccessToken, [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ]);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${v.storeMasterId}/values/1:1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 403) throw new Error(`shared? grant Viewer to ${email}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { values?: string[][] };
    const header = body.values?.[0] ?? [];
    if (header.length === 0) throw new Error('Row 1 is empty — is this the right tab?');
    findings.push(`Columns: ${header.join(' · ')}`);
    return `${header.length} columns`;
  });

  return ok
    ? { ok: true, summary: 'Sheet readable.', steps, findings }
    : fail(`Could not read the sheet. Share it with ${email} as Viewer.`, steps);
}

async function testAnthropic(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const ok = await step(steps, 'One-token completion', async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': v.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: v.model || 'claude-sonnet-4-6',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return 'accepted';
  });
  return ok ? { ok: true, summary: 'Anthropic reachable.', steps } : fail('The API key was rejected.', steps);
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Runs a function with temporary env, then restores it.
 *
 * The GCP helpers read `GCP_SA_KEY_JSON` from the environment. Testing an
 * unsaved credential means making it visible for exactly the length of the
 * call — never longer, and always restored, including on throw.
 */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, val] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = val;
  }
  try {
    return await fn();
  } finally {
    for (const [k, val] of Object.entries(prev)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
}

async function getAccessTokenWith(
  saJson: string,
  getToken: (scopes?: string[]) => Promise<string>,
  scopes?: string[],
): Promise<string> {
  return withEnv({ GCP_SA_KEY_JSON: saJson }, () => getToken(scopes));
}

const TESTS: Record<string, (v: Record<string, string>) => Promise<TestResult>> = {
  bigquery: testBigQuery,
  postgres: testPostgres,
  'google-sheets': testSheets,
  slack: testSlack,
  sentry: testSentry,
  jira: testJira,
  ga4: testSheets, // same auth hop; the property check needs the Data API scope
  anthropic: testAnthropic,
};

export async function testConnection(
  typeId: string,
  values: Record<string, string>,
): Promise<TestResult> {
  const type = getSourceType(typeId);
  if (!type) return fail(`Unknown source type "${typeId}"`, []);
  const fn = TESTS[typeId];
  if (!fn) {
    return {
      ok: false,
      summary: `No connection test is implemented for ${type.label} yet — it will be saved untested.`,
      steps: [],
    };
  }
  try {
    return await fn(values);
  } catch (e) {
    // A test must never throw to the UI. A thrown test is indistinguishable
    // from a failed connection, and the difference matters.
    return fail(
      `The test itself failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
      [],
    );
  }
}
