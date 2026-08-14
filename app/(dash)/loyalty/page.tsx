/**
 * Reliance One 2.0 Loyalty — ADR-001.
 *
 * §0 excludes Loyalty from v1. This module exists on explicit PM direction after
 * the conflict was raised, and it says so on the page rather than quietly
 * presenting itself as scoped work.
 */
import Link from 'next/link';
import { loyaltyModule } from '@/lib/services/loyalty';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { TrendLine } from '@/components/charts/TrendLine';
import { ModuleHeader } from '@/components/table/DataTable';
import { config } from '@/lib/config';
import { LOYALTY_PROPERTY_ID, LOYALTY_DEFAULT_PROJECT } from '@/lib/connectors/bq-loyalty';

export const dynamic = 'force-dynamic';

export default async function LoyaltyPage() {
  const mod = await loyaltyModule();

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Loyalty"
        question="Is Reliance One 2.0 enrolling, linking and being redeemed against?"
        window={mod.window}
        sources={mod.sources}
        warnings={mod.warnings}
      />

      {/* The scope departure, stated on the page itself. */}
      <div className="rounded border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2 text-xs">
        <span className="font-semibold text-[var(--color-warn)]">Outside the v1 spec</span>{' '}
        <span className="text-[var(--text-muted)]">
          — §0 excludes Loyalty from v1. This module was added on explicit direction; the decision and
          its consequences are recorded in{' '}
          <code className="num">docs/decisions/ADR-001-loyalty-scope.md</code>. Every metric here is a{' '}
          <strong>proposal</strong>: the spec records the Loyalty property id (
          <code className="num">{LOYALTY_PROPERTY_ID}</code>) and nothing about its events, so the
          taxonomy behind these numbers is unverified until the §16.1 inventory query settles it.
          Loyalty is deliberately excluded from the App Health Score, the hub health lights, and the
          AI brief.
        </span>
      </div>

      {!config.moduleLoyalty && (
        <div className="rounded border border-[var(--color-edge)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <code className="num">MODULE_LOYALTY</code> is off, so this module is hidden from the rail
          and the connector does not run. Set it to <code className="num">true</code> along with{' '}
          <code className="num">BQ_LOYALTY_PROJECT</code> (default{' '}
          <code className="num">{LOYALTY_DEFAULT_PROJECT}</code>) and{' '}
          <code className="num">BQ_LOYALTY_DATASET</code> to enable it.
        </div>
      )}

      <KpiStrip metrics={mod.kpis} compareLabel="vs previous period" />

      {mod.data.unmappedEvents.length > 0 && (
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-1">Unmapped events — the taxonomy gap</h2>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            Events present in the Loyalty export that the proposed taxonomy does not account for.
            Each one is either a metric this module should have, or a name that needs correcting.
            Surfacing them beats silently dropping them.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {mod.data.unmappedEvents.map((e) => (
              <li key={e}>
                <code className="num rounded border border-[var(--color-warn)]/40 bg-[var(--color-ink)] px-1.5 py-0.5 text-2xs text-[var(--color-warn)]">
                  {e}
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <TrendLine
        title="Enrolments and account links"
        subtitle="Loyalty-side counts. Not joined to Companion orders — the two are different populations."
        sourceNote={mod.sources[0]}
        height={220}
        series={[
          {
            id: 'enrol',
            label: 'Enrolments',
            color: 'var(--color-scan)',
            unit: 'count',
            rollingMean: true,
            points: mod.data.daily.map((d) => ({ dateKey: d.dateKey, value: d.enrolments })),
          },
          {
            id: 'links',
            label: 'Accounts linked',
            color: 'var(--color-ion)',
            unit: 'count',
            rollingMean: true,
            points: mod.data.daily.map((d) => ({ dateKey: d.dateKey, value: d.links })),
          },
        ]}
      />

      <TrendLine
        title="Points earned vs redeemed"
        subtitle="Unredeemed points are a liability accruing on the balance sheet, so the gap matters as much as either line."
        sourceNote={mod.sources[0]}
        height={220}
        series={[
          {
            id: 'earned',
            label: 'Earned',
            color: 'var(--color-warn)',
            unit: 'count',
            points: mod.data.daily.map((d) => ({ dateKey: d.dateKey, value: d.earned })),
          },
          {
            id: 'redeemed',
            label: 'Redeemed',
            color: 'var(--color-scan)',
            unit: 'count',
            points: mod.data.daily.map((d) => ({ dateKey: d.dateKey, value: d.redeemed })),
          },
        ]}
      />

      <p className="text-2xs text-[var(--text-muted)]">
        Settle the taxonomy with the inventory query on{' '}
        <Link href="/connectors/setup" className="text-[var(--color-ion)] underline">
          /connectors/setup
        </Link>
        , then reconcile these definitions against what the export actually contains.
      </p>
    </div>
  );
}
