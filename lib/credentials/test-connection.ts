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
import { getSourceType, validate } from './source-types';
import { SAAS_TESTS } from './saas';
import type { TestResult } from './result';

export type { TestResult };

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

/**
 * GA4, through the Data API.
 *
 * This used to reuse `testSheets` with a note that it was "the same auth hop".
 * It is the same *token* exchange and nothing else: `testSheets` reads
 * `v.storeMasterId`, which a GA4 source does not have, so the probe fetched
 * `/spreadsheets/undefined` and the result described a spreadsheet nobody had
 * configured. A test that passes for the wrong reason is worse than none.
 *
 * The three failures here are genuinely different problems with different
 * owners, and the message says which: the API not being enabled is a console
 * click, the property not being shared is an Analytics admin task, and a bad
 * key is a credential rotation.
 */
async function testGa4(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  let email = '';
  const parsedOk = await step(steps, 'Service-account key parses', async () => {
    email = (JSON.parse(v.serviceAccountJson) as { client_email?: string }).client_email ?? '';
    if (!email) throw new Error('No client_email in the key');
    return email;
  });
  if (!parsedOk) return fail('The key could not be read as JSON.', steps);

  const ok = await step(steps, `runReport on property ${v.propertyId}`, async () => {
    const { getAccessToken } = await import('@/lib/gcp/auth');
    const token = await getAccessTokenWith(v.serviceAccountJson, getAccessToken, [
      'https://www.googleapis.com/auth/analytics.readonly',
    ]);
    const res = await fetchWithTimeout(
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(v.propertyId)}:runReport`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
          metrics: [{ name: 'sessions' }],
          limit: 1,
        }),
      },
    );
    const text = await res.text();
    if (res.status === 403 && text.includes('has not been used in project')) {
      throw new Error(
        'the Analytics Data API is not enabled on this service account\'s project — enable it in the Google Cloud console, then retry',
      );
    }
    if (res.status === 403) throw new Error(`${email} has no access to this property — add it as a Viewer in GA4 Admin`);
    if (res.status === 404) throw new Error(`no property ${v.propertyId} — check the numeric id, not the measurement id`);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 160)}`);

    const body = JSON.parse(text) as { rows?: Array<{ metricValues?: Array<{ value?: string }> }> };
    const sessions = body.rows?.[0]?.metricValues?.[0]?.value;
    findings.push(
      sessions
        ? `${Number(sessions).toLocaleString('en-IN')} sessions in the last 7 days`
        : 'The property is readable but reported no sessions in the last 7 days.',
    );
    // §13.1 — the API samples and the BigQuery export does not. Saying so here
    // stops the two being treated as interchangeable later.
    findings.push('The Data API samples; where it disagrees with the BigQuery export, the export wins.');
    return 'report returned';
  });

  return ok
    ? { ok: true, summary: `Property ${v.propertyId} readable.`, steps, findings }
    : fail('Could not read the property.', steps);
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

async function testMysql(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  const ok = await step(steps, 'Connect and SELECT 1', async () => {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({ uri: v.url, connectTimeout: 10_000 });
    try {
      await conn.query('select 1');
      const [ver] = await conn.query<never[]>('select version() as v');
      findings.push(`MySQL ${(ver as unknown as Array<{ v: string }>)[0].v}`);
      const [tbl] = await conn.query<never[]>(
        'select count(*) as n from information_schema.tables where table_schema = database()',
      );
      const n = (tbl as unknown as Array<{ n: number }>)[0].n;
      findings.push(n === 0 ? 'No tables in this database.' : `${n} tables visible.`);
      return 'connected';
    } finally {
      await conn.end();
    }
  });

  return ok
    ? { ok: true, summary: 'Database reachable.', steps, findings }
    : fail('Could not connect. Check the host, port, credentials and any IP allowlist.', steps);
}

