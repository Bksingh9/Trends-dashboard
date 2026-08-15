/**
 * The data-source catalogue — what "Add a data source" offers.
 *
 * Every dashboard worth using lets someone add a source from the UI: pick a
 * type, fill a form, press Test, save. Until now this build required editing
 * `.env` and redeploying, which is an engineer's workflow, not a product's —
 * and it meant a NOC lead who had just been handed a Slack token could do
 * nothing with it without a developer.
 *
 * Each type declares its fields so the form, the validation, the masking and
 * the connection test are all generated from one description. A type whose
 * form is hand-written drifts from its test; the two are the same data here.
 */

import { SAAS_TYPES } from './saas';

export type FieldKind = 'text' | 'password' | 'textarea' | 'select' | 'boolean';

export interface SourceField {
  key: string;
  label: string;
  kind: FieldKind;
  /** Secrets are encrypted at rest and never sent back to the browser. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  /** One line under the input. Say what it is *for*, not what it is called. */
  help?: string;
  options?: Array<{ value: string; label: string }>;
  /**
   * Rejected before any network call, so a typo costs no round trip.
   *
   * A string rather than a `RegExp`, because these descriptors cross the
   * server→client boundary to build the form, and React can only pass plain
   * objects — a RegExp threw "Only plain objects can be passed to Client
   * Components" and took the page to a 500.
   */
  pattern?: string;
  patternHint?: string;
}

export interface SourceType {
  id: string;
  label: string;
  /** Grouping in the picker. */
  category:
    | 'warehouse'
    | 'database'
    | 'spreadsheet'
    | 'messaging'
    | 'observability'
    | 'analytics'
    | 'file'
    | 'commerce'
    | 'crm'
    | 'ads'
    | 'generic';
  blurb: string;
  fields: SourceField[];
  /** Connector ids this configures. Drives "what will this turn on". */
  enables: string[];
  /**
   * The env vars this replaces. A source configured here takes precedence, and
   * the UI says so rather than leaving two sources of truth silently disagreeing.
   */
  supersedes: string[];
  /** What a successful test proves, in the words the result will use. */
  testDescription: string;
  /**
   * Extra search terms. Somebody looking for "Excel" should find Sheets, and
   * "Postgres" should find PostgreSQL — a picker that only matches the exact
   * product name is a picker people give up on.
   */
  aliases?: string[];
  /**
   * True when this source only feeds ad-hoc exploration, not a §5 metric. The
   * UI says so, because a source that cannot move a KPI is a different promise
   * from one that can.
   */
  genericOnly?: boolean;
}

const SA_JSON: SourceField = {
  key: 'serviceAccountJson',
  label: 'Service account JSON',
  kind: 'textarea',
  secret: true,
  required: true,
  placeholder: '{ "type": "service_account", "project_id": "…", "private_key": "…" }',
  help: 'Paste the whole key file. It is encrypted before it touches the database and is never shown again.',
  pattern: '"private_key"',
  patternHint: 'That does not look like a service-account key — it has no private_key field.',
};

