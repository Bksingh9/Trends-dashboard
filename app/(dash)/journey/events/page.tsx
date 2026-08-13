/**
 * §13.10 — the registered Companion event list, published back to the team.
 *
 * Prince Chaudhary asked for this on 6 Aug and it appears not to have been
 * answered. This page is the answer, and it stays honest about what is
 * confirmed versus merely expected.
 */
import Link from 'next/link';
import {
  eventDictionary,
  gapImpact,
  instrumentationGaps,
  KIOSK_AUTO_PARAMS,
  SCAN_EVENT_PARAMS,
} from '@/lib/services/event-dictionary';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

const STATUS_CLASS = {
  confirmed: 'text-[var(--color-scan)]',
  expected: 'text-[var(--text-muted)]',
  unverified: 'text-[var(--color-warn)]',
  missing: 'text-[var(--color-alert)]',
} as const;

export default function EventDictionaryPage() {
  const events = eventDictionary();
  const gaps = instrumentationGaps();
  const impact = gapImpact();

  const eventCols: Column<(typeof events)[number]>[] = [
    { key: 'name', header: 'Event', render: (e) => <code className="num">{e.name}</code> },
    { key: 'step', header: 'Journey step', render: (e) => e.step ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (e) => <span className={cn(STATUS_CLASS[e.status])}>{e.status}</span>,
    },
    {
      key: 'kiosk',
      header: 'In Kiosk taxonomy',
      render: (e) =>
        e.inKioskTaxonomy ? (
          <span className="text-[var(--color-scan)]">yes</span>
        ) : (
          <span className="text-[var(--text-muted)]">no</span>
        ),
    },
    {
      key: 'params',
      header: 'Parameters',
      render: (e) => <span className="num text-2xs">{e.params.join(', ')}</span>,
    },
    { key: 'note', header: 'Note', render: (e) => <span className="text-2xs text-[var(--text-muted)]">{e.note ?? ''}</span> },
  ];

  const gapCols: Column<(typeof gaps)[number]>[] = [
    {
      key: 'p',
      header: 'Priority',
      render: (g) => (
        <span className={g.priority === 'P0' ? 'text-[var(--color-alert)]' : g.priority === 'P1' ? 'text-[var(--color-warn)]' : ''}>
          {g.priority}
        </span>
      ),
    },
    { key: 'e', header: 'Event to instrument', render: (g) => <code className="num">{g.event}</code> },
    { key: 'w', header: 'What it unblocks', render: (g) => g.why },
  ];

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Event dictionary"
        question="Which GA4 events does Companion actually fire, and what is missing?"
        sources={['§5.2 funnel taxonomy', '§5.9 Kiosk target taxonomy', 'GA4 export (once wired)']}
      >
        <p className="mt-2 max-w-3xl text-xs text-[var(--text-muted)]">
          Derived, not hand-maintained. Once <code className="num">bq-ga4-events</code> is wired, the
          authoritative inventory query in §16.1 replaces the expected column with observed volumes —
          and settles this list for good. Until then, <span className="text-[var(--color-warn)]">unverified</span>{' '}
          means exactly that: a document named it, and nobody has checked it against code or data.
        </p>
      </ModuleHeader>

      <div className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 p-4">
        <h2 className="label mb-1 text-[var(--color-warn)]">How to settle this list</h2>
        <p className="mb-2 text-xs text-[var(--text-muted)]">
          Two sources, in order of authority. Neither needs anyone&rsquo;s permission beyond BigQuery
          access.
        </p>
        <ol className="space-y-1.5 text-xs text-[var(--text-muted)]">
          <li>
            <span className="text-[var(--text)]">1. The GA4 export.</span> Run the inventory query
            (§16.1) once <code className="num">BQ_GA4_DATASET</code> is known. It returns every event
            name with a volume, which is the ground truth.
          </li>
          <li>
            <span className="text-[var(--text)]">2. The code.</span> Read{' '}
            <code className="num">hashira-theme</code> GTM constants. That produces the authoritative
            list of what the app <em>intends</em> to fire, and any discrepancy against the export is
            itself a finding.
          </li>
        </ol>
      </div>

      <DataTable
        caption="Companion funnel events"
        columns={eventCols}
        rows={events}
        rowKey={(e) => e.name}
        sourceNote="§5.2 — event names marked 'unverified' are expected from the Kiosk schema and must be checked against hashira-theme"
        maxHeight={480}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-1">Scan event parameters</h2>
          <p className="mb-3 text-2xs text-[var(--color-warn)]">
            Verified May 2026 in a <strong>pre-production</strong> environment. That is provenance,
            not proof — each must be confirmed present <em>and populated</em> in the production
            export before the funnel or coverage can be trusted (A5, §13.11). A parameter that fires
            in pre-prod but arrives empty in production is the most expensive failure mode available
            here, because the funnel renders plausible numbers on a broken dimension.
          </p>
          <ul className="space-y-1.5">
            {SCAN_EVENT_PARAMS.map((p) => (
              <li key={p.param} className="flex items-baseline justify-between gap-3 text-xs">
                <code className="num">{p.param}</code>
                <span className="text-right text-2xs text-[var(--text-muted)]">{p.note}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-[var(--color-edge)] pt-2 text-2xs text-[var(--text-muted)]">
            Kiosk auto-injects <code className="num">{KIOSK_AUTO_PARAMS.join(', ')}</code> on every
            event. Companion should match.
          </p>
        </section>

        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-1">What each gap costs</h2>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            The metric on the left cannot be computed honestly until the events on the right exist.
          </p>
          <ul className="space-y-2">
            {impact.map((i) => (
              <li key={i.metric} className="text-xs">
                <div>{i.metric}</div>
                <div className="num text-2xs text-[var(--color-warn)]">
                  blocked by: {i.blockedBy.join(', ')}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <DataTable
        caption={`Instrumentation backlog — ${gaps.length} events in the Kiosk taxonomy that Companion lacks`}
        columns={gapCols}
        rows={gaps}
        rowKey={(g) => g.event}
        sourceNote="§5.9 — the Kiosk/Lyra container is a different app and is never queried, but it is the right target taxonomy. Each row here is a sprint ticket waiting to be written."
        maxHeight={520}
      />

      <p className="text-2xs text-[var(--text-muted)]">
        Back to{' '}
        <Link href="/journey" className="text-[var(--color-ion)] underline">
          /journey
        </Link>
      </p>
    </div>
  );
}
