/**
 * §4.9 — Connector status.
 *
 * This page is what makes the rest of the dashboard trustworthy. Given the
 * `avis_base_view` staleness incident and a catalogue report that stopped
 * generating unnoticed, it is load-bearing rather than nice-to-have.
 */
import { connectorStatuses, lineage } from '@/lib/connectors/registry';
import { recentRuns } from '@/lib/connectors/run-log';
import { CONNECTORS } from '@/lib/connectors/registry';
import { LiveRefresh, RunAllDueButton, RunButton } from '@/components/connectors/ConnectorControls';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { formatCount } from '@/lib/format/currency';
import { formatIST, relativeAge } from '@/lib/format/dates';
import type { ConnectorStatus } from '@/lib/connectors/types';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

const HEALTH_DOT = {
  green: 'bg-[var(--color-scan)]',
  amber: 'bg-[var(--color-warn)]',
  red: 'bg-[var(--color-alert)]',
  grey: 'bg-[var(--color-edge)]',
} as const;

export default async function ConnectorsPage() {
  const [statuses, runs] = await Promise.all([connectorStatuses(), recentRuns(40)]);
  const lines = lineage();
  const generatedAt = new Date().toISOString();

  const cols: Column<ConnectorStatus>[] = [
    {
      key: 'health',
      header: '',
      width: '2rem',
      render: (c) => (
        <span
          title={c.running ? 'Running now' : c.health}
          className={cn(
            'inline-block h-2.5 w-2.5 rounded-full',
            HEALTH_DOT[c.health],
            c.running && 'animate-pulse ring-2 ring-[var(--color-ion)]/50',
          )}
        />
      ),
    },
    { key: 'name', header: 'Connector', render: (c) => <span title={c.id}>{c.displayName}</span> },
    { key: 'id', header: 'Id', render: (c) => <code className="num text-2xs">{c.id}</code> },
    { key: 'pri', header: 'Priority', render: (c) => c.priority },
    { key: 'cost', header: 'Cost tier', render: (c) => c.costTier },
    {
      key: 'configured',
      header: 'Configured',
      render: (c) =>
        c.configured ? (
          <span className="text-[var(--color-scan)]">yes</span>
        ) : (
          <span className="text-[var(--text-muted)]">no</span>
        ),
    },
    { key: 'last', header: 'Last run', numeric: true, render: (c) => relativeAge(c.lastRunAt) },
    {
      key: 'sla',
      header: 'Freshness SLA',
      numeric: true,
      render: (c) => (
        <span className={c.lastRunAt && !c.withinSla ? 'text-[var(--color-warn)]' : undefined}>
          {c.freshnessSlaMinutes >= 60 ? `${Math.round(c.freshnessSlaMinutes / 60)} h` : `${c.freshnessSlaMinutes} m`}
        </span>
      ),
    },
    { key: 'rows', header: 'Rows', numeric: true, render: (c) => formatCount(c.rowsIngested) },
    {
      key: 'due',
      header: 'Next due',
      numeric: true,
      title: 'The scheduler runs a connector when it has gone longer than its freshness SLA. This is that countdown, not a fixed cron time.',
      render: (c) =>
        !c.configured ? (
          <span className="text-[var(--text-muted)]">—</span>
        ) : c.running ? (
          <span className="text-[var(--color-ion)]">running</span>
        ) : c.nextDueInMinutes === 0 ? (
          <span className="text-[var(--color-warn)]">due now</span>
        ) : (
          <span className="text-[var(--text-muted)]">
            {c.nextDueInMinutes >= 60 ? `${Math.round(c.nextDueInMinutes / 60)} h` : `${c.nextDueInMinutes} m`}
          </span>
        ),
    },
    {
      key: 'run',
      header: 'Run',
      align: 'right',
      render: (c) => <RunButton id={c.id} configured={c.configured} blockedBy={c.blockedBy} />,
    },
    {
      key: 'blocked',
      header: 'Blocked by / last error',
      render: (c) => (
        <span className={c.lastError ? 'text-[var(--color-warn)]' : 'text-[var(--text-muted)]'}>
          {c.lastError ?? c.blockedBy ?? '—'}
        </span>
      ),
    },
  ];

  const runCols: Column<(typeof runs)[number]>[] = [
    { key: 'id', header: 'Run', numeric: true, render: (r) => r.runId },
    { key: 'c', header: 'Connector', render: (r) => <code className="num text-2xs">{r.connector}</code> },
    { key: 'start', header: 'Started', numeric: true, render: (r) => formatIST(r.startedAt, { withTime: true }) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span
          className={cn(
            r.status === 'fail' && 'text-[var(--color-alert)]',
            r.status === 'warn' && 'text-[var(--color-warn)]',
            r.status === 'success' && 'text-[var(--color-scan)]',
          )}
        >
          {r.status}
        </span>
      ),
    },
    { key: 'rows', header: 'Rows', numeric: true, render: (r) => formatCount(r.rowsIngested) },
    {
      key: 'assertions',
      header: 'Assertions',
      render: (r) => {
        const fails = r.assertions.filter((a) => a.level === 'fail').length;
        const warns = r.assertions.filter((a) => a.level === 'warn').length;
        if (r.assertions.length === 0) return <span className="text-[var(--text-muted)]">—</span>;
        return (
          <span className="num text-2xs">
            {r.assertions.length} run
            {fails > 0 && <span className="text-[var(--color-alert)]"> · {fails} fail</span>}
            {warns > 0 && <span className="text-[var(--color-warn)]"> · {warns} warn</span>}
          </span>
        );
      },
    },
    { key: 'err', header: 'Detail', render: (r) => <span className="text-2xs text-[var(--text-muted)]">{r.error ?? '—'}</span> },
    {
      key: 'eph',
      header: 'Durable',
      render: (r) =>
        r.ephemeral ? (
          <span className="text-[var(--color-warn)]" title="No DATABASE_URL — this run log lives in process memory only">
            in-memory
          </span>
        ) : (
          <span className="text-[var(--color-scan)]">yes</span>
        ),
    },
  ];

  const configured = statuses.filter((s) => s.configured).length;
  const shortestSla = Math.min(...CONNECTORS.map((c) => c.freshnessSlaMinutes));

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Connectors"
        question="Where does every number come from, and is that source healthy right now?"
        sources={['etl_run_log', 'connector registry (§30)']}
      >
        <p className="mt-2 max-w-3xl text-xs text-[var(--text-muted)]">
          <span className="num">{configured}</span> of <span className="num">{statuses.length}</span>{' '}
          connectors are configured. Unconfigured connectors serve fixtures with a visible marker
          rather than blocking the build (§14.5) — nothing here blocks on a credential.
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <RunAllDueButton />
          <LiveRefresh generatedAt={generatedAt} />
        </div>
        {/* §6.4 — the schedule is the SLA, not a cron expression. Stating the
            required heartbeat here means a schedule that has fallen behind the
            SLAs is visible on the page rather than buried in vercel.json. */}
        <p className="mt-2 text-2xs text-[var(--text-muted)]">
          Scheduling is SLA-driven: <code className="num">/api/cron/tick</code> runs whatever has gone
          past its freshness SLA. The tightest SLA here is{' '}
          <span className="num">{shortestSla >= 60 ? `${Math.round(shortestSla / 60)} h` : `${shortestSla} min`}</span>
          , so the heartbeat has to fire at least that often for every SLA on this page to be met.
        </p>
      </ModuleHeader>

      <DataTable
        caption="Connector status"
        columns={cols}
        rows={statuses}
        rowKey={(c) => c.id}
        sourceNote="lib/connectors/registry.ts — build order from §30. Critical path: sheets-store-master → slack-catalogue-report → bq-orders → bq-ga4-events"
        maxHeight={560}
      />

      <DataTable
        caption="Recent runs"
        columns={runCols}
        rows={runs}
        rowKey={(r) => String(r.runId)}
        emptyMessage="No runs yet — press “run now” on any configured connector, or wait for the heartbeat"
        sourceNote="etl_run_log"
        maxHeight={360}
      />

      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <h2 className="label mb-1">Lineage — which connector produces what</h2>
        <p className="mb-3 text-2xs text-[var(--text-muted)]">
          Derived from each connector&rsquo;s declared <code className="num">powers</code>, so it
          cannot drift from the code.
        </p>
        <ul className="grid gap-x-6 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
          {lines.map((l) => (
            <li key={l.metricOrPage} className="flex justify-between gap-3 text-xs">
              <span className="truncate" title={l.metricOrPage}>
                {l.metricOrPage}
              </span>
              <span className="num shrink-0 text-2xs text-[var(--text-muted)]">{l.connectors.join(', ')}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
