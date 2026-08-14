#!/usr/bin/env tsx
/**
 * The ETL command line — §6.4, §7.8.
 *
 * The HTTP routes are for the scheduler and the page. This is for a person: the
 * first load after `db:push`, a backfill over a named window, and the "what is
 * actually in the mart right now" question that no dashboard can answer about
 * itself when the dashboard is the thing under suspicion.
 *
 * Everything here goes through the same `tick`/`run` path the heartbeat uses.
 * A separate code path for manual runs is how a backfill ends up skipping the
 * assertion gate — which is exactly when you least want it skipped, because a
 * backfill writes far more rows than an incremental.
 *
 *   npm run etl:run                      # everything past its freshness SLA
 *   npm run etl:run -- --all             # everything, ignoring the SLA
 *   npm run etl:run -- bq-orders         # one connector
 *   npm run etl:backfill -- bq-orders 2026-04-01 2026-06-30
 *   npm run etl:status                   # the board, as text
 */
import { CONNECTORS, connectorStatuses, getConnector } from '../lib/connectors/registry';
import { tick, windowFor } from '../lib/connectors/scheduler';
import { recentRuns } from '../lib/connectors/run-log';
import { getDb } from '../lib/db/client';
import { addDays, daysBetween, trailingWindow } from '../lib/format/dates';

const [, , command, ...args] = process.argv;

/** ANSI, but only when someone is watching. Piped output stays clean. */
const tty = process.stdout.isTTY;
const c = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  amber: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
};

function requireDb(): void {
  if (getDb()) return;
  console.error(
    c.red('No DATABASE_URL.') +
      '\nThe connectors would run and their output would go nowhere — the load step needs a mart.' +
      '\n\n  export DATABASE_URL=postgres://…\n  npm run db:push\n',
  );
  process.exit(1);
}

async function run(): Promise<void> {
  requireDb();
  const force = args.includes('--all');
  const only = args.filter((a) => !a.startsWith('--'));

  for (const id of only) {
    if (!getConnector(id)) {
      console.error(c.red(`Unknown connector "${id}".`));
      console.error(`Known: ${CONNECTORS.map((x) => x.id).join(', ')}`);
      process.exit(1);
    }
  }

  const label = only.length ? only.join(', ') : force ? 'every connector' : 'everything past its SLA';
  console.log(c.bold(`Running ${label}…\n`));

  // Force when a connector is named: someone who typed its id has already
  // decided, and making them wait for the SLA would be obtuse.
  const result = await tick({ only, force: force || only.length > 0 });

  for (const r of result.ran) {
    const mark = r.ok ? c.green('ok  ') : c.red('FAIL');
    console.log(
      `  ${mark} ${r.id.padEnd(24)} ${String(r.rows).padStart(7)} rows  ${c.dim(`${(r.ms / 1000).toFixed(1)}s  ${r.source}`)}`,
    );
    for (const w of r.warnings) console.log(c.amber(`       ▲ ${w}`));
  }

  // Skips are printed too. A run that did nothing and said nothing is
  // indistinguishable from a run that never happened.
  const notable = result.skipped.filter((s) => s.reason !== 'not_due');
  for (const s of notable) console.log(`  ${c.dim('skip')} ${s.id.padEnd(24)} ${c.dim(s.reason)}`);
  const withinSla = result.skipped.length - notable.length;
  if (withinSla > 0) console.log(c.dim(`  skip ${withinSla} connectors already within their SLA`));

  if (result.truncated) console.log(c.amber('\n  Budget reached — the rest run on the next invocation.'));

  const failed = result.ran.filter((r) => !r.ok);
  console.log(
    `\n${result.ran.length} ran, ${failed.length} failed, ${result.skipped.length} skipped in ${(result.durationMs / 1000).toFixed(1)}s.`,
  );
  // Non-zero exit so CI and cron wrappers notice. A failed load leaves the mart
  // on its last good snapshot (§6.3), which is safe but is not success.
  if (failed.length) process.exit(1);
}