export const SOURCE_TYPES: SourceType[] = [
  {
    id: 'bigquery',
    label: 'Google BigQuery',
    category: 'warehouse',
    blurb: 'Orders, GA4 events and the catalogue master. The system of record for most of this dashboard.',
    fields: [
      SA_JSON,
      {
        key: 'projectId',
        label: 'Project',
        kind: 'text',
        required: true,
        placeholder: 'sng-prod',
        help: 'Companion’s own project. The catalogue lives in a different one — add that separately.',
      },
      {
        key: 'ga4Dataset',
        label: 'GA4 export dataset',
        kind: 'text',
        placeholder: 'analytics_524294430',
        help: 'Leave blank to auto-discover. §13.1 — this one string unblocks the funnel and coverage.',
      },
      {
        key: 'maxBytesBilled',
        label: 'Query budget (bytes)',
        kind: 'text',
        placeholder: '10000000000',
        help: 'Every query is capped at this. A runaway scan is a bill, not an outage.',
      },
    ],
    enables: ['bq-orders', 'bq-ga4-events', 'bq-ga4-scans', 'bq-catalogue-master'],
    supersedes: ['GCP_SA_KEY_JSON', 'GCP_PROJECT_ID', 'BQ_GA4_DATASET', 'BQ_MAX_BYTES_BILLED'],
    testDescription: 'Exchanges the key for a token and lists datasets in the project.',
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    category: 'database',
    blurb: 'The serving marts every page reads from. Without it the dashboard runs entirely on fixtures.',
    fields: [
      {
        key: 'url',
        label: 'Connection string',
        kind: 'password',
        secret: true,
        required: true,
        placeholder: 'postgres://user:password@host:5432/database',
        pattern: '^postgres(ql)?://',
        patternHint: 'Must start with postgres:// or postgresql://',
        help: 'Needs write access — the connectors load into it.',
      },
      {
        key: 'readonlyUrl',
        label: 'Read-only connection string',
        kind: 'password',
        secret: true,
        placeholder: 'postgres://readonly@host:5432/database',
        help: 'Used by Ask-the-data (§28.9). Strongly recommended: it is the only thing standing between a generated query and your marts.',
      },
    ],
    enables: ['every connector’s load step', '/api/ask'],
    supersedes: ['DATABASE_URL', 'DATABASE_URL_READONLY'],
    testDescription: 'Opens a connection and runs SELECT 1.',
  },
  {
    id: 'google-sheets',
    label: 'Google Sheets',
    category: 'spreadsheet',
    blurb: 'The store master, maintained by hand. The only source for which stores are Companion-live.',
    fields: [
      SA_JSON,
      {
        key: 'storeMasterId',
        label: 'Store master sheet ID',
        kind: 'text',
        required: true,
        placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        help: 'The ID from the sheet URL, between /d/ and /edit. Share the sheet with the service-account email first.',
      },
      { key: 'eventsSheetId', label: 'Event dictionary sheet ID', kind: 'text' },
      { key: 'tasksSheetId', label: 'NOC task register sheet ID', kind: 'text' },
    ],
    enables: ['sheets-store-master'],
    supersedes: ['SHEET_STORE_MASTER_ID', 'SHEET_GA4_EVENTS_ID', 'SHEET_TASKS_ID'],
    testDescription: 'Reads row 1 of the store master and reports the column names it found.',
  },
  {
    id: 'slack',
    label: 'Slack',
    category: 'messaging',
    blurb: 'The hourly catalogue sync report, Sentry alerts, and NOC escalations. Also where alerts and the daily brief are posted.',
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        kind: 'password',
        secret: true,
        required: true,
        placeholder: 'xoxb-…',
        pattern: "^xox[baprs]-",
        patternHint: 'Slack bot tokens start with xoxb-.',
        help: 'Scopes: channels:history to read, chat:write to alert, files:read for the XLSX attachments.',
      },
      {
        key: 'catalogueChannel',
        label: 'Catalogue report channel',
        kind: 'text',
        placeholder: 'C0AV6FU1YUU',
        help: '#sng-catalogue-lack — the hourly Catalog Sync Report from Tatsu Bot.',
      },
      {
        key: 'alertsChannel',
        label: 'Alerts channel',
        kind: 'text',
        placeholder: 'C0B0APYNZTQ',
        help: '#companion-app-alerts — Sentry alerts and the nightly health digest.',
      },
      { key: 'nocChannel', label: 'NOC escalations channel', kind: 'text', placeholder: 'C0BFJQDV05N' },
      { key: 'digestChannel', label: 'Daily brief channel', kind: 'text', help: 'Where the §28 morning brief is posted.' },
    ],
    enables: ['slack-catalogue-report', 'slack-alerts', 'alerting', 'the daily brief'],
    supersedes: ['SLACK_BOT_TOKEN', 'SLACK_CATALOGUE_CHANNEL', 'SLACK_ALERTS_CHANNEL', 'SLACK_NOC_CHANNEL', 'SLACK_DIGEST_CHANNEL'],
    testDescription: 'Calls auth.test, then reads one message from each channel given.',
  },
  {
    id: 'sentry',
    label: 'Sentry',
    category: 'observability',
    blurb: 'Crash-free rate and error volume. Reading the API directly beats parsing the Slack alerts.',
    fields: [
      {
        key: 'authToken',
        label: 'Auth token',
        kind: 'password',
        secret: true,
        required: true,
        help: 'Scopes: org:read, project:read, event:read.',
      },
      { key: 'org', label: 'Organisation slug', kind: 'text', required: true, placeholder: 'fynd-f7' },
      {
        key: 'projects',
        label: 'Projects',
        kind: 'text',
        placeholder: 'avis,computron,silverbolt,cartorderproxy,hashira,gringotts,megatron',
        help: 'Comma-separated. These seven were read off the real alerts.',
      },
    ],
    enables: ['sentry'],
    supersedes: ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECTS'],
    testDescription: 'Lists the organisation’s projects and confirms each named one exists.',
  },
  {
    id: 'jira',
    label: 'Jira',
    category: 'observability',
    blurb: 'The issue register behind /issues.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', kind: 'text', required: true, placeholder: 'https://gofynd.atlassian.net' },
      { key: 'email', label: 'Account email', kind: 'text', required: true },
      { key: 'apiToken', label: 'API token', kind: 'password', secret: true, required: true },
      { key: 'projectKey', label: 'Project key', kind: 'text', placeholder: 'NI' },
      {
        key: 'componentFilter',
        label: 'Companion component or label',
        kind: 'text',
        help: 'A11 — the board is shared, so without this the P0 count counts other teams’ issues too.',
      },
    ],
    enables: ['jira'],
    supersedes: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'JIRA_COMPONENT_FILTER'],
    testDescription: 'Runs a JQL search bounded to one issue and reports what came back.',
  },
  {
    id: 'ga4',
    label: 'Google Analytics 4',
    category: 'analytics',
    blurb: 'The Data API, as a cross-check on the BigQuery export. Where they disagree the export wins — the API samples.',
    fields: [
      SA_JSON,
      { key: 'propertyId', label: 'Property ID', kind: 'text', required: true, placeholder: '524294430' },
    ],
    enables: ['ga4-api'],
    supersedes: ['GA4_PROPERTY_ID'],
    testDescription: 'Runs a one-row report against the property.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    category: 'analytics',
    blurb: 'The written narrative on the daily brief. Anomaly detection and RCA work without it — only the prose needs it.',
    fields: [
      { key: 'apiKey', label: 'API key', kind: 'password', secret: true, required: true, placeholder: 'sk-ant-…' },
      { key: 'model', label: 'Model', kind: 'text', placeholder: 'claude-sonnet-4-6' },
    ],
    enables: ['the AI narrative on /insights'],
    supersedes: ['ANTHROPIC_API_KEY', 'AI_MODEL'],
    testDescription: 'Sends a one-token completion.',
  },
];


