/** §4.8 / §8 / §28 — AI Insights. */
import { hubData } from '@/lib/services/hub';
import { deterministicBrief, generateDailyBrief, isAiConfigured } from '@/lib/ai/brief';
import { ModuleHeader } from '@/components/table/DataTable';
import { AskTheData } from '@/components/insights/AskTheData';
import { RCA_RULES } from '@/lib/ai/rca';
import { cn } from '@/lib/cn';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const SEV_CLASS = {
  act: 'border-[var(--color-alert)]/50 text-[var(--color-alert)]',
  watch: 'border-[var(--color-warn)]/50 text-[var(--color-warn)]',
  info: 'border-[var(--color-edge)] text-[var(--text-muted)]',
} as const;

export default async function InsightsPage() {
  const hub = await hubData();
  const brief = isAiConfigured() ? await generateDailyBrief(hub.context) : deterministicBrief(hub.context);

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="AI Insights"
        question="What changed, why, and what should someone look at first?"
        window={hub.context.window}
        sources={['deterministic anomaly detector', brief.deterministic ? 'no model' : brief.model]}
      >
        <p className="mt-2 max-w-3xl text-xs text-[var(--text-muted)]">
          The model writes; it does not decide. Statistics decide what is anomalous, rules decide
          what the candidate causes are, and the model turns that into language. A model outage
          degrades this page to correct-but-terse, never to broken (§28.1, §28.7).
        </p>
      </ModuleHeader>

      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="label">Daily brief</h2>
          <span className="text-2xs text-[var(--text-muted)]">
            {brief.deterministic ? 'deterministic fallback' : brief.model} ·{' '}
            <span className="num">{brief.promptVersion}</span> · generated 08:00 IST and on demand
          </span>
        </div>
        <p className="text-sm leading-relaxed">{brief.body}</p>
        {brief.warnings.map((w) => (
          <p key={w} className="mt-2 text-2xs text-[var(--color-warn)]">
            {w}
          </p>
        ))}
      </section>

      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <h2 className="label mb-1">Anomalies</h2>
        <p className="mb-3 text-2xs text-[var(--text-muted)]">
          Robust z-score against a 28-day median and MAD, same-weekday week-over-week, level shift,
          zero-value, and threshold breach. Sale-period days are excluded from the baseline, because
          a 40% order spike during a sale is not an anomaly.
        </p>
        {hub.anomalies.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No metric crossed its threshold today.</p>
        ) : (
          <ul className="space-y-2">
            {hub.anomalies.map((a) => (
              <li
                key={`${a.metricId}-${a.test}`}
                className={cn('rounded border px-3 py-2', SEV_CLASS[a.severity], a.suppressed && 'opacity-50')}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-2xs uppercase tracking-wider">{a.severity}</span>
                  <code className="num text-2xs">{a.metricId}</code>
                  <span className="num text-2xs">{a.test}</span>
                  {a.zScore != null && Number.isFinite(a.zScore) && (
                    <span className="num text-2xs">z {a.zScore.toFixed(1)}</span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-[var(--text)]">{a.magnitude}</p>
                {a.suppressed && (
                  <p className="mt-1 text-2xs">
                    Suppressed — {a.suppressionReason}. Ten alerts caused by one broken pipe teaches
                    people to ignore alerts.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <h2 className="label mb-1">Where it is concentrated</h2>
        <p className="mb-3 text-2xs text-[var(--text-muted)]">
          The global sweep compares a metric against its own history, so 270 healthy stores drown
          one broken one — coverage slips 0.2pp and nothing trips. This compares each store and
          state against <em>its cohort</em> instead, which is what finds the store that is broken
          right now regardless of what it did last week.
        </p>

        <div
          className={cn(
            'mb-4 rounded border px-3 py-2 text-xs',
            hub.concentration.verdict === 'concentrated'
              ? 'border-[var(--color-warn)]/50 bg-[var(--color-warn)]/5'
              : 'border-[var(--color-edge)]',
          )}
        >
          <span className="uppercase tracking-wider text-[var(--text-muted)]">
            {hub.concentration.verdict.replace('_', ' ')}
          </span>{' '}
          <span>{hub.concentration.explanation}</span>
        </div>

        {hub.entityAnomalies.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            No store or state is a significant outlier against its cohort.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {hub.entityAnomalies.slice(0, 12).map((a) => (
              <li
                key={`${a.entityType}-${a.entityId}`}
                className="grid grid-cols-[4rem_1fr_5rem_4rem] items-baseline gap-3 text-xs"
              >
                <span className="text-2xs uppercase tracking-wider text-[var(--text-muted)]">
                  {a.entityType}
                </span>
                <span className="truncate" title={a.entityLabel}>
                  {a.entityLabel}
                </span>
                <span className="num text-right text-[var(--color-warn)]">
                  {(a.value * 100).toFixed(1)}%
                </span>
                <span
                  className="num text-right text-2xs text-[var(--text-muted)]"
                  title={`Robust z against the cohort median of ${(a.cohortMedian * 100).toFixed(1)}%`}
                >
                  z {a.zScore.toFixed(1)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-2xs text-[var(--text-muted)]">
          Source: fact_scan_daily grouped by store and state · entities below 30 scans are excluded,
          because a 40% coverage on four scans is noise that would push genuinely broken stores off
          the list
        </p>
      </section>

      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <h2 className="label mb-1">Root-cause hints</h2>
        <p className="mb-3 text-2xs text-[var(--text-muted)]">
          Rule-driven candidates. <code className="num">pipeline_not_business</code> is always checked
          first: given this system&rsquo;s history, the most likely explanation for a sudden metric
          collapse is that a pipe broke.
        </p>
        {hub.rca.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No rule conditions are currently satisfied.</p>
        ) : (
          <ul className="space-y-3">
            {hub.rca.map((hit) => (
              <li key={hit.rule.id} className="rounded border border-[var(--color-edge)] p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm">{hit.rule.hypothesis}</span>
                  <code className="num text-2xs text-[var(--text-muted)]">{hit.rule.id}</code>
                  <span className="text-2xs text-[var(--text-muted)]">{hit.confidence} confidence</span>
                </div>
                <div className="mt-1.5 grid gap-x-6 gap-y-0.5 md:grid-cols-2">
                  {hit.supporting.map((s) => (
                    <div key={s.label} className="text-2xs">
                      <span className="uppercase tracking-wider text-[var(--text-muted)]">{s.label}:</span>{' '}
                      <span className="num">{s.value}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 text-2xs text-[var(--text-muted)]">
                  Confirm or rule out with: {hit.rule.evidence.join(', ')} ·{' '}
                  <Link href={hit.rule.module} className="text-[var(--color-ion)] underline">
                    {hit.rule.module}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AskTheData />

      <details className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <summary className="label cursor-pointer">All root-cause rules ({RCA_RULES.length})</summary>
        <ul className="mt-3 space-y-2">
          {RCA_RULES.map((r) => (
            <li key={r.id} className="text-xs">
              <code className="num text-2xs">{r.id}</code>{' '}
              <span className="text-[var(--text-muted)]">when {r.when.join(' + ')}</span>
              <div className="text-[var(--text-muted)]">→ {r.hypothesis}</div>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
