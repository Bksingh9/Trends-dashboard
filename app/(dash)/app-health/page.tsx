/** §4.6 — Tech Health. */
import { appHealthModule } from '@/lib/services/modules';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { TrendLine } from '@/components/charts/TrendLine';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { FilterBar } from '@/components/filters/FilterBar';
import { formatCount, formatMs, formatPct } from '@/lib/format/currency';
import { parseFilters, type RawParams } from '@/lib/params/filters';
import { CRITICAL_ENDPOINTS } from '@/lib/db/settings';
import { isBreaching, isOverPlaceholder } from '@/lib/connectors/api-latency';
import { cn } from '@/lib/cn';

import { HelpSupportAnalytics } from '@/components/analytics/HelpSupport';

export const dynamic = 'force-dynamic';

export default async function AppHealthPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const filters = parseFilters(await searchParams, 28);
  const mod = await appHealthModule(filters);
  const { daily, latency, score, releases } = mod.data;

  const latestDate = daily.at(-1)?.dateKey ?? '';
  const latestLatency = latency.filter((l) => l.dateKey === latestDate);
  const endpointLabel = (id: string) => CRITICAL_ENDPOINTS.find((e) => e.id === id)?.label ?? id;

  const latencyCols: Column<(typeof latestLatency)[number]>[] = [
    { key: 'ep', header: 'Endpoint', render: (l) => endpointLabel(l.endpoint) },
    { key: 'p50', header: 'p50', numeric: true, render: (l) => formatMs(l.p50Ms) },
    { key: 'p90', header: 'p90', numeric: true, render: (l) => formatMs(l.p90Ms) },
    {
      key: 'p95',
      header: 'p95',
      numeric: true,
      render: (l) => (
        <span
          className={cn(
            isBreaching(l) && 'text-[var(--color-alert)]',
            isOverPlaceholder(l) && 'text-[var(--color-warn)]',
          )}
        >
          {formatMs(l.p95Ms)}
        </span>
      ),
    },
    { key: 'p99', header: 'p99', numeric: true, render: (l) => formatMs(l.p99Ms) },
    { key: 'slo', header: 'SLO p95', numeric: true, render: (l) => formatMs(l.sloP95Ms) },
    {
      key: 'conf',
      header: 'SLO status',
      render: (l) =>
        l.sloConfirmed ? (
          <span className="text-[var(--color-scan)]">confirmed</span>
        ) : (
          // A10 — placeholders must not drive alerts (§25).
          <span
            className="text-[var(--color-warn)]"
            title="Placeholder SLO — never established. Alerting stays gated until confirmed against the RPOS APIs doc and measured baselines (§13.7, A10)."
          >
            placeholder
          </span>
        ),
    },
    { key: 'calls', header: 'Calls', numeric: true, render: (l) => formatCount(l.callCount) },
    {
      key: 'err',
      header: 'Error rate',
      numeric: true,
      render: (l) => formatPct(l.callCount ? l.errorCount / l.callCount : null, { precision: 2 }),
    },
    { key: 'src', header: 'Measurement', render: (l) => (l.source === 'synthetic' ? 'synthetic probe' : 'real user') },
  ];

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="App Health"
        question="Is the software serving the journey healthy — crashes, latency, payments, releases?"
        window={mod.window}
        compareLabel={mod.compareLabel}
        sources={mod.sources}
        warnings={[...mod.warnings, ...filters.warnings]}
      />

      {/* No store or platform selector: `fact_app_health_daily` is a national
          daily aggregate with neither column, and offering a control that
          silently does nothing is worse than not offering it. */}
      <FilterBar window={mod.window} />

      <KpiStrip metrics={mod.kpis} />

      {/* §5.8 — the score must always be decomposable, never a black box. */}
      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="label">App Health Score — components</h2>
          <div className="text-2xs text-[var(--text-muted)]">
            {score.renormalised ? (
              <span className="text-[var(--color-warn)]">
                Weights renormalised across {score.totalWeightAvailable} available points — missing:{' '}
                {score.missingComponents.join(', ')}
              </span>
            ) : (
              <span>All five components present</span>
            )}
          </div>
        </div>

        <div className="mb-4 flex items-baseline gap-3">
          <span className="num text-2xl">{score.score == null ? '—' : score.score.toFixed(1)}</span>
          <span
            className={cn(
              'rounded px-2 py-0.5 text-2xs uppercase tracking-wider',
              score.band === 'green' && 'bg-[var(--color-scan)]/15 text-[var(--color-scan)]',
              score.band === 'amber' && 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
              score.band === 'red' && 'bg-[var(--color-alert)]/15 text-[var(--color-alert)]',
              score.band === 'unknown' && 'bg-[var(--color-edge)] text-[var(--text-muted)]',
            )}
          >
            {score.band}
          </span>
          <span className="text-2xs text-[var(--text-muted)]">≥90 green · 75–89 amber · &lt;75 red</span>
        </div>

        <ul className="space-y-2">
          {score.components.map((c) => (
            <li key={c.id} className="grid grid-cols-[10rem_1fr_9rem] items-center gap-3">
              <span className="text-xs">
                {c.label}
                <span className="num ml-1 text-2xs text-[var(--text-muted)]">×{c.weight}</span>
              </span>
              <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                {c.included && c.normalised != null ? (
                  <div
                    className="h-full bg-[var(--color-ion)]/70"
                    style={{ width: `${Math.max(0, Math.min(1, c.normalised)) * 100}%` }}
                  />
                ) : (
                  // Never substitute zero for missing — that turns a monitoring
                  // gap into a false alarm.
                  <div className="hatch h-full opacity-50" />
                )}
              </div>
              <span className="num text-right text-2xs">
                {c.included && c.normalised != null
                  ? `${(c.normalised * 100).toFixed(1)} / 100`
                  : 'excluded — no data'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <TrendLine
          title="Crash-free session rate"
          subtitle="Deploy markers overlaid — correlating a spike with a deploy is most of incident triage"
          sourceNote={mod.sources[0]}
          height={200}
          markers={releases}
          series={[
            {
              id: 'crash',
              label: 'Crash-free',
              color: 'var(--color-scan)',
              unit: 'ratio',
              points: daily.map((d) => ({ dateKey: d.dateKey, value: d.crashFreeRate })),
            },
          ]}
        />
        <TrendLine
          title="API error rate and backend error volume"
          sourceNote={`${mod.sources[0]} · gcp-logging`}
          height={200}
          markers={releases}
          series={[
            {
              id: 'apierr',
              label: 'API error rate',
              color: 'var(--color-alert)',
              unit: 'ratio',
              points: daily.map((d) => ({ dateKey: d.dateKey, value: d.apiErrorRate })),
            },
            {
              id: 'logs',
              label: 'ERROR logs',
              color: 'var(--color-warn)',
              unit: 'count',
              axis: 'right',
              points: daily.map((d) => ({ dateKey: d.dateKey, value: d.gcpErrorLogCount })),
            },
          ]}
        />
      </div>

      <TrendLine
        title="Payment funnel reliability"
        subtitle="The app's view of payment success — gateway-side data is not available in v1 (§26)"
        sourceNote={mod.sources[0]}
        height={200}
        series={[
          {
            id: 'pay',
            label: 'Payment success rate',
            color: 'var(--color-ion)',
            unit: 'ratio',
            points: daily.map((d) => ({ dateKey: d.dateKey, value: d.paymentSuccessRate })),
          },
        ]}
      />

      <DataTable
        caption={`API latency — five critical endpoints (${latestDate})`}
        columns={latencyCols}
        rows={latestLatency}
        rowKey={(l) => l.endpoint}
        sourceNote={`${mod.sources[1]} — SLOs are placeholders until confirmed (§13.7, A10); breach alerting is gated behind slo_confirmed`}
        maxHeight={300}
      />
      {/* §4.11 — Companion's help surface, straight from the GA4 Data API.
          It lives here rather than on /journey because a spike in help taps is
          a health signal: people ask for help when something is broken. */}
      <HelpSupportAnalytics />

    </div>
  );
}
