/**
 * Connection doctor — live preflight for every connector.
 *
 * This is what turns "the connectors are implemented" into "the connectors are
 * working". It does not inspect config and infer; it attempts the real call and
 * reports what actually happened, because the two silent failures this system
 * has already produced both looked healthy from the config side.
 *
 * Each check reports one of:
 *   ok        — a real request succeeded, with evidence (row count, dataset name)
 *   blocked   — a named credential or setting is missing; says which env var
 *   failed    — the credential is present but the call failed; says why
 *   skipped   — the module is deliberately off
 *
 * Run it with `npm run doctor`, or open /connectors/setup.
 */
import { config } from '@/lib/config';
import { isGcpConfigured, getAccessToken, serviceAccountKey } from '@/lib/gcp/auth';
import { describeTable, listDatasets, runQuery } from '@/lib/gcp/bigquery';
import { discoverGa4Dataset } from './bq-ga4-events';
import { CONNECTORS } from './registry';

export type CheckStatus = 'ok' | 'blocked' | 'failed' | 'skipped';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  /** What actually happened — a row count, a dataset name, an error. */
  detail: string;
  /** The env var(s) that would unblock this, when blocked. */
  needs?: string[];
  /** What to do next, in one line. */
  nextStep?: string;
  /** Which §13 item or open assumption this closes. */
  closes?: string;
  elapsedMs?: number;
}

async function timed(id: string, label: string, fn: () => Promise<Check>): Promise<Check> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, elapsedMs: Date.now() - t0 };
  } catch (e) {
    return {
      id,
      label,
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - t0,
    };
  }
}

/* ── GCP / BigQuery ──────────────────────────────────────────────────────── */

async function checkGcpAuth(): Promise<Check> {
  return timed('gcp-auth', 'GCP service account', async () => {
    if (!config.gcpSaKeyJson) {
      return {
        id: 'gcp-auth',
        label: 'GCP service account',
        status: 'blocked',
        detail: 'GCP_SA_KEY_JSON is not set',
        needs: ['GCP_SA_KEY_JSON'],
        nextStep:
          'Base64-encode the service account key JSON and set it. Needs BigQuery Data Viewer + Job User on sng-prod, Logging Viewer, GA4 property read, and Sheets read.',
        closes: '§13.2',
      };
    }
    const key = serviceAccountKey();
    if (!key) {
      return {
        id: 'gcp-auth',
        label: 'GCP service account',
        status: 'failed',
        detail: 'GCP_SA_KEY_JSON is set but could not be parsed as a service account key',
        nextStep: 'Check it is the full JSON key (raw or base64), with client_email and private_key.',
      };
    }
    // Exchange the JWT for a real token — the only way to know the key works.
    await getAccessToken();
    return {
      id: 'gcp-auth',
      label: 'GCP service account',
      status: 'ok',
      detail: `Token issued for ${key.client_email}`,
      closes: '§13.2',
    };
  });
}

async function checkBqOrders(): Promise<Check> {
  return timed('bq-orders', 'BigQuery — avis_base_view', async () => {
    if (!isGcpConfigured()) {
      return {
        id: 'bq-orders',
        label: 'BigQuery — avis_base_view',
        status: 'blocked',
        detail: 'Needs the GCP service account',
        needs: ['GCP_SA_KEY_JSON'],
      };
    }
    // A1 — introspect before mapping. This is the mandatory first step of
    // Phase 2, and doing it here means it happens the moment access lands.
    const [project, dataset, table] = config.bqOrdersTable.split('.');
    const cols = await describeTable(dataset, table, project);
    if (cols.length === 0) {
      return {
        id: 'bq-orders',
        label: 'BigQuery — avis_base_view',
        status: 'failed',
        detail: `No columns returned for ${config.bqOrdersTable} — the table may not exist or the SA lacks access`,
      };
    }
    const names = cols.map((c) => c.column_name);
    const has = (n: string) => names.includes(n);
    const missing = ['state_date', 'affiliate_id'].filter((n) => !has(n));
    return {
      id: 'bq-orders',
      label: 'BigQuery — avis_base_view',
      status: missing.length ? 'failed' : 'ok',
      detail: missing.length
        ? `Expected columns absent: ${missing.join(', ')}. Found: ${names.slice(0, 12).join(', ')}…`
        : `${cols.length} columns. Commit them to docs/source/AVIS_BASE_VIEW_SCHEMA.md and fill the §15.3 mapping.`,
      closes: 'A1 (avis_base_view column names)',
    };
  });
}

