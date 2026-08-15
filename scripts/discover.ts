#!/usr/bin/env tsx
/**
 * §15.3 / §16.1 — schema discovery, the mandatory first step of Phase 2/3.
 *
 * Every connector in this build was written against a *guess* at its source's
 * shape, and every guess that has since met reality has been wrong: the Slack
 * catalogue report parsed four fields that do not exist, the alerts connector
 * treated structured Sentry payloads as prose, and two marts had no writer at
 * all. This exists so the guessing stops.
 *
 * It only reads metadata. `__TABLES__` and `INFORMATION_SCHEMA` are free in
 * BigQuery — they do not scan table bodies — so mapping a project costs
 * nothing. Anything that would actually scan bytes goes through `--sample`,
 * which dry-runs first and refuses over budget.
 *
 *   npm run discover                       # datasets in the configured project
 *   npm run discover -- <dataset>          # tables, with row counts and size
 *   npm run discover -- <dataset> <table>  # columns
 *   npm run discover -- <dataset> <table> --sample
 */
import { config } from '../lib/config';
import { assertWithinBudget, listDatasets, runQuery } from '../lib/gcp/bigquery';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [dataset, table] = args.filter((a) => !a.startsWith('--'));
const project = process.env.BQ_DISCOVER_PROJECT || config.gcpProjectId;

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

const bytes = (n: number): string => {
  if (n > 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
};

async function datasets(): Promise<void> {
  const ds = await listDatasets(project);
  console.log(bold(`\n${project} — ${ds.length} datasets\n`));
  for (const d of ds) console.log(`  ${d}`);
  console.log(dim(`\n  npm run discover -- <dataset>   to list its tables\n`));
}

async function tables(): Promise<void> {
  // `__TABLES__` carries row counts and byte sizes without scanning anything.
  const res = await runQuery<{ table_name: string; row_count: string; size_bytes: string; type: string }>({
    query: `
      SELECT table_id AS table_name,
             CAST(row_count AS STRING)  AS row_count,
             CAST(size_bytes AS STRING) AS size_bytes,
             CAST(type AS STRING)       AS type
      FROM \`${project}.${dataset}.__TABLES__\`
      ORDER BY row_count DESC
      LIMIT 60`,
    connector: 'discovery',
  });

  console.log(bold(`\n${project}.${dataset} — ${res.rows.length} tables\n`));
  for (const t of res.rows) {
    const rows = Number(t.row_count);
    console.log(
      `  ${t.table_name.padEnd(48)} ${rows.toLocaleString('en-IN').padStart(14)} rows  ${dim(
        bytes(Number(t.size_bytes)),
      )}`,
    );
  }
  console.log(dim(`\n  npm run discover -- ${dataset} <table>   to list its columns\n`));
}

async function columns(): Promise<void> {
  const res = await runQuery<{ column_name: string; data_type: string; is_nullable: string }>({
    query: `
      SELECT column_name, data_type, is_nullable
      FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = @t
      ORDER BY ordinal_position`,
    params: { t: table },
    types: { t: 'STRING' },
    connector: 'discovery',
  });

  if (res.rows.length === 0) {
    console.log(`\nNo such table: ${project}.${dataset}.${table}\n`);
    return;
  }

  console.log(bold(`\n${project}.${dataset}.${table} — ${res.rows.length} columns\n`));
  for (const c of res.rows) {
    console.log(`  ${c.column_name.padEnd(40)} ${c.data_type.padEnd(24)} ${dim(c.is_nullable === 'YES' ? 'null' : '')}`);
  }

  // Columns whose names suggest they carry the keys this dashboard joins on.
  // Naming a candidate is not the same as confirming it — the label says so.
  const names = res.rows.map((c) => c.column_name.toLowerCase());
  const hit = (re: RegExp) => res.rows.filter((c) => re.test(c.column_name.toLowerCase())).map((c) => c.column_name);
  const candidates: Array<[string, string[]]> = [
    ['EAN / barcode / GTIN', hit(/ean|barcode|gtin|upc|identifier/)],
    ['item / article code', hit(/item_?code|article|sku|style/)],
    ['store', hit(/store|site|location/)],
    ['category', hit(/categ|dept|division/)],
    ['brand', hit(/brand/)],
    ['active flag', hit(/is_?active|status|enabled/)],
  ];
  const found = candidates.filter(([, cols]) => cols.length > 0);
  if (found.length) {
    console.log(bold('\n  Candidate join keys — by name, not verified:\n'));
    for (const [what, cols] of found) console.log(`    ${what.padEnd(24)} ${cols.join(', ')}`);
  }
  console.log(dim(`\n  add --sample to read 5 rows (dry-runs against the byte budget first)\n`));
  void names;
}

/**
 * Five rows, only on request, and only after a dry run proves it is affordable.
 * §14.2 — a `SELECT *` on an unfamiliar table is how a discovery session
 * becomes a bill.
 */
async function sample(): Promise<void> {
  const opts = {
    query: `SELECT * FROM \`${project}.${dataset}.${table}\` LIMIT 5`,
    connector: 'discovery',
  };
  const willScan = await assertWithinBudget(opts);
  console.log(dim(`\n  dry run: ${bytes(willScan)} would be scanned\n`));

  const res = await runQuery<Record<string, unknown>>(opts);
  for (const [i, row] of res.rows.entries()) {
    console.log(bold(`  row ${i + 1}`));
    for (const [k, v] of Object.entries(row)) {
      const s = v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      console.log(`    ${k.padEnd(34)} ${s.slice(0, 90)}`);
    }
    console.log();
  }
}

async function main(): Promise<void> {
  if (!process.env.GCP_SA_KEY_JSON) {
    console.error('No GCP_SA_KEY_JSON. Discovery needs a service account (§13.2).');
    process.exit(1);
  }
  if (!dataset) return datasets();
  if (!table) return tables();
  if (flags.has('--sample')) return sample();
  return columns();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
