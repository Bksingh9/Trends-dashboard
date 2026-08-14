/**
 * §4.4 — Store Adoption.
 *
 * Built to run the daily NOC operating rhythm, so it carries operational fields
 * alongside the analytics ones, and the dark-store worklist is a call list
 * rather than a chart.
 */
import { storesModule } from '@/lib/services/modules';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { formatCount, formatINR, formatPct } from '@/lib/format/currency';
import { trailingWindow } from '@/lib/format/dates';
import { entryUrl } from '@/lib/services/deeplink';
import { CopyButton } from '@/components/shell/CopyButton';
import type { StoreRollup } from '@/lib/metrics/compute';

export const dynamic = 'force-dynamic';

export default async function StoresPage() {
  const mod = await storesModule(trailingWindow(28));
  const { rows, states, darkWorklist, ops, cohort } = mod.data;

  const tri = (v: boolean | null | undefined) =>
    v === true ? (
      <span className="text-[var(--color-scan)]">yes</span>
    ) : v === false ? (
      <span className="text-[var(--color-alert)]">no</span>
    ) : (
      // A third of stores genuinely have no record. That is a real gap and
      // renders as unknown, never as false.
      <span className="text-[var(--text-muted)]" title="No record — not the same as 'no'">
        —
      </span>
    );

  const storeCols: Column<StoreRollup>[] = [
    { key: 'code', header: 'Code', numeric: true, width: '5rem', render: (r) => r.storeCode },
    { key: 'name', header: 'Store', render: (r) => r.storeName },
    { key: 'city', header: 'City', render: (r) => r.city },
    { key: 'state', header: 'State', render: (r) => r.state },
    { key: 'act', header: 'Activated', numeric: true, render: (r) => r.activatedOn ?? '—' },
    {
      key: 'o0',
      header: mod.window.end,
      title: "Orders on the window's last day. Trailing windows end yesterday, because today is still partial.",
      numeric: true,
      render: (r) => formatCount(r.ordersOnLatestDay),
    },
    { key: 'o7', header: '7d', numeric: true, render: (r) => formatCount(r.orders7d) },
    { key: 'o28', header: '28d', numeric: true, render: (r) => formatCount(r.orders28d) },
    { key: 'rev', header: 'Revenue 28d', numeric: true, render: (r) => formatINR(r.revenue28d) },
    { key: 'cov', header: 'Coverage', numeric: true, render: (r) => formatPct(r.coverage) },
    {
      key: 'dark',
      header: 'Days dark',
      numeric: true,
      render: (r) =>
        r.daysSinceLastOrder == null ? (
          <span className="text-[var(--text-muted)]">never</span>
        ) : (
          <span className={r.daysSinceLastOrder >= 7 ? 'text-[var(--color-alert)]' : undefined}>
            {r.daysSinceLastOrder}
          </span>
        ),
    },
    { key: 'qr', header: 'QR/VM', render: (r) => tri(ops.get(r.storeId)?.qrVmPlaced) },
    { key: 'trained', header: 'Trained', render: (r) => tri(ops.get(r.storeId)?.staffTrained) },
    {
      key: 'open',
      header: 'Open in app',
      title: 'Live deep link to this store’s Companion journey inside AJIO',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <a
            href={entryUrl(r.storeId)}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-ion)] underline"
          >
            open
          </a>
          <CopyButton value={entryUrl(r.storeId)} label="copy link" />
        </div>
      ),
    },
  ];

  const stateCols: Column<(typeof states)[number]>[] = [
    { key: 's', header: 'State', render: (r) => r.state },
    { key: 'r', header: 'Region', render: (r) => r.region },
    { key: 'live', header: 'Live', numeric: true, render: (r) => formatCount(r.storesLive) },
    { key: 'act', header: 'Active 7d', numeric: true, render: (r) => formatCount(r.storesActive) },
    {
      key: 'dark',
      header: 'Dark',
      numeric: true,
      render: (r) => (
        <span className={r.storesDark > r.storesLive * 0.3 ? 'text-[var(--color-alert)]' : undefined}>
          {formatCount(r.storesDark)}
        </span>
      ),
    },
    { key: 'o', header: 'Orders 28d', numeric: true, render: (r) => formatCount(r.orders28d) },
    { key: 'rev', header: 'Revenue 28d', numeric: true, render: (r) => formatINR(r.revenue28d) },
    { key: 'cov', header: 'Coverage', numeric: true, render: (r) => formatPct(r.coverage) },
    {
      key: 'pen',
      header: 'Estate activated',
      numeric: true,
      render: (r) => formatPct(r.activationPct),
      title: 'Companion-live stores as a share of all Trends stores in this state',
    },
  ];

  const darkCols: Column<StoreRollup>[] = [
    { key: 'code', header: 'Code', numeric: true, render: (r) => r.storeCode },
    { key: 'name', header: 'Store', render: (r) => r.storeName },
    { key: 'city', header: 'City', render: (r) => r.city },
    { key: 'state', header: 'State', render: (r) => r.state },
    {
      key: 'days',
      header: 'Days dark',
      numeric: true,
      render: (r) => (
        <span className="text-[var(--color-alert)]">{r.daysSinceLastOrder ?? 'never ordered'}</span>
      ),
    },
    { key: 'foot', header: 'Footfall/day', numeric: true, render: (r) => formatCount(ops.get(r.storeId)?.footfallDaily ?? null) },
    { key: 'owner', header: 'NOC owner', render: (r) => ops.get(r.storeId)?.nocOwner ?? '—' },
    {
      key: 'open',
      header: 'Open in app',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <a href={entryUrl(r.storeId)} target="_blank" rel="noreferrer" className="text-[var(--color-ion)] underline">
            open
          </a>
          <CopyButton value={entryUrl(r.storeId)} label="copy" />
        </div>
      ),
    },
  ];

  const maxCohort = Math.max(...cohort.map((c) => c.ordersPerStore), 1);

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Stores"
        question="Which stores are using Companion, and which have gone dark?"
        window={mod.window}
        sources={mod.sources}
        warnings={mod.warnings}
      />

      <KpiStrip metrics={mod.kpis} />

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <DataTable
          caption="State rollup"
          columns={stateCols}
          rows={states}
          rowKey={(r) => r.state}
          sourceNote="dim_store.state × fact_orders × fact_scan_daily"
          maxHeight={380}
        />

        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-1">Activation cohort</figcaption>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            Orders per store by weeks since activation — does adoption stick?
          </p>
          <ul className="space-y-1">
            {cohort.slice(0, 14).map((c) => (
              <li key={c.weeksSinceActivation} className="grid grid-cols-[3rem_1fr_3rem] items-center gap-2">
                <span className="num text-2xs text-[var(--text-muted)]">w{c.weeksSinceActivation}</span>
                <div className="h-2.5 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                  <div
                    className="h-full bg-[var(--color-scan)]/70"
                    style={{ width: `${(c.ordersPerStore / maxCohort) * 100}%` }}
                  />
                </div>
                <span className="num text-right text-2xs">{c.ordersPerStore.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </figure>
      </div>

      <DataTable
        caption="Dark-store worklist — zero orders in 7 days"
        columns={darkCols}
        rows={darkWorklist}
        rowKey={(r) => r.storeId}
        truncation={{
          limit: 100,
          sortKey: 'days dark, longest first',
          noun: 'dark stores',
          residual: (hidden) =>
            `${formatCount(
              hidden.reduce((a, r) => a + (ops.get(r.storeId)?.footfallDaily ?? 0), 0),
            )} footfall/day behind them`,
        }}
        sourceNote="fact_store_adoption_daily × dim_store × fact_store_ops"
        emptyMessage="No dark stores — every live store transacted this week"
        maxHeight={360}
      />

      <DataTable
        caption="Store operating table"
        columns={storeCols}
        rows={rows}
        rowKey={(r) => r.storeId}
        sourceNote="dim_store × fact_orders × fact_scan_daily × fact_store_ops (QR/VM and training are manual-entry)"
        maxHeight={560}
      />
    </div>
  );
}
