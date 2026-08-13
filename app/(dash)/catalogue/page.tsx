/** §4.5 — Catalogue Health. */
import { catalogueModule } from '@/lib/services/modules';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { ManhattanChart } from '@/components/charts/ManhattanChart';
import { TrendLine } from '@/components/charts/TrendLine';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { formatCount, formatPct } from '@/lib/format/currency';
import { getThresholds } from '@/lib/db/settings';
import { getScanStrip } from '@/lib/data/repository';
import { ScanStrip } from '@/components/charts/ScanStrip';
import { STORE_VISIT_AUDITS } from '@/fixtures/baselines';

export const dynamic = 'force-dynamic';

export default async function CataloguePage() {
  const [mod, t, strip] = await Promise.all([catalogueModule(), getThresholds(), getScanStrip()]);
  const { daily, gaps, ageBuckets, reasons, storeCoverage, auditedCoverage, reportGeneratedToday } = mod.data;

  const openGaps = gaps
    .filter((g) => g.status !== 'resolved' && g.status !== 'wontfix')
    .sort((a, b) => b.scanCount - a.scanCount);

  const gapCols: Column<(typeof gaps)[number]>[] = [
    { key: 'ean', header: 'EAN', numeric: true, render: (g) => g.ean },
    { key: 'first', header: 'First seen', numeric: true, render: (g) => g.firstSeen },
    { key: 'last', header: 'Last seen', numeric: true, render: (g) => g.lastSeen },
    { key: 'scans', header: 'Scans', numeric: true, render: (g) => formatCount(g.scanCount) },
    { key: 'stores', header: 'Stores', numeric: true, render: (g) => formatCount(g.storesAffected) },
    {
      key: 'reason',
      header: 'Suspected reason',
      render: (g) => (
        <span title="A hypothesis from the catalogue-master join (§20.3), not a confirmed cause">
          {g.suspectedReason}
        </span>
      ),
    },
    { key: 'dir', header: 'Direction', render: (g) => g.reasonDirection ?? '—' },
    { key: 'status', header: 'Status', render: (g) => g.status },
    { key: 'owner', header: 'Owner', render: (g) => g.owner ?? <span className="text-[var(--color-warn)]">unowned</span> },
  ];

  const storeCols: Column<(typeof storeCoverage)[number]>[] = [
    { key: 'store', header: 'Store', render: (s) => (s as { storeName?: string }).storeName ?? s.storeId },
    { key: 'scans', header: 'Distinct EANs', numeric: true, render: (s) => formatCount(s.scans) },
    { key: 'failed', header: 'Failed', numeric: true, render: (s) => formatCount(s.failed) },
    {
      key: 'cov',
      header: 'Coverage',
      numeric: true,
      render: (s) => (
        <span className={(s.coverage ?? 1) < t.coverage_target ? 'text-[var(--color-warn)]' : undefined}>
          {formatPct(s.coverage, { precision: 2 })}
        </span>
      ),
    },
  ];

  const maxReason = Math.max(...reasons.map((r) => r.count), 1);
  const maxAge = Math.max(...ageBuckets.map((b) => b.count), 1);

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Catalogue"
        question="Of what customers tried to scan, how much worked — and why did the rest fail?"
        window={mod.window}
        sources={mod.sources}
        warnings={mod.warnings}
      />

      <ScanStrip data={strip.rows} state={strip.state} liveness={strip.state === 'fixture' ? 'fixture' : 'intraday'} compact />

      {/* §18.6 — the daily report has silently stopped generating before. */}
      {reportGeneratedToday !== true && (
        <div className="rounded border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2 text-xs">
          <span className="font-semibold text-[var(--color-warn)]">Report health</span>{' '}
          <span className="text-[var(--text-muted)]">
            — no Scan Catalog Daily Report ingested for the latest day (expected by 09:00 IST). Check
            Tatsu and the upstream GA4→BQ job.
          </span>
        </div>
      )}

      <KpiStrip metrics={mod.kpis} compareLabel="vs previous period" />

      {/* §16.5.2 — three different measurements that will disagree. The
          difference between them is itself the finding. */}
      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <h2 className="label mb-1">Three coverage measurements — never blended</h2>
        <p className="mb-3 text-2xs text-[var(--text-muted)]">
          Customers mostly scan things that work; an auditor scans a random shelf. The gap between
          these is not an error.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            {
              label: 'Scan-observed',
              value: mod.kpis.find((k) => k.id === 'unique_coverage')?.value ?? null,
              denom: 'Valid customer scan attempts',
              answers: 'Of what customers tried to scan, how much worked',
            },
            {
              label: 'Store-visit audited',
              value: auditedCoverage,
              denom: 'Random shelf sample by an auditor',
              answers: "Of what's on the shelf, how much is scannable",
            },
            {
              label: 'True coverage',
              value: null,
              denom: 'SAP catalogue master',
              answers: 'Of what should exist, how much does — feed not wired (§13.9)',
            },
          ].map((c) => (
            <div key={c.label} className="rounded border border-[var(--color-edge)] p-3">
              <div className="label mb-1">{c.label}</div>
              <div className="num text-xl">{c.value == null ? '—' : formatPct(c.value, { precision: 1 })}</div>
              <div className="mt-1 text-2xs text-[var(--text-muted)]">Denominator: {c.denom}</div>
              <div className="mt-0.5 text-2xs text-[var(--text-muted)]">{c.answers}</div>
            </div>
          ))}
        </div>
      </section>

      <ManhattanChart
        data={daily.map((d) => ({
          dateKey: d.dateKey,
          uniqueScans: d.uniqueScans,
          uniqueFailed: d.uniqueFailed,
          uniqueCoverage: d.uniqueCoverage,
          reportGenerated: d.reportGenerated,
          source: d.source,
        }))}
        target={t.coverage_target}
      />

      <TrendLine
        title="Coverage trend"
        subtitle={`Target ${(t.coverage_target * 100).toFixed(0)}% drawn as the dashed line`}
        sourceNote={mod.sources[0]}
        height={200}
        reference={{ value: t.coverage_target, label: 'target' }}
        series={[
          {
            id: 'cov',
            label: 'Unique coverage',
            color: 'var(--color-scan)',
            unit: 'ratio',
            points: daily.map((d) => ({
              dateKey: d.dateKey,
              value: d.reportGenerated === null ? null : d.uniqueCoverage,
            })),
          },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-1">Gap reasons</figcaption>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            Split inbound (mapping/ingestion) vs outbound (assignment/state). Config-driven taxonomy.
          </p>
          <ul className="space-y-2">
            {reasons.map((r) => (
              <li key={r.reason} className="grid grid-cols-[13rem_1fr_3.5rem] items-center gap-3">
                <span className="truncate text-xs" title={r.reason}>
                  {r.reason}
                  <span className="ml-1 text-2xs text-[var(--text-muted)]">({r.direction ?? '—'})</span>
                </span>
                <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                  <div
                    className="h-full"
                    style={{
                      width: `${(r.count / maxReason) * 100}%`,
                      background: r.direction === 'inbound' ? 'var(--color-warn)' : 'var(--color-alert)',
                    }}
                  />
                </div>
                <span className="num text-right text-xs">{formatCount(r.count)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-2xs text-[var(--text-muted)]">
            Source: fact_catalogue_gap × dim_product (bq-catalogue-master) · reason is a hypothesis
            from the catalogue-master join, confirmed by a human in the register&rsquo;s status field
          </p>
        </figure>

        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-1">Missing-EAN aging</figcaption>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            A miss that is 30 days old is an ownership failure, not a data issue.
          </p>
          <ul className="space-y-2">
            {ageBuckets.map((b) => (
              <li key={b.bucket} className="grid grid-cols-[5rem_1fr_4rem] items-center gap-3">
                <span className="num text-xs text-[var(--text-muted)]">{b.bucket}</span>
                <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                  <div
                    className="h-full"
                    style={{
                      width: `${(b.count / maxAge) * 100}%`,
                      background: b.bucket === '30 d+' ? 'var(--color-alert)' : 'var(--color-ion)',
                    }}
                  />
                </div>
                <span className="num text-right text-xs">{formatCount(b.count)}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-[var(--color-edge)] pt-3">
            <div className="label mb-2">Store-visit audits</div>
            <ul className="space-y-1">
              {STORE_VISIT_AUDITS.map((v) => (
                <li key={v.storeLabel} className="flex justify-between gap-2 text-2xs">
                  <span className="truncate text-[var(--text-muted)]" title={v.storeLabel}>
                    {v.storeLabel}
                  </span>
                  <span className="num shrink-0">
                    {v.itemsFailed}/{v.itemsScanned} failed ={' '}
                    {formatPct((v.itemsScanned - v.itemsFailed) / v.itemsScanned, { precision: 0 })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-3 text-2xs text-[var(--text-muted)]">
            Source: fact_catalogue_gap (aging) · fact_store_visit_audit (visits) · auditor shelf
            samples are a different measurement from scan-observed coverage (§16.5.2)
          </p>
        </figure>
      </div>

      <DataTable
        caption="Store × coverage — is the gap systemic or store-specific?"
        columns={storeCols}
        rows={storeCoverage.slice(0, 60)}
        rowKey={(s) => s.storeId}
        sourceNote="fact_scan_daily grouped by store_id"
        maxHeight={320}
      />

      <DataTable
        caption="Missing EAN register"
        columns={gapCols}
        rows={openGaps.slice(0, 400)}
        rowKey={(g) => g.ean}
        sourceNote="fact_catalogue_gap × dim_product — top 400 open gaps by scan volume"
        maxHeight={520}
      />
    </div>
  );
}