/* ── Generic sources ─────────────────────────────────────────────────────────
 *
 * The connectors above are Companion-specific: each one feeds a named §5 metric
 * and a named mart. The ones below are the general families a BI tool is
 * expected to offer — connect anything, explore it in Ask-the-data, chart it.
 *
 * They are marked `genericOnly` and the UI says so, because the distinction is
 * a real promise rather than a label. A source that feeds a §5 metric has an
 * owner, an SLA, an assertion gate and a place on the health board. A generic
 * one is queryable and nothing more. Blurring the two would let somebody put a
 * Stripe number on a NOC wall display with no freshness guarantee behind it.
 */

const DB_FIELDS = (scheme: string, port: string): SourceField[] => [
  {
    key: 'url',
    label: 'Connection string',
    kind: 'password',
    secret: true,
    required: true,
    placeholder: `${scheme}://user:password@host:${port}/database`,
    pattern: `^${scheme}(ql)?://`,
    patternHint: `Must start with ${scheme}://`,
    help: 'Use a read-only role. A dashboard has no reason to hold write access to a source system.',
  },
];

const GENERIC_TYPES: SourceType[] = [
  {
    id: 'mysql',
    label: 'MySQL / MariaDB',
    category: 'database',
    blurb: 'Any MySQL-compatible database, for exploration and charting.',
    aliases: ['mariadb', 'sql', 'rds', 'aurora'],
    fields: DB_FIELDS('mysql', '3306'),
    enables: ['Ask-the-data', 'custom charts'],
    supersedes: [],
    testDescription: 'Opens a connection and runs SELECT 1.',
    genericOnly: true,
  },
  {
    id: 'snowflake',
    label: 'Snowflake',
    category: 'warehouse',
    blurb: 'Warehouse tables, for exploration and charting.',
    aliases: ['warehouse', 'sql'],
    /**
     * Key-pair, not a password.
     *
     * Snowflake's SQL API v2 accepts a key-pair JWT or OAuth and does *not*
     * accept a username and password, so a password form here would have been a
     * field nobody could make work. It also means no driver: the JWT is signed
     * with `node:crypto` exactly as the GCP one is.
     */
    fields: [
      {
        key: 'account',
        label: 'Account identifier',
        kind: 'text',
        required: true,
        placeholder: 'xy12345.ap-south-1',
        help: 'From the account URL, without .snowflakecomputing.com.',
      },
      {
        key: 'username',
        label: 'Username',
        kind: 'text',
        required: true,
        help: 'The user the public key is registered against (ALTER USER … SET RSA_PUBLIC_KEY).',
      },
      {
        key: 'privateKey',
        label: 'Private key (PEM)',
        kind: 'textarea',
        secret: true,
        required: true,
        placeholder: '-----BEGIN PRIVATE KEY-----\n…',
        pattern: 'BEGIN (RSA )?PRIVATE KEY',
        patternHint: 'Paste the unencrypted PKCS#8 PEM, including the BEGIN/END lines.',
      },
      { key: 'warehouse', label: 'Warehouse', kind: 'text', required: true },
      { key: 'database', label: 'Database', kind: 'text', required: true },
      { key: 'schema', label: 'Schema', kind: 'text', placeholder: 'PUBLIC' },
      { key: 'role', label: 'Role', kind: 'text' },
    ],
    enables: ['Ask-the-data', 'custom charts'],
    supersedes: [],
    testDescription: 'Signs a key-pair JWT and runs SELECT 1 through the SQL API.',
    genericOnly: true,
  },
  {
    id: 'sqlserver',
    label: 'Microsoft SQL Server',
    category: 'database',
    blurb: 'SQL Server or Azure SQL — where a lot of retail reporting still lives.',
    aliases: ['mssql', 'azure sql', 'tsql', 'sql', 'microsoft', 'power bi'],
    fields: [
      { key: 'server', label: 'Server', kind: 'text', required: true, placeholder: 'acme.database.windows.net' },
      { key: 'database', label: 'Database', kind: 'text', required: true },
      { key: 'username', label: 'Username', kind: 'text', required: true },
      { key: 'password', label: 'Password', kind: 'password', secret: true, required: true },
      {
        key: 'port',
        label: 'Port',
        kind: 'text',
        placeholder: '1433',
        pattern: '^\\d+$',
        patternHint: 'Digits only.',
      },
      {
        key: 'encrypt',
        label: 'Encryption',
        kind: 'select',
        options: [
          { value: 'true', label: 'Required (Azure SQL, and the right answer)' },
          { value: 'false', label: 'Off (legacy on-premise only)' },
        ],
        help: 'Azure SQL rejects an unencrypted connection outright; an on-premise instance may not offer one.',
      },
    ],
    enables: ['Ask-the-data', 'custom charts'],
    supersedes: [],
    testDescription: 'Opens a connection and runs SELECT @@VERSION.',
    genericOnly: true,
  },
  {
    id: 'rest-api',
    label: 'REST API',
    category: 'generic',
    blurb: 'Any JSON endpoint. The escape hatch for a source with no dedicated connector yet.',
    aliases: ['http', 'json', 'webhook', 'api', 'custom'],
    fields: [
      {
        key: 'baseUrl',
        label: 'URL',
        kind: 'text',
        required: true,
        placeholder: 'https://api.example.com/v1/metrics',
        pattern: '^https://',
        patternHint: 'Must be https. A credential sent over http is a credential given away.',
      },
      {
        key: 'authHeader',
        label: 'Authorization header',
        kind: 'password',
        secret: true,
        placeholder: 'Bearer …',
        help: 'Sent as the Authorization header. Encrypted at rest and never shown again.',
      },
      {
        key: 'jsonPath',
        label: 'Path to the rows',
        kind: 'text',
        placeholder: 'data.items',
        help: 'Dotted path to the array in the response. Leave blank if the body is already an array.',
      },
    ],
    enables: ['Ask-the-data', 'custom charts'],
    supersedes: [],
    testDescription: 'Fetches the URL and reports the shape of what came back.',
    genericOnly: true,
  },
  {
    id: 'csv-url',
    label: 'CSV / TSV file',
    category: 'file',
    blurb: 'A delimited file at a URL — an export, a published sheet, a bucket object.',
    aliases: ['excel', 'tsv', 'export', 'file', 'gcs', 's3'],
    fields: [
      {
        key: 'url',
        label: 'File URL',
        kind: 'text',
        required: true,
        placeholder: 'https://storage.googleapis.com/bucket/export.csv',
        pattern: '^https://',
        patternHint: 'Must be https.',
      },
      {
        key: 'delimiter',
        label: 'Delimiter',
        kind: 'select',
        options: [
          { value: ',', label: 'Comma' },
          { value: '\t', label: 'Tab' },
          { value: ';', label: 'Semicolon' },
          { value: '|', label: 'Pipe' },
        ],
      },
      { key: 'authHeader', label: 'Authorization header', kind: 'password', secret: true },
    ],
    enables: ['Ask-the-data', 'custom charts'],
    supersedes: [],
    testDescription: 'Fetches the first few KB and reports the header row it parsed.',
    genericOnly: true,
  },
  {
    id: 'gcs',
    label: 'Google Cloud Storage',
    category: 'file',
    blurb: 'Bucket objects — catalogue exports, RRA inventory, report attachments.',
    aliases: ['bucket', 'storage', 'gcp', 'file'],
    fields: [
      SA_JSON,
      { key: 'bucket', label: 'Bucket', kind: 'text', required: true, placeholder: 'companion-exports' },
      { key: 'prefix', label: 'Path prefix', kind: 'text', placeholder: 'catalogue/daily/' },
    ],
    enables: ['Ask-the-data', 'file-backed connectors'],
    supersedes: [],
    testDescription: 'Lists objects under the prefix and reports how many it found.',
    genericOnly: true,
  },
];