async function checkGa4Export(): Promise<Check> {
  return timed('bq-ga4-events', 'GA4 → BigQuery export', async () => {
    if (!isGcpConfigured()) {
      return {
        id: 'bq-ga4-events',
        label: 'GA4 → BigQuery export',
        status: 'blocked',
        detail: 'Needs the GCP service account',
        needs: ['GCP_SA_KEY_JSON'],
      };
    }
    if (config.bqGa4Project && config.bqGa4Dataset) {
      const n = await runQuery<{ n: number }>({
        query: `SELECT COUNT(*) AS n FROM \`${config.bqGa4Project}.${config.bqGa4Dataset}.INFORMATION_SCHEMA.TABLES\``,
        connector: 'doctor',
      });
      return {
        id: 'bq-ga4-events',
        label: 'GA4 → BigQuery export',
        status: 'ok',
        detail: `${config.bqGa4Project}.${config.bqGa4Dataset} — ${n.rows[0]?.n ?? 0} tables`,
        closes: 'A4 (GA4 → BQ dataset name)',
      };
    }
    // A4 — the highest-leverage unblock in the build, and it does not need
    // anyone's permission once BigQuery access exists.
    const found = await discoverGa4Dataset([config.gcpProjectId, 'fynd-jio-impetus-prod']);
    if (found) {
      return {
        id: 'bq-ga4-events',
        label: 'GA4 → BigQuery export',
        status: 'blocked',
        detail: `Discovered a candidate: ${found.project}.${found.dataset}`,
        needs: ['BQ_GA4_PROJECT', 'BQ_GA4_DATASET'],
        nextStep: `Set BQ_GA4_PROJECT=${found.project} and BQ_GA4_DATASET=${found.dataset}, then re-run.`,
        closes: 'A4',
      };
    }
    return {
      id: 'bq-ga4-events',
      label: 'GA4 → BigQuery export',
      status: 'blocked',
      detail: 'No analytics_* dataset found in the candidate projects',
      needs: ['BQ_GA4_PROJECT', 'BQ_GA4_DATASET'],
      nextStep:
        'Get the destination from GA4 Admin → Product links → BigQuery links for property ' +
        `${config.ga4PropertyId}. See docs/EXTRACTION-PROMPTS.md §A.7.`,
      closes: 'A4 — blocks the whole journey module',
    };
  });
}

/**
 * A5 / §13.11 — the seven scan-event params were confirmed in *pre-production*.
 * A parameter that fires in pre-prod but arrives empty in production is the most
 * expensive failure mode available here, because the funnel renders plausible
 * numbers on a broken dimension.
 */
async function checkScanParams(): Promise<Check> {
  return timed('scan-params', 'Scan-event parameter fill rates', async () => {
    if (!isGcpConfigured() || !config.bqGa4Dataset) {
      return {
        id: 'scan-params',
        label: 'Scan-event parameter fill rates',
        status: 'blocked',
        detail: 'Needs the GA4 export to be located first',
        needs: ['BQ_GA4_PROJECT', 'BQ_GA4_DATASET'],
        closes: 'A5',
      };
    }
    const { PARAM_FILL_SQL } = await import('./bq-ga4-events');
    const res = await runQuery<Record<string, number>>({
      query: PARAM_FILL_SQL(),
      params: { suffix_start: '20260801', suffix_end: '20260812' },
      types: { suffix_start: 'STRING', suffix_end: 'STRING' },
      connector: 'doctor',
    });
    const row = res.rows[0];
    if (!row || !row.scan_events) {
      return {
        id: 'scan-params',
        label: 'Scan-event parameter fill rates',
        status: 'failed',
        detail: 'No scan events found in the window — the `result` param may not be firing in production',
        closes: 'A5',
      };
    }
    const pct = (v: number) => `${((v ?? 0) * 100).toFixed(1)}%`;
    // store_id is the one to watch: everything store-level collapses without it.
    const storeFill = row.store_fill ?? 0;
    return {
      id: 'scan-params',
      label: 'Scan-event parameter fill rates',
      status: storeFill < 0.9 ? 'failed' : 'ok',
      detail: `store_id ${pct(row.store_fill)} · ean ${pct(row.ean_fill)} · result ${pct(row.result_fill)} · sales_channel ${pct(row.channel_fill)} (${row.scan_events} events)`,
      nextStep:
        storeFill < 0.9
          ? 'store_id fill is below 90% — every store- and state-level number is unreliable until this is fixed at the source.'
          : undefined,
      closes: 'A5 (production param verification)',
    };
  });
}