/**
 * Snowflake, through the SQL API rather than a driver.
 *
 * `snowflake-sdk` is a large dependency for one `SELECT 1`, and the SQL API is
 * a plain HTTPS call once the JWT is signed — the same shape as the GCP auth
 * this codebase already does by hand.
 */
async function testSnowflake(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  // Snowflake wants the account and user upper-cased inside the JWT claims,
  // and the account without its region suffix for the `iss`/`sub` pair.
  const account = (v.account ?? '').split('.')[0].toUpperCase();
  const user = (v.username ?? '').toUpperCase();

  let jwt = '';
  const signedOk = await step(steps, 'Key-pair JWT signs', async () => {
    const { createPrivateKey, createPublicKey, createHash, createSign } = await import('node:crypto');
    const key = createPrivateKey(v.privateKey);
    const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const fingerprint = `SHA256:${createHash('sha256').update(der).digest('base64')}`;

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: `${account}.${user}.${fingerprint}`,
      sub: `${account}.${user}`,
      iat: now,
      exp: now + 300,
    };
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${b64(header)}.${b64(claims)}`;
    const sig = createSign('RSA-SHA256').update(body).sign(key).toString('base64url');
    jwt = `${body}.${sig}`;
    return fingerprint;
  });
  if (!signedOk) {
    return fail('The private key could not be read. It must be an unencrypted PKCS#8 PEM.', steps);
  }

  const host = `https://${v.account}.snowflakecomputing.com`;
  const ran = await step(steps, 'SELECT 1 through the SQL API', async () => {
    const res = await fetch(`${host}/api/v2/statements`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        statement: 'select current_version() as v, current_account() as a',
        timeout: 20,
        warehouse: v.warehouse,
        database: v.database,
        schema: v.schema || undefined,
        role: v.role || undefined,
      }),
    });
    if (res.status === 401) {
      // The most common real failure, and the least obvious: the key is fine,
      // it is just not the key registered against this user.
      throw new Error('rejected — is this key set on the user? ALTER USER … SET RSA_PUBLIC_KEY');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 160)}`);
    const body = (await res.json()) as { data?: string[][] };
    const row = body.data?.[0] ?? [];
    if (row.length) findings.push(`Snowflake ${row[0]} on account ${row[1]}`);
    return 'query returned';
  });

  return ran
    ? { ok: true, summary: `Connected to ${v.account}.`, steps, findings }
    : fail('Snowflake rejected the request. Check the account identifier, user and warehouse.', steps);
}

async function testSqlServer(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  const ok = await step(steps, 'Connect and SELECT @@VERSION', async () => {
    const mssql = (await import('mssql')).default;
    const pool = new mssql.ConnectionPool({
      server: v.server,
      database: v.database,
      user: v.username,
      password: v.password,
      port: v.port ? Number(v.port) : 1433,
      // Defaults to on: Azure SQL rejects an unencrypted connection, and the
      // resulting error names TLS rather than the setting that caused it.
      options: { encrypt: v.encrypt !== 'false', trustServerCertificate: v.encrypt === 'false' },
      connectionTimeout: 15_000,
      requestTimeout: 15_000,
    });
    try {
      await pool.connect();
      const ver = await pool.request().query<{ v: string }>('select @@VERSION as v');
      findings.push(ver.recordset[0].v.split('\n')[0]);
      const tbl = await pool
        .request()
        .query<{ n: number }>("select count(*) as n from information_schema.tables where table_type = 'BASE TABLE'");
      const n = tbl.recordset[0].n;
      findings.push(n === 0 ? 'No base tables in this database.' : `${n} tables visible.`);
      return 'connected';
    } finally {
      await pool.close();
    }
  });

  return ok
    ? { ok: true, summary: 'Database reachable.', steps, findings }
    : fail('Could not connect. Check the server, port, credentials and any firewall rule.', steps);
}

/** Follows a dotted path, so `data.items` reaches the array people actually have. */
function atPath(body: unknown, path: string): unknown {
  if (!path.trim()) return body;
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, body);
}

async function testRestApi(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  let body: unknown;
  const fetched = await step(steps, `GET ${new URL(v.baseUrl).host}`, async () => {
    const res = await fetchWithTimeout(v.baseUrl, {
      headers: {
        Accept: 'application/json',
        ...(v.authHeader ? { Authorization: v.authHeader } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`the response is not JSON — it starts "${text.slice(0, 60)}"`);
    }
    return `HTTP ${res.status}, ${text.length} bytes`;
  });
  if (!fetched) return fail('The endpoint did not return usable JSON.', steps);

  // Shape, not just reachability. A 200 with the rows at a different path is
  // exactly the silent failure this whole test layer exists to catch.
  const shaped = await step(steps, 'Rows found in the response', async () => {
    const rows = atPath(body, v.jsonPath ?? '');
    if (!Array.isArray(rows)) {
      const keys =
        body && typeof body === 'object' ? Object.keys(body as object).slice(0, 12).join(', ') : typeof body;
      throw new Error(
        v.jsonPath
          ? `nothing array-shaped at "${v.jsonPath}". Top-level keys: ${keys}`
          : `the body is not an array. Set a path to the rows — top-level keys: ${keys}`,
      );
    }
    const first = rows[0];
    if (first && typeof first === 'object') {
      findings.push(`Columns: ${Object.keys(first as object).slice(0, 15).join(' · ')}`);
    }
    return `${rows.length} rows`;
  });

  return shaped
    ? { ok: true, summary: 'Endpoint reachable and the rows were found.', steps, findings }
    : { ok: false, summary: 'The endpoint answered, but the rows are not where the path says.', steps, findings };
}

async function testCsvUrl(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];
  const delimiter = v.delimiter || ',';

  const ok = await step(steps, `Fetch the first rows of ${new URL(v.url).pathname.split('/').pop()}`, async () => {
    // Range first: a 500 MB export should not be downloaded to read a header.
    const res = await fetchWithTimeout(v.url, {
      headers: {
        Range: 'bytes=0-16383',
        ...(v.authHeader ? { Authorization: v.authHeader } : {}),
      },
    });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (res.status !== 206) findings.push('The server ignored the range request — the whole file would be read.');

    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error('the file is empty');

    const header = lines[0].split(delimiter);
    if (header.length === 1) {
      throw new Error(
        `no "${delimiter === '\t' ? 'tab' : delimiter}" in the header row — is the delimiter right? Row 1 reads "${lines[0].slice(0, 80)}"`,
      );
    }
    findings.push(`Columns: ${header.map((h) => h.trim().replace(/^"|"$/g, '')).slice(0, 15).join(' · ')}`);

    // Ragged rows are the thing that turns into a wrong number three screens
    // later, so they are reported here rather than discovered in a chart.
    const ragged = lines.slice(1, 50).filter((l) => l.split(delimiter).length !== header.length).length;
    if (ragged > 0) findings.push(`⚠ ${ragged} of the first 49 rows have a different column count.`);
    return `${header.length} columns, ${lines.length - 1}+ rows`;
  });

  return ok
    ? { ok: true, summary: 'File readable and parsed.', steps, findings }
    : fail('Could not read the file. Check the URL, any auth header, and the delimiter.', steps);
}

async function testGcs(v: Record<string, string>): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  const findings: string[] = [];

  let email = '';
  const parsedOk = await step(steps, 'Service-account key parses', async () => {
    email = (JSON.parse(v.serviceAccountJson) as { client_email?: string }).client_email ?? '';
    if (!email) throw new Error('No client_email in the key');
    return email;
  });
  if (!parsedOk) return fail('The key could not be read as JSON.', steps);

  const ok = await step(steps, `Objects under gs://${v.bucket}/${v.prefix ?? ''}`, async () => {
    const { getAccessToken } = await import('@/lib/gcp/auth');
    const token = await getAccessTokenWith(v.serviceAccountJson, getAccessToken, [
      'https://www.googleapis.com/auth/devstorage.read_only',
    ]);
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(v.bucket)}/o`);
    url.searchParams.set('maxResults', '10');
    if (v.prefix) url.searchParams.set('prefix', v.prefix);

    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403) throw new Error(`grant ${email} Storage Object Viewer on this bucket`);
    if (res.status === 404) throw new Error(`no bucket named "${v.bucket}" is visible to this account`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as { items?: Array<{ name: string; size?: string; updated?: string }> };
    const items = body.items ?? [];
    if (items.length === 0) {
      // Authenticated and empty is a real answer, not a failure — but it is
      // almost always a prefix typo, so say which.
      throw new Error(
        v.prefix
          ? `the bucket is readable but nothing matches the prefix "${v.prefix}"`
          : 'the bucket is readable but empty',
      );
    }
    const newest = items.reduce((a, b) => ((a.updated ?? '') > (b.updated ?? '') ? a : b));
    findings.push(`Newest: ${newest.name}${newest.updated ? ` (${newest.updated.slice(0, 10)})` : ''}`);
    findings.push(`Sample: ${items.slice(0, 5).map((i) => i.name).join(' · ')}`);
    return `${items.length}${items.length === 10 ? '+' : ''} objects`;
  });

  return ok
    ? { ok: true, summary: `Bucket readable.`, steps, findings }
    : fail(`Could not list the bucket. Grant ${email} Storage Object Viewer.`, steps);
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * A fetch that cannot hang.
 *
 * A "Test connection" button that spins forever is worse than one that fails:
 * it teaches people the feature is broken rather than that the host is wrong.
 */
async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, ms = 20_000): Promise<Response> {
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

/**
 * Every type in the catalogue must appear here.
 *
 * It did not, for a while: five types were offered in the picker with no test
 * and no connector behind them. They would accept a credential, save it, and do
 * nothing — the same false-configuration failure as a mart with no writer, and
 * the one thing this dashboard is supposed to make impossible. `credentials.test.ts`
 * now asserts this map covers `SOURCE_TYPES`, so the next type added cannot ship
 * half-built.
 */
export const TESTS: Record<string, (v: Record<string, string>) => Promise<TestResult>> = {
  bigquery: testBigQuery,
  postgres: testPostgres,
  'google-sheets': testSheets,
  slack: testSlack,
  sentry: testSentry,
  jira: testJira,
  ga4: testGa4,
  anthropic: testAnthropic,
  mysql: testMysql,
  snowflake: testSnowflake,
  sqlserver: testSqlServer,
  'rest-api': testRestApi,
  'csv-url': testCsvUrl,
  gcs: testGcs,
  // The SaaS families come from the same declaration that produced their source
  // types, so this half of the map cannot fall behind the catalogue.
  ...SAAS_TESTS,
};

export async function testConnection(
  typeId: string,
  values: Record<string, string>,
): Promise<TestResult> {
  const type = getSourceType(typeId);
  if (!type) return fail(`Unknown source type "${typeId}"`, []);
  const fn = TESTS[typeId];
  if (!fn) {
    // Unreachable if the coverage test passes. Kept as a loud failure rather
    // than a soft "saved untested", because saving a credential nothing reads
    // is the failure, not a degraded mode of it.
    return fail(
      `${type.label} is listed but has no connection test — that is a bug in this build, not in your credential.`,
      [],
    );
  }
  // Shape first: a typo should cost no round trip and no rate-limit budget.
  const shape = validate(type, values);
  if (!shape.ok) {
    return {
      ok: false,
      summary: shape.errors.map((e) => e.message).join('; '),
      steps: shape.errors.map((e) => ({
        label: type.fields.find((f) => f.key === e.field)?.label ?? e.field,
        ok: false,
        detail: e.message,
      })),
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