for (const t of GENERIC_TYPES) SOURCE_TYPES.push(t);

/**
 * …and the SaaS families, declared next to their probes in `saas.ts` so a type
 * and its connection test cannot drift apart. The import is a value import in
 * this direction only — `saas.ts` takes types from here with `import type`,
 * which erases, so there is no runtime cycle.
 */
for (const t of SAAS_TYPES) SOURCE_TYPES.push(t);

/**
 * Search across label, blurb and aliases.
 *
 * Once the catalogue passes about a dozen entries a picker without search is a
 * scroll, and someone looking for "Excel" needs to land on Sheets or CSV rather
 * than conclude the product does not support it.
 */
export function searchSourceTypes(query: string): SourceType[] {
  const q = query.trim().toLowerCase();
  if (!q) return SOURCE_TYPES;
  return SOURCE_TYPES.filter((t) =>
    [t.label, t.blurb, t.id, ...(t.aliases ?? [])].join(' ').toLowerCase().includes(q),
  );
}

export function getSourceType(id: string): SourceType | undefined {
  return SOURCE_TYPES.find((t) => t.id === id);
}

/** Fields whose values must be encrypted rather than stored as config. */
export function secretFields(type: SourceType): string[] {
  return type.fields.filter((f) => f.secret).map((f) => f.key);
}

export interface ValidationResult {
  ok: boolean;
  errors: Array<{ field: string; message: string }>;
}

/**
 * Checked before any network call, so an obvious typo costs no round trip and
 * no rate-limit budget.
 */
export function validate(type: SourceType, values: Record<string, string>): ValidationResult {
  const errors: ValidationResult['errors'] = [];
  for (const f of type.fields) {
    const v = (values[f.key] ?? '').trim();
    if (f.required && !v) {
      errors.push({ field: f.key, message: `${f.label} is required` });
      continue;
    }
    if (v && f.pattern && !new RegExp(f.pattern).test(v)) {
      errors.push({ field: f.key, message: f.patternHint ?? `${f.label} does not look right` });
    }
  }
  return { ok: errors.length === 0, errors };
}