/* ── Postgres ────────────────────────────────────────────────────────────── */

async function checkPostgres(): Promise<Check> {
  return timed('postgres', 'Postgres serving marts', async () => {
    if (!config.databaseUrl) {
      return {
        id: 'postgres',
        label: 'Postgres serving marts',
        status: 'blocked',
        detail: 'DATABASE_URL is not set — the dashboard is serving fixtures and an in-memory run log',
        needs: ['DATABASE_URL'],
        nextStep: 'Provision Postgres (Neon / Supabase / Vercel Postgres), set DATABASE_URL, then `npm run db:push`.',
      };
    }
    const { getDb } = await import('@/lib/db/client');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) {
      return { id: 'postgres', label: 'Postgres serving marts', status: 'failed', detail: 'Could not construct a client' };
    }
    const tables = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = (tables as unknown as Array<{ table_name: string }>).map((r) => r.table_name);
    const expected = ['dim_store', 'fact_orders', 'fact_scan_daily', 'fact_catalogue_daily', 'etl_run_log'];
    const missing = expected.filter((t) => !names.includes(t));
    return {
      id: 'postgres',
      label: 'Postgres serving marts',
      status: missing.length ? 'failed' : 'ok',
      detail: missing.length
        ? `Connected, but the §7 schema is not applied. Missing: ${missing.join(', ')}`
        : `Connected — ${names.length} tables present`,
      nextStep: missing.length ? 'Run `npm run db:push` to apply the §7 schema.' : undefined,
    };
  });
}

async function checkReadonlyRole(): Promise<Check> {
  return timed('postgres-readonly', 'Read-only role for /api/ask', async () => {
    if (!process.env.DATABASE_URL_READONLY) {
      return {
        id: 'postgres-readonly',
        label: 'Read-only role for /api/ask',
        status: 'blocked',
        detail: 'DATABASE_URL_READONLY is not set — generated SQL will preview but never execute',
        needs: ['DATABASE_URL_READONLY'],
        nextStep: 'Create the dashboard_readonly role (see docs/DEPLOY.md) — it is the real security boundary, not the regex guard.',
      };
    }
    const { getReadonlySql } = await import('@/lib/db/client');
    const sql = getReadonlySql();
    if (!sql) return { id: 'postgres-readonly', label: 'Read-only role for /api/ask', status: 'failed', detail: 'Could not construct a client' };
    await sql`SELECT 1`;
    // Verify it is genuinely read-only rather than trusting the name.
    let writable = false;
    try {
      await sql.unsafe('CREATE TEMP TABLE doctor_write_probe (x int)');
      writable = true;
    } catch {
      writable = false;
    }
    return {
      id: 'postgres-readonly',
      label: 'Read-only role for /api/ask',
      status: writable ? 'failed' : 'ok',
      detail: writable
        ? 'This role can CREATE. It is not read-only — generated SQL must never run on it.'
        : 'Connected and verified read-only (write probe rejected)',
    };
  });
}

/* ── Token-based connectors ──────────────────────────────────────────────── */

