/**
 * BigQuery over the REST API, with the cost guards from §16.7 built in.
 *
 * Every job is labelled (§15.2): when someone asks why the BQ bill moved,
 * labels are the only way to answer. Every job carries `maximumBytesBilled`.
 */
import { config } from '@/lib/config';
import { getAccessToken, isGcpConfigured } from './auth';

const BQ_BASE = 'https://bigquery.googleapis.com/bigquery/v2';

export type BqParamType = 'STRING' | 'DATE' | 'TIMESTAMP' | 'INT64' | 'BOOL';

export interface BqQueryOptions {
  query: string;
  params?: Record<string, string | number | boolean | string[]>;
  types?: Record<string, BqParamType | [BqParamType]>;
  /** Connector id — becomes a job label so cost is attributable. */
  connector: string;
  maximumBytesBilled?: string;
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface BqResult<T> {
  rows: T[];
  totalBytesProcessed: number;
  cacheHit: boolean;
  jobId: string | null;
}

export class BudgetError extends Error {
  constructor(
    readonly bytes: number,
    readonly budget: number,
  ) {
    super(
      `Query would scan ${(bytes / 1024 ** 3).toFixed(2)} GiB, over the ${(budget / 1024 ** 3).toFixed(2)} GiB budget — refusing to run`,
    );
    this.name = 'BudgetError';
  }
}

function toQueryParameter(
  name: string,
  value: string | number | boolean | string[],
  type: BqParamType | [BqParamType] | undefined,
) {
  if (Array.isArray(value)) {
    const elementType = Array.isArray(type) ? type[0] : 'STRING';
    return {
      name,
      parameterType: { type: 'ARRAY', arrayType: { type: elementType } },
      parameterValue: { arrayValues: value.map((v) => ({ value: String(v) })) },
    };
  }
  const t = (Array.isArray(type) ? type[0] : type) ?? 'STRING';
  return { name, parameterType: { type: t }, parameterValue: { value: String(value) } };
}

/** Decodes BigQuery's positional row format into plain objects. */
function decodeRows<T>(schema: { fields?: Array<{ name: string; type: string }> }, rows: Array<{ f: Array<{ v: unknown }> }>): T[] {
  const fields = schema.fields ?? [];
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    row.f.forEach((cell, i) => {
      const field = fields[i];
      if (!field) return;
      const v = cell.v;
      if (v === null || v === undefined) {
        out[field.name] = null;
      } else if (['INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC'].includes(field.type)) {
        out[field.name] = Number(v);
      } else if (['BOOLEAN', 'BOOL'].includes(field.type)) {
        out[field.name] = v === 'true' || v === true;
      } else {
        out[field.name] = v;
      }
    });
    return out as T;
  });
}

export function isBigQueryConfigured(): boolean {
  return isGcpConfigured();
}

export async function runQuery<T = Record<string, unknown>>(opts: BqQueryOptions): Promise<BqResult<T>> {
  if (!isGcpConfigured()) throw new Error('GCP service account not configured — see §13.2');
  const token = await getAccessToken();

  const queryParameters = Object.entries(opts.params ?? {}).map(([name, value]) =>
    toQueryParameter(name, value, opts.types?.[name]),
  );

  const body = {
    query: opts.query,
    useLegacySql: false,
    parameterMode: queryParameters.length ? 'NAMED' : undefined,
    queryParameters: queryParameters.length ? queryParameters : undefined,
    maximumBytesBilled: opts.maximumBytesBilled ?? config.bqMaxBytesBilled,
    dryRun: opts.dryRun ?? false,
    timeoutMs: opts.timeoutMs ?? 60_000,
    labels: { app: 'companion-dashboard', connector: opts.connector },
  };

  const res = await fetch(`${BQ_BASE}/projects/${config.gcpProjectId}/queries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BigQuery ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    schema?: { fields?: Array<{ name: string; type: string }> };
    rows?: Array<{ f: Array<{ v: unknown }> }>;
    totalBytesProcessed?: string;
    cacheHit?: boolean;
    jobReference?: { jobId?: string };
    jobComplete?: boolean;
  };

  return {
    rows: json.rows ? decodeRows<T>(json.schema ?? {}, json.rows) : [],
    totalBytesProcessed: Number(json.totalBytesProcessed ?? 0),
    cacheHit: Boolean(json.cacheHit),
    jobId: json.jobReference?.jobId ?? null,
  };
}

/**
 * §16.7 — dry-run gate. On any query whose window exceeds 7 days, read
 * `totalBytesProcessed` first and refuse if it is over budget.
 */
export async function assertWithinBudget(opts: BqQueryOptions, budgetBytes?: number): Promise<number> {
  const budget = budgetBytes ?? Number(config.bqMaxBytesBilled);
  const dry = await runQuery({ ...opts, dryRun: true });
  if (dry.totalBytesProcessed > budget) throw new BudgetError(dry.totalBytesProcessed, budget);
  return dry.totalBytesProcessed;
}

/** §16.1 / §15.3 — schema and dataset discovery, the mandatory first step of Phase 2/3. */
export async function listDatasets(project = config.gcpProjectId): Promise<string[]> {
  const rows = await runQuery<{ schema_name: string }>({
    query: `SELECT schema_name FROM \`${project}.INFORMATION_SCHEMA.SCHEMATA\` ORDER BY schema_name`,
    connector: 'discovery',
  });
  return rows.rows.map((r) => r.schema_name);
}

export async function describeTable(
  dataset: string,
  table: string,
  project = config.gcpProjectId,
): Promise<Array<{ column_name: string; data_type: string }>> {
  const res = await runQuery<{ column_name: string; data_type: string }>({
    query: `
      SELECT column_name, data_type
      FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = @table
      ORDER BY ordinal_position`,
    params: { table },
    connector: 'discovery',
  });
  return res.rows;
}

export async function tableExists(dataset: string, tablePrefix: string, project = config.gcpProjectId): Promise<boolean> {
  try {
    const res = await runQuery<{ n: number }>({
      query: `
        SELECT COUNT(*) AS n
        FROM \`${project}.${dataset}.INFORMATION_SCHEMA.TABLES\`
        WHERE table_name LIKE @prefix`,
      params: { prefix: `${tablePrefix}%` },
      connector: 'discovery',
    });
    return (res.rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}
