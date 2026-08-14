/** §4.2 — Business Health. */
import { salesModule } from '@/lib/services/modules';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { TrendLine } from '@/components/charts/TrendLine';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { FilterBar } from '@/components/filters/FilterBar';
import { getFilterOptions } from '@/lib/services/filter-options';
import { formatCount, formatINR } from '@/lib/format/currency';
import { parseFilters, type RawParams } from '@/lib/params/filters';

export const dynamic = 'force-dynamic';

export default async function SalesPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const filters = parseFilters(await searchParams, 90);
  const [mod, options] = await Promise.all([salesModule(filters), getFilterOptions()]);
  const { daily, waterfall, valueHistogram, storeMatrix, stateMatrix, newVsRepeat } = mod.data;

  // Every breakdown on this page is confirmed-only, so the count they tie to is
  // named on each of them rather than left for the reader to infer from the two
  // order cards in the strip above.
  const confirmedOrders = mod.kpis.find((k) => k.id === 'orders_confirmed')?.value ?? null;

  const storeCols: Column<(typeof storeMatrix)[number]>[] = [
    { key: 'code', header: 'Store code', numeric: true, render: (r) => r.storeCode },
    { key: 'name', header: 'Store', render: (r) => r.storeName },
    { key: 'city', header: 'City', render: (r) => r.city },
    { key: 'state', header: 'State', render: (r) => r.state },
    { key: 'orders', header: 'Orders', numeric: true, render: (r) => formatCount(r.orders) },
    { key: 'rev', header: 'Net revenue', numeric: true, render: (r) => formatINR(r.revenue) },
  ];

  const stateCols: Column<(typeof stateMatrix)[number]>[] = [
    { key: 'state', header: 'State', render: (r) => r.state },
    { key: 'region', header: 'Region', render: (r) => r.region },
    { key: 'stores', header: 'Stores', numeric: true, render: (r) => formatCount(r.stores) },
    { key: 'orders', header: 'Orders', numeric: true, render: (r) => formatCount(r.orders) },
    { key: 'rev', header: 'Net revenue', numeric: true, render: (r) => formatINR(r.revenue) },
    {
      key: 'aov',
      header: 'AOV',
      numeric: true,
      render: (r) => formatINR(r.orders ? r.revenue / r.orders : null),
    },
  ];

  const waterfallSteps = [
    { label: 'Gross (e-GMV)', value: waterfall.gross, tone: 'var(--color-ion)' },
    { label: 'Discount', value: -waterfall.discount, tone: 'var(--color-alert)' },
    { label: 'Coupon', value: -waterfall.coupon, tone: 'var(--color-warn)' },
    { label: 'Net revenue', value: waterfall.net, tone: 'var(--color-scan)' },
  ];
  const maxBar = Math.max(...waterfallSteps.map((s) => Math.abs(s.value)), 1);

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Sales"
        question="What is Companion selling, and is it growing?"
        window={mod.window}
        scope={mod.scope}
        compareLabel={mod.compareLabel}
        sources={mod.sources}
        warnings={[...mod.warnings, ...filters.warnings]}
      />

      <FilterBar window={mod.window} stores={options.stores} cities={options.cities} states={options.states} />

      <KpiStrip metrics={mod.kpis} compareLabel={mod.compareLabel} />

      <TrendLine
        title={`Orders and e-GMV — ${mod.window.start} → ${mod.window.end}`}
        subtitle="7-day rolling mean drawn behind each series"
        sourceNote={mod.sources[0]}
        series={[
          {
            id: 'orders',
            label: 'Orders',
            color: 'var(--color-ion)',
            unit: 'count',
            rollingMean: true,
            points: daily.map((d) => ({ dateKey: d.dateKey, value: d.orders })),
          },
          {
            id: 'egmv',
            label: 'e-GMV',
            color: 'var(--color-scan)',
            unit: 'inr',
            axis: 'right',
            rollingMean: true,
            points: daily.map((d) => ({ dateKey: d.dateKey, value: d.egmv })),
          },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-3">Revenue waterfall</figcaption>
          <ul className="space-y-2">
            {waterfallSteps.map((s) => (
              <li key={s.label} className="grid grid-cols-[8rem_1fr_6rem] items-center gap-3">
                <span className="text-xs text-[var(--text-muted)]">{s.label}</span>
                <div className="h-4 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                  <div
                    className="h-full"
                    style={{ width: `${(Math.abs(s.value) / maxBar) * 100}%`, background: s.tone }}
                  />
                </div>
                <span className="num text-right text-xs">{formatINR(s.value)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-2xs text-[var(--text-muted)]">
            Source: {mod.sources[0]} · gross → discount → coupon → net
          </p>
        </figure>

        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-1">
            Order value distribution — {formatCount(confirmedOrders)} confirmed orders
          </figcaption>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            The ₹0 and outlier buckets are a real data-quality tell — watch them. Bins sum to the
            Confirmed orders card, not to Orders — the §15.4 status enum is still unresolved, so both
            are shown and neither is folded into the other.
          </p>
          <ul className="space-y-1.5">
            {valueHistogram.map((b) => {
              const max = Math.max(...valueHistogram.map((x) => x.count), 1);
              return (
                <li key={b.bucket} className="grid grid-cols-[6rem_1fr_4rem] items-center gap-3">
                  <span className="num text-xs text-[var(--text-muted)]">{b.bucket}</span>
                  <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                    <div className="h-full bg-[var(--color-ion)]/60" style={{ width: `${(b.count / max) * 100}%` }} />
                  </div>
                  <span className="num text-right text-xs">{formatCount(b.count)}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-2xs text-[var(--text-muted)]">
            Source: {mod.sources[0]} · net order value, confirmed orders only
          </p>
        </figure>
      </div>

      <TrendLine
        title="New vs repeat customers"
        subtitle="Computed on hashed customer ids — no customer-level drilldown (§27.4)"
        sourceNote={mod.sources[0]}
        height={200}
        series={[
          {
            id: 'new',
            label: 'New',
            color: 'var(--color-scan)',
            unit: 'count',
            points: newVsRepeat.map((d) => ({ dateKey: d.dateKey, value: d.newCustomers })),
          },
          {
            id: 'repeat',
            label: 'Repeat',
            color: 'var(--color-ion)',
            unit: 'count',
            points: newVsRepeat.map((d) => ({ dateKey: d.dateKey, value: d.repeatCustomers })),
          },
        ]}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <DataTable
          caption={`State × revenue — ${formatCount(confirmedOrders)} confirmed orders`}
          columns={stateCols}
          rows={stateMatrix}
          rowKey={(r) => r.state}
          sourceNote="fact_orders × dim_store.state — confirmed orders only"
        />
        <DataTable
          caption={`Store × revenue — ${formatCount(confirmedOrders)} confirmed orders`}
          columns={storeCols}
          rows={storeMatrix}
          rowKey={(r) => r.storeId}
          sourceNote="fact_orders × dim_store — confirmed orders only, ties to the Confirmed orders card"
          truncation={{
            limit: 200,
            sortKey: 'net revenue',
            noun: 'stores',
            residual: (hidden) =>
              `${formatINR(hidden.reduce((a, r) => a + r.revenue, 0))} · ${formatCount(
                hidden.reduce((a, r) => a + r.orders, 0),
              )} orders`,
          }}
        />
      </div>
    </div>
  );
}