async function checkSlack(): Promise<Check> {
  return timed('slack', 'Slack bot token', async () => {
    if (!config.slackBotToken) {
      return {
        id: 'slack',
        label: 'Slack bot token',
        status: 'blocked',
        detail: 'SLACK_BOT_TOKEN is not set',
        needs: ['SLACK_BOT_TOKEN'],
        nextStep: 'Needs channels:history on #sng-catalogue-lack (C0AV6FU1YUU) and chat:write for alerts.',
        closes: '§13.6',
      };
    }
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${config.slackBotToken}` },
    });
    const body = (await res.json()) as { ok: boolean; error?: string; team?: string; user?: string };
    return {
      id: 'slack',
      label: 'Slack bot token',
      status: body.ok ? 'ok' : 'failed',
      detail: body.ok ? `Authenticated as ${body.user} in ${body.team}` : `Slack said: ${body.error}`,
      closes: '§13.6',
    };
  });
}

async function checkSentry(): Promise<Check> {
  return timed('sentry', 'Sentry auth token', async () => {
    if (!config.sentryAuthToken) {
      return {
        id: 'sentry',
        label: 'Sentry auth token',
        status: 'blocked',
        detail: 'SENTRY_AUTH_TOKEN is not set',
        needs: ['SENTRY_AUTH_TOKEN'],
        nextStep: 'Scopes: org:read, project:read, event:read on org fynd-f7.',
        closes: '§13.6',
      };
    }
    const res = await fetch(`https://${config.sentryOrg}.sentry.io/api/0/organizations/${config.sentryOrg}/projects/`, {
      headers: { Authorization: `Bearer ${config.sentryAuthToken}` },
    });
    if (!res.ok) {
      return { id: 'sentry', label: 'Sentry auth token', status: 'failed', detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }
    const projects = (await res.json()) as Array<{ slug: string }>;
    return {
      id: 'sentry',
      label: 'Sentry auth token',
      status: 'ok',
      detail: `${projects.length} projects: ${projects.slice(0, 6).map((p) => p.slug).join(', ')}`,
      nextStep: projects.length ? `Set SENTRY_PROJECTS to the Companion project ids.` : undefined,
      closes: '§13.6',
    };
  });
}