/**
 * Backfill in SLA-sized chunks rather than one enormous window.
 *
 * A three-month BigQuery scan in a single query is both a bill and a timeout,
 * and if it fails at 80% there is nothing to resume from. Chunked, each piece
 * commits independently and the run log records exactly how far it got.
 */
async function backfill(): Promise<void> {
  requireDb();
  const [id, start, end, chunkArg] = args;
  if (!id || !start || !end) {
    console.error('Usage: npm run etl:backfill -- <connector> <start> <end> [chunkDays]');
    process.exit(1);
  }
  const connector = getConnector(id);
  if (!connector) {
    console.error(c.red(`Unknown connector "${id}". Known: ${CONNECTORS.map((x) => x.id).join(', ')}`));
    process.exit(1);
  }

  const chunkDays = Number(chunkArg ?? windowSpan(id));
  const total = daysBetween(start, end) + 1;
  console.log(c.bold(`Backfilling ${id}: ${start} → ${end} (${total} days, ${chunkDays}-day chunks)\n`));

  let cursor = start;
  let chunks = 0;
  let rows = 0;
  let failed = 0;

  while (cursor <= end) {
    const chunkEnd = addDays(cursor, chunkDays - 1) > end ? end : addDays(cursor, chunkDays - 1);
    const result = await connector.run({ start: cursor, end: chunkEnd });
    chunks++;
    rows += result.meta.rowCount;
    if (!result.ok) failed++;
    const mark = result.ok ? c.green('ok  ') : c.red('FAIL');
    console.log(
      `  ${mark} ${cursor} → ${chunkEnd}  ${String(result.meta.rowCount).padStart(7)} rows${
        result.error ? c.red(`  ${result.error.message}`) : ''
      }`,
    );
    cursor = addDays(chunkEnd, 1);
  }

  console.log(`\n${chunks} chunks, ${rows.toLocaleString('en-IN')} rows, ${failed} failed.`);
  if (failed) process.exit(1);
}

function windowSpan(id: string): number {
  const w = windowFor(id);
  return daysBetween(w.start, w.end) + 1;
}

/**
 * Loads every connector's fixtures through its real transform → assert → load.
 *
 * The point is not the data — it is that `load()` runs. Until this exists, the
 * first production run of every connector is also the first execution of its
 * idempotent upsert (§27.5), on real data, with nothing to compare against.
 *
 * Runs twice by default. An upsert that is not idempotent produces a different
 * row count the second time, and that is the single cheapest way to catch it.
 */
