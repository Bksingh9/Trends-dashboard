/**
 * §28.6 — Ask the data: text → SQL over the Postgres marts only.
 *
 * The regex guard below is defence in depth and a convenience. The read-only
 * database role is the layer that actually matters — regex on generated SQL is
 * not a security boundary.
 */

export const SQL_GUARD = {
  allowedTables: [
    'fact_orders',
    'fact_funnel_daily',
    'fact_scan_daily',
    'fact_scan_rejected_daily',
    'fact_catalogue_gap',
    'fact_catalogue_daily',
    'fact_app_health_daily',
    'fact_api_latency',
    'fact_store_adoption_daily',
    'fact_store_ops',
    'fact_issues',
    'fact_store_visit_audit',
    'dim_store',
    'dim_product',
    'dim_date',
  ],
  forbidden: [
    /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|vacuum|call|do)\b/i,
    /pg_/i,
    /information_schema/i,
    /;\s*\S/, // no statement chaining
    /\bdblink\b/i,
    /\bpg_read_file\b/i,
  ],
  requireLimit: 5000,
  statementTimeoutMs: 15_000,
  dbRole: 'dashboard_readonly', // enforced at the database, not just in code
  targetOnly: 'postgres' as const, // generated SQL never reaches BigQuery
};

export interface GuardResult {
  ok: boolean;
  sql: string;
  violations: string[];
  /** The LIMIT actually applied, after clamping. */
  appliedLimit: number;
}

const TABLE_REF = /\b(?:from|join)\s+([a-z_][a-z0-9_."]*)/gi;

export function guardSql(raw: string): GuardResult {
  const violations: string[] = [];
  let sql = raw.trim().replace(/^```sql\s*/i, '').replace(/```$/, '').trim();
  // A single trailing semicolon is fine; anything after one is chaining.
  sql = sql.replace(/;\s*$/, '');

  if (!/^\s*(with|select)\b/i.test(sql)) {
    violations.push('Query must start with SELECT or WITH');
  }

  for (const pattern of SQL_GUARD.forbidden) {
    if (pattern.test(sql)) violations.push(`Forbidden pattern matched: ${pattern}`);
  }

  const referenced = new Set<string>();
  for (const m of sql.matchAll(TABLE_REF)) {
    const name = m[1].replace(/"/g, '').split('.').pop() ?? '';
    // CTE names are resolved below; only flag genuine unknown tables.
    referenced.add(name.toLowerCase());
  }
  const cteNames = new Set(
    [...sql.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()),
  );
  for (const t of referenced) {
    if (cteNames.has(t)) continue;
    if (!SQL_GUARD.allowedTables.includes(t)) {
      violations.push(`Table "${t}" is not in the allowlist`);
    }
  }

  // Force a bounded result set.
  let appliedLimit = SQL_GUARD.requireLimit;
  const limitMatch = sql.match(/\blimit\s+(\d+)\s*$/i);
  if (limitMatch) {
    const requested = Number(limitMatch[1]);
    appliedLimit = Math.min(requested, SQL_GUARD.requireLimit);
    sql = sql.replace(/\blimit\s+\d+\s*$/i, `LIMIT ${appliedLimit}`);
  } else {
    sql = `${sql}\nLIMIT ${appliedLimit}`;
  }

  return { ok: violations.length === 0, sql, violations, appliedLimit };
}

/**
 * The schema context handed to the model — DDL and metric definitions, never
 * data (§28.6).
 */
export function schemaPrompt(): string {
  return `
Allowed tables (PostgreSQL):

fact_orders(order_id text pk, order_ts timestamptz, order_date date, store_id text,
  tenant text, affiliate_id text, customer_id text /* hashed */, is_new_customer bool,
  status text, status_confirmed bool, units int, gross_value numeric, discount_amount numeric,
  coupon_amount numeric, coupon_code text, net_value numeric, payment_method text,
  app_version text, sdk_version text, platform text)

fact_funnel_daily(date_key date, store_id text, tenant text, platform text, app_version text,
  step text, step_order int, event_count bigint, session_count bigint, user_count bigint,
  is_instrumented bool)  -- is_instrumented=false means the event was never measured, NOT zero

fact_scan_daily(date_key date, store_id text, ean text, result text /* found|not_found */,
  platform text, sales_channel text, scan_count bigint, session_count bigint)

fact_catalogue_daily(date_key date pk, total_scans bigint, total_failed bigint,
  unique_scans bigint, unique_failed bigint, unique_coverage numeric, total_coverage numeric,
  bot_stated_pct numeric, report_generated bool /* NULL = unreachable */, _source text)

fact_catalogue_gap(ean text pk, first_seen date, last_seen date, scan_count bigint,
  stores_affected int, suspected_reason text, reason_direction text, status text, owner text)

fact_app_health_daily(date_key date pk, sessions bigint, crashed_sessions bigint,
  crash_free_rate numeric, sentry_error_count bigint, api_call_count bigint,
  api_error_count bigint, api_error_rate numeric, payment_attempts bigint,
  payment_successes bigint, payment_success_rate numeric, gcp_error_log_count bigint,
  app_health_score numeric)

fact_api_latency(date_key date, endpoint text, p50_ms int, p90_ms int, p95_ms int, p99_ms int,
  call_count bigint, error_count bigint, slo_p95_ms int, slo_confirmed bool, _source text)

fact_store_adoption_daily(date_key date, store_id text, orders int, revenue numeric,
  scans bigint, scan_success_rate numeric, sessions bigint)

fact_store_ops(store_id text pk, qr_vm_placed bool, staff_trained bool, footfall_daily int,
  bills_daily int, noc_owner text)

fact_issues(issue_key text pk, source text, title text, priority text, status text,
  workstream text, journey_step text, store_code text, assignee text, created_at timestamptz,
  resolved_at timestamptz, url text)

fact_store_visit_audit(visit_id bigint pk, visit_date date, store_id text, store_label text,
  auditor text, items_scanned int, items_failed int, sampled_coverage numeric)

dim_store(store_key serial pk, store_id text unique, store_code text, store_name text,
  city text, state text, region text, tenant text, companion_live bool, activated_on date,
  lat numeric, lon numeric)

dim_product(product_key serial pk, item_code text, ean text, name text, brand text,
  category text, category_mapped bool, mrp numeric, is_active bool)

dim_date(date_key date pk, iso_week int, month int, quarter int, year int, is_weekend bool,
  is_sale_period bool, sale_name text)

Notes:
- unique_coverage = (unique_scans - unique_failed) / unique_scans. Over a multi-day window,
  compute distinct EANs from fact_scan_daily; do NOT sum daily unique counts.
- Money is rupees.
- Dates are IST calendar dates.
`.trim();
}