async function checkJira(): Promise<Check> {
  return timed('jira', 'Jira API token', async () => {
    if (!config.jiraEmail || !config.jiraApiToken) {
      return {
        id: 'jira',
        label: 'Jira API token',
        status: 'blocked',
        detail: 'JIRA_EMAIL / JIRA_API_TOKEN not set',
        needs: ['JIRA_EMAIL', 'JIRA_API_TOKEN'],
        closes: '§13.6',
      };
    }
    const auth = Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64');
    const res = await fetch(`${config.jiraBaseUrl}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { id: 'jira', label: 'Jira API token', status: 'failed', detail: `HTTP ${res.status}` };
    }
    const me = (await res.json()) as { displayName?: string };
    // A11 — profile the board so the right component filter is chosen from
    // data rather than memory.
    let discriminators = '';
    try {
      const { jira } = await import('./jira');
      const d = await jira.profileDiscriminators();
      discriminators = ` · components: ${d.components.slice(0, 8).join(', ') || 'none'}`;
    } catch {
      discriminators = '';
    }
    return {
      id: 'jira',
      label: 'Jira API token',
      status: 'ok',
      detail: `Authenticated as ${me.displayName}${discriminators}`,
      nextStep: 'Set JIRA_COMPONENT_FILTER from the components above, or the P0 count inherits other products (A11).',
      closes: '§13.6, A11',
    };
  });
}

async function checkSheets(): Promise<Check> {
  return timed('sheets', 'Google Sheets — store master', async () => {
    if (!isGcpConfigured()) {
      return {
        id: 'sheets',
        label: 'Google Sheets — store master',
        status: 'blocked',
        detail: 'Needs the GCP service account, or a local CSV at docs/source/store_master.csv',
        needs: ['GCP_SA_KEY_JSON'],
        closes: '§13.3',
      };
    }
    const token = await getAccessToken();
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetStoreMasterId}?fields=sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      return {
        id: 'sheets',
        label: 'Google Sheets — store master',
        status: 'failed',
        detail: `HTTP ${res.status} — share the sheet with the service account address`,
      };
    }
    const body = (await res.json()) as { sheets?: Array<{ properties: { title: string } }> };
    const tabs = (body.sheets ?? []).map((s) => s.properties.title);
    return {
      id: 'sheets',
      label: 'Google Sheets — store master',
      status: 'ok',
      detail: `Readable. Tabs: ${tabs.join(', ')}`,
      closes: '§13.3',
    };
  });
}

async function checkAnthropic(): Promise<Check> {
  return timed('anthropic', 'Anthropic API key', async () => {
    if (!config.anthropicApiKey) {
      return {
        id: 'anthropic',
        label: 'Anthropic API key',
        status: 'blocked',
        detail: 'ANTHROPIC_API_KEY is not set — the brief falls back to the deterministic summary',
        needs: ['ANTHROPIC_API_KEY'],
        nextStep: 'The anomaly detector and RCA rules work without it; only the written narrative needs it.',
      };
    }
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' },
    });
    return {
      id: 'anthropic',
      label: 'Anthropic API key',
      status: res.ok ? 'ok' : 'failed',
      detail: res.ok ? `Authenticated · model ${config.aiModel}` : `HTTP ${res.status}`,
    };
  });
}

/* ── Loyalty (scope extension — see ADR-001) ─────────────────────────────── */

async function checkLoyalty(): Promise<Check> {
  return timed('bq-loyalty', 'Loyalty — fynd-jio-impetus-prod', async () => {
    if (!config.moduleLoyalty) {
      return {
        id: 'bq-loyalty',
        label: 'Loyalty — fynd-jio-impetus-prod',
        status: 'skipped',
        detail: 'MODULE_LOYALTY is off (§0 default). Set MODULE_LOYALTY=true to enable — see ADR-001.',
      };
    }
    if (!isGcpConfigured()) {
      return {
        id: 'bq-loyalty',
        label: 'Loyalty — fynd-jio-impetus-prod',
        status: 'blocked',
        detail: 'Needs a service account with read access to fynd-jio-impetus-prod',
        needs: ['GCP_SA_KEY_JSON', 'BQ_LOYALTY_PROJECT', 'BQ_LOYALTY_DATASET'],
        nextStep:
          'The Companion SA may not have access to the Loyalty project — it is a different GCP project and likely needs a separate grant.',
      };
    }
    const project = process.env.BQ_LOYALTY_PROJECT || 'fynd-jio-impetus-prod';
    const datasets = await listDatasets(project);
    const analytics = datasets.filter((d) => d.startsWith('analytics_'));
    return {
      id: 'bq-loyalty',
      label: 'Loyalty — fynd-jio-impetus-prod',
      status: analytics.length ? 'ok' : 'failed',
      detail: analytics.length
        ? `${project} readable — ${analytics.join(', ')}`
        : `${project} readable but no analytics_* dataset found (${datasets.length} datasets)`,
      nextStep: analytics.length ? `Set BQ_LOYALTY_DATASET=${analytics[0]}` : undefined,
    };
  });
}

/* ── Runner ──────────────────────────────────────────────────────────────── */

export interface DoctorReport {
  generatedAt: string;
  checks: Check[];
  summary: { ok: number; blocked: number; failed: number; skipped: number };
  /** Env vars that would unblock the most, most-blocking first. */
  unblockOrder: Array<{ envVar: string; unblocks: string[] }>;
  connectorsConfigured: number;
  connectorsTotal: number;
}

export async function runDoctor(): Promise<DoctorReport> {
  // Sequential: several checks share the same GCP token and quota bucket, and a
  // burst of parallel auth attempts is exactly what rate limits punish.
  const checks: Check[] = [];
  for (const fn of [
    checkGcpAuth,
    checkBqOrders,
    checkGa4Export,
    checkScanParams,
    checkPostgres,
    checkReadonlyRole,
    checkSheets,
    checkSlack,
    checkSentry,
    checkJira,
    checkAnthropic,
    checkLoyalty,
  ]) {
    checks.push(await fn());
  }

  const summary = { ok: 0, blocked: 0, failed: 0, skipped: 0 };
  for (const c of checks) summary[c.status]++;

  // Rank env vars by how many checks each would unblock.
  const byVar = new Map<string, string[]>();
  for (const c of checks) {
    if (c.status !== 'blocked') continue;
    for (const v of c.needs ?? []) {
      byVar.set(v, [...(byVar.get(v) ?? []), c.label]);
    }
  }
  const unblockOrder = [...byVar.entries()]
    .map(([envVar, unblocks]) => ({ envVar, unblocks }))
    .sort((a, b) => b.unblocks.length - a.unblocks.length);

  return {
    generatedAt: new Date().toISOString(),
    checks,
    summary,
    unblockOrder,
    connectorsConfigured: CONNECTORS.filter((c) => c.isConfigured()).length,
    connectorsTotal: CONNECTORS.length,
  };
}