async function seed(): Promise<void> {
  requireDb();
  const only = args.filter((a) => !a.startsWith('--'));
  const once = args.includes('--once');
  // Wide enough that the dashboard is actually populated afterwards. Seeding a
  // connector's own 2-day incremental window is correct for the connector and
  // useless for the person who then opens /sales and finds a 90-day chart with
  // two days on it.
  const days = Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 90);
  const targets = only.length ? only.map((id) => getConnector(id)!).filter(Boolean) : CONNECTORS;

  if (only.length && targets.length !== only.length) {
    console.error(c.red(`Unknown connector. Known: ${CONNECTORS.map((x) => x.id).join(', ')}`));
    process.exit(1);
  }

  console.log(c.bold(`Seeding ${targets.length} connectors from fixtures over the last ${days} days…`));
  console.log(c.dim('These rows are illustrative. Every page built on them renders as fixture.\n'));

  const counts = new Map<string, number>();
  let failed = 0;

  for (const pass of once ? [1] : [1, 2]) {
    if (!once) console.log(c.dim(pass === 1 ? '  pass 1 — insert' : '\n  pass 2 — re-run, to prove the upsert is idempotent'));
    for (const connector of targets) {
      // The wide window applies to snapshot connectors too. `bq-catalogue-master`
      // derives its fixture from the scan rows, so seeding it over one day gives
      // it one day's worth of EANs — and every gap outside that day then
      // classifies as `absent_from_master`, which is a fixture artefact
      // masquerading as the single most serious catalogue finding there is.
      const w = trailingWindow(days);
      try {
        const r = await connector.seed(w);
        const prev = counts.get(connector.id);
        const drifted = pass === 2 && prev != null && prev !== r.meta.rowCount;
        // A connector with no fixture loads zero rows and reports success. That
        // is not a pass — its `load()` has still never executed, which is the
        // one thing this command exists to prove. Say so rather than printing
        // a green zero that reads as verified.
        const mark = !r.ok ? c.red('FAIL') : r.meta.rowCount === 0 ? c.amber('none') : c.green('ok  ');
        console.log(
          `  ${mark} ${connector.id.padEnd(24)} ${String(r.meta.rowCount).padStart(7)} rows` +
            (r.ok && r.meta.rowCount === 0 ? c.dim('  no fixture — load path unexercised') : '') +
            (drifted ? c.red(`  ← was ${prev}; the upsert is not idempotent`) : ''),
        );
        if (drifted || !r.ok) failed++;
        counts.set(connector.id, r.meta.rowCount);
      } catch (e) {
        failed++;
        console.log(`  ${c.red('FAIL')} ${connector.id.padEnd(24)} ${c.red(e instanceof Error ? e.message : String(e))}`);
      }
    }
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const unexercised = [...counts.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  console.log(
    `\n${total.toLocaleString('en-IN')} rows across ${counts.size - unexercised.length} marts, ${failed} problems.`,
  );
  if (unexercised.length) {
    console.log(
      c.amber(`${unexercised.length} connectors have no fixture, so their load path is still untested: `) +
        unexercised.join(', '),
    );
  }
  if (failed) process.exit(1);
}

async function status(): Promise<void> {
  const statuses = await connectorStatuses();
  const runs = await recentRuns(10);

  const dot = { green: c.green('●'), amber: c.amber('●'), red: c.red('●'), grey: c.dim('○') };

  console.log(c.bold('\nConnectors\n'));
  for (const s of statuses) {
    const due = !s.configured
      ? c.dim('not configured')
      : s.running
        ? c.amber('running')
        : s.nextDueInMinutes === 0
          ? c.amber('due now')
          : c.dim(`due in ${fmtMinutes(s.nextDueInMinutes)}`);
    console.log(
      `  ${dot[s.health]} ${s.id.padEnd(24)} ${(s.lastRunAt ? fmtMinutes(s.freshnessMinutes ?? 0) + ' ago' : 'never').padEnd(14)} ${due}`,
    );
    if (s.lastError) console.log(c.red(`      ${s.lastError}`));
    else if (s.blockedBy && !s.configured) console.log(c.dim(`      ${s.blockedBy}`));
  }

  console.log(c.bold('\nRecent runs\n'));
  if (runs.length === 0) {
    console.log(c.dim('  none — nothing has run against this database yet'));
  }
  for (const r of runs) {
    const mark = r.status === 'success' ? c.green('ok  ') : r.status === 'fail' ? c.red('FAIL') : c.amber(r.status);
    console.log(
      `  ${mark} ${String(r.runId).padStart(4)} ${r.connector.padEnd(24)} ${String(r.rowsIngested ?? '—').padStart(7)} rows  ${c.dim(r.startedAt)}`,
    );
    if (r.error) console.log(c.red(`      ${r.error}`));
  }

  if (!getDb()) {
    console.log(
      c.amber('\n  No DATABASE_URL — this run log is process memory only and every page is on fixtures.'),
    );
  }
  console.log();
}

function fmtMinutes(m: number): string {
  if (m < 90) return `${Math.round(m)}m`;
  if (m < 60 * 48) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

const commands: Record<string, () => Promise<void>> = { run, backfill, seed, status };

const fn = commands[command ?? ''];
if (!fn) {
  console.error(`Usage: tsx scripts/etl.ts <${Object.keys(commands).join('|')}> [args]`);
  process.exit(1);
}

fn()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(c.red(e instanceof Error ? e.stack ?? e.message : String(e)));
    process.exit(1);
  });
