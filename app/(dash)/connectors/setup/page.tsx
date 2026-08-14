/**
 * Connection setup — the live preflight, rendered.
 *
 * This is the page to open the moment a credential lands. It attempts the real
 * call for every connector and reports what actually happened, ranked by which
 * environment variable unblocks the most.
 */
import Link from 'next/link';
import { runDoctor, type Check } from '@/lib/connectors/doctor';
import { ModuleHeader } from '@/components/table/DataTable';
import { CopyButton } from '@/components/shell/CopyButton';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const STATUS: Record<Check['status'], { dot: string; label: string; tone: string }> = {
  ok: { dot: 'bg-[var(--color-scan)]', label: 'connected', tone: 'text-[var(--color-scan)]' },
  blocked: { dot: 'bg-[var(--color-warn)]', label: 'needs a credential', tone: 'text-[var(--color-warn)]' },
  failed: { dot: 'bg-[var(--color-alert)]', label: 'failing', tone: 'text-[var(--color-alert)]' },
  skipped: { dot: 'bg-[var(--color-edge)]', label: 'module off', tone: 'text-[var(--text-muted)]' },
};

export default async function SetupPage() {
  const report = await runDoctor();
  const { ok, blocked, failed, skipped } = report.summary;

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Connection setup"
        question="What is actually connected, what is missing, and what should I set next?"
        sources={['live preflight — each check attempts a real request']}
      >
        <p className="mt-2 max-w-3xl text-xs text-[var(--text-muted)]">
          These are not config inspections. Each one attempts the real call, because both silent
          failures this system has already produced looked perfectly healthy from the config side.
          Run the same thing on the command line with <code className="num">npm run doctor</code>.
        </p>
      </ModuleHeader>

      <div className="flex flex-wrap gap-3">
        {[
          ['connected', ok, 'text-[var(--color-scan)]'],
          ['needs a credential', blocked, 'text-[var(--color-warn)]'],
          ['failing', failed, 'text-[var(--color-alert)]'],
          ['module off', skipped, 'text-[var(--text-muted)]'],
        ].map(([label, n, tone]) => (
          <div key={String(label)} className="rounded border border-[var(--color-edge)] bg-[var(--surface)] px-4 py-3">
            <div className={cn('num text-xl', tone as string)}>{n as number}</div>
            <div className="label">{String(label)}</div>
          </div>
        ))}
        <div className="rounded border border-[var(--color-edge)] bg-[var(--surface)] px-4 py-3">
          <div className="num text-xl">
            {report.connectorsConfigured}/{report.connectorsTotal}
          </div>
          <div className="label">connectors configured</div>
        </div>
      </div>

      {report.unblockOrder.length > 0 && (
        <section className="rounded border border-[var(--color-ion)]/40 bg-[var(--color-ion)]/5 p-4">
          <h2 className="label mb-1">Set these next — highest leverage first</h2>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            Ranked by how many checks each one unblocks, so the first row is always the best use of
            the next five minutes.
          </p>
          <ol className="space-y-2">
            {report.unblockOrder.map((u, i) => (
              <li key={u.envVar} className="flex flex-wrap items-baseline gap-2">
                <span className="num text-2xs text-[var(--text-muted)]">{i + 1}.</span>
                <code className="num rounded bg-[var(--color-ink)] px-1.5 py-0.5 text-xs">{u.envVar}</code>
                <CopyButton value={u.envVar} label="copy" />
                <span className="text-2xs text-[var(--text-muted)]">
                  unblocks {u.unblocks.length}: {u.unblocks.join(', ')}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="space-y-2">
        {report.checks.map((c) => (
          <div
            key={c.id}
            className={cn(
              'rounded border bg-[var(--surface)] p-4',
              c.status === 'failed' ? 'border-[var(--color-alert)]/40' : 'border-[var(--color-edge)]',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', STATUS[c.status].dot)} />
              <span className="text-sm">{c.label}</span>
              <span className={cn('text-2xs uppercase tracking-wider', STATUS[c.status].tone)}>
                {STATUS[c.status].label}
              </span>
              {c.elapsedMs != null && (
                <span className="num ml-auto text-2xs text-[var(--text-muted)]">{c.elapsedMs} ms</span>
              )}
            </div>

            <p className="mt-1.5 text-xs text-[var(--text-muted)]">{c.detail}</p>

            {c.needs?.length ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-2xs text-[var(--text-muted)]">needs</span>
                {c.needs.map((n) => (
                  <code key={n} className="num rounded bg-[var(--color-ink)] px-1 text-2xs">
                    {n}
                  </code>
                ))}
              </div>
            ) : null}

            {c.nextStep && (
              <p className="mt-2 border-l-2 border-[var(--color-ion)]/50 pl-2 text-2xs text-[var(--text)]">
                {c.nextStep}
              </p>
            )}

            {c.closes && (
              <p className="mt-1.5 text-2xs text-[var(--text-muted)]">
                Closes <span className="num">{c.closes}</span>
              </p>
            )}
          </div>
        ))}
      </section>

      <p className="text-2xs text-[var(--text-muted)]">
        Full status and lineage on{' '}
        <Link href="/connectors" className="text-[var(--color-ion)] underline">
          /connectors
        </Link>{' '}
        · open assumptions in <code className="num">docs/decisions/ADR-000-open-assumptions.md</code>
      </p>
    </div>
  );
}
