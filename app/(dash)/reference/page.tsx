/**
 * §4.10 — Environments, deep links, and test data.
 *
 * The working reference the team currently keeps in scattered Slack canvases
 * lives here instead.
 */
import { runCanary } from '@/lib/connectors/test-ean-canary';
import {
  checkReachability,
  DOCUMENT_INDEX,
  ENVIRONMENTS,
  entryUrl,
  IDENTIFIERS,
  qrSvg,
  REPO_INDEX,
} from '@/lib/services/deeplink';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { CopyButton } from '@/components/shell/CopyButton';
import { config } from '@/lib/config';
import { trailingWindow } from '@/lib/format/dates';
import { STORE_VISIT_AUDITS } from '@/fixtures/baselines';
import { formatPct } from '@/lib/format/currency';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

export default async function ReferencePage() {
  const [{ rows: canary }, reachability, defaultQr] = await Promise.all([
    runCanary(trailingWindow(14)),
    Promise.all(ENVIRONMENTS.map(checkReachability)),
    qrSvg(entryUrl(config.defaultTestStoreId), 132),
  ]);

  const canaryCols: Column<(typeof canary)[number]>[] = [
    { key: 'ean', header: 'EAN', numeric: true, render: (c) => c.ean },
    { key: 'exp', header: 'Expected', render: (c) => c.expectedResult },
    { key: 'feat', header: 'Feature', render: (c) => c.feature ?? '—' },
    { key: 'act', header: 'Last actual', render: (c) => c.lastActualResult ?? '—' },
    { key: 'on', header: 'Last seen', numeric: true, render: (c) => c.lastActualOn ?? '—' },
    {
      key: 'flag',
      header: 'Canary',
      render: (c) =>
        c.regressed ? (
          <span className="text-[var(--color-alert)]" title="A known-good product has started failing to scan — almost always an upstream catalogue break">
            REGRESSED
          </span>
        ) : c.recovered ? (
          <span className="text-[var(--color-scan)]">recovered</span>
        ) : c.lastActualResult == null ? (
          <span className="text-[var(--text-muted)]">not seen in window</span>
        ) : (
          <span className="text-[var(--color-scan)]">as expected</span>
        ),
    },
    { key: 'src', header: 'Source', render: (c) => <span className="text-2xs text-[var(--text-muted)]">{c.sourceNote ?? c.source}</span> },
  ];

  const regressions = canary.filter((c) => c.regressed);
  const docGroups = [...new Set(DOCUMENT_INDEX.map((d) => d.group))];

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Reference"
        question="Where do I open this store, what should scan, and where is the doc?"
        sources={['dim_environment', 'dim_test_ean', 'fact_store_visit_audit']}
      />

      {regressions.length > 0 && (
        <div className="rounded border border-[var(--color-alert)]/50 bg-[var(--color-alert)]/10 px-3 py-2 text-xs">
          <span className="font-semibold text-[var(--color-alert)]">
            {regressions.length} canary EAN{regressions.length > 1 ? 's have' : ' has'} regressed
          </span>{' '}
          <span className="text-[var(--text-muted)]">
            — a known-good product has started returning not_found. This usually shows up here before
            the aggregate coverage number moves enough to trip a z-score.
          </span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-1">Deep-link builder</h2>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            Prod entry point. Pick any store from{' '}
            <a href="/stores" className="text-[var(--color-ion)] underline">
              /stores
            </a>{' '}
            to get its link and QR inline in the operating table.
          </p>
          <div className="rounded border border-[var(--color-edge)] bg-[var(--color-ink)] p-3">
            <div className="label mb-1">Template</div>
            <code className="num block break-all text-xs">{config.prodEntryUrl}</code>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="label">Example — store {config.defaultTestStoreId}</span>
              <code className="num break-all text-2xs">{entryUrl(config.defaultTestStoreId)}</code>
              <CopyButton value={entryUrl(config.defaultTestStoreId)} label="copy link" />
            </div>
          </div>

          <div className="mt-4">
            <h3 className="label mb-2">Environment registry</h3>
            <ul className="space-y-2">
              {ENVIRONMENTS.map((e) => {
                const r = reachability.find((x) => x.envKey === e.envKey);
                return (
                  <li key={e.envKey} className="rounded border border-[var(--color-edge)] p-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-block h-2 w-2 rounded-full',
                          r?.status === 'ok' ? 'bg-[var(--color-scan)]' : r?.status === 'unreachable' ? 'bg-[var(--color-alert)]' : 'bg-[var(--color-edge)]',
                        )}
                      />
                      <span className="text-sm">{e.displayName}</span>
                      {e.isCustomerFacing && (
                        <span className="rounded border border-[var(--color-edge)] px-1 text-2xs text-[var(--text-muted)]">
                          customer-facing
                        </span>
                      )}
                      <span className="num ml-auto text-2xs text-[var(--text-muted)]">{r?.detail ?? '—'}</span>
                    </div>
                    <code className="num mt-1 block break-all text-2xs text-[var(--text-muted)]">
                      {e.urlTemplate}
                    </code>
                    <p className="mt-0.5 text-2xs text-[var(--text-muted)]">{e.purpose}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-2">Scan to open</h2>
          <div
            className="rounded bg-[var(--color-paper)] p-2 [&>svg]:block [&>svg]:h-32 [&>svg]:w-32"
            dangerouslySetInnerHTML={{ __html: defaultQr }}
          />
          <p className="mt-2 max-w-32 text-2xs text-[var(--text-muted)]">
            Store {config.defaultTestStoreId} · prod entry
          </p>
        </section>
      </div>

      <DataTable
        caption="Test EAN registry — self-checking canary"
        columns={canaryCols}
        rows={canary}
        rowKey={(c) => c.ean}
        sourceNote="dim_test_ean × fact_scan_daily — nightly job writes last_actual_result; a found-expected EAN returning not_found raises an act-severity anomaly"
        maxHeight={420}
      />

      <DataTable
        caption="Store visit audit log"
        columns={[
          { key: 'd', header: 'Date', numeric: true, render: (v) => v.visitDate },
          { key: 's', header: 'Store', render: (v) => v.storeLabel },
          { key: 'sc', header: 'Scanned', numeric: true, render: (v) => v.itemsScanned },
          { key: 'f', header: 'Failed', numeric: true, render: (v) => v.itemsFailed },
          {
            key: 'c',
            header: 'Sampled coverage',
            numeric: true,
            render: (v) => formatPct((v.itemsScanned - v.itemsFailed) / v.itemsScanned),
          },
          {
            key: 'e',
            header: 'Failed EANs recorded',
            render: (v) => <span className="num text-2xs">{v.failedEans.join(', ') || '—'}</span>,
          },
        ]}
        rows={[...STORE_VISIT_AUDITS]}
        rowKey={(v) => `${v.visitDate}-${v.storeLabel}`}
        sourceNote="fact_store_visit_audit — auditor shelf samples, a different measurement from scan-observed coverage (§16.5.2). The gap between them is the finding, not an error."
        maxHeight={260}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-3">Identifiers</h2>
          <ul className="space-y-1.5">
            {IDENTIFIERS.map((i) => (
              <li key={i.label} className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--text-muted)]">{i.label}</span>
                <span className="flex items-center gap-1.5">
                  <code className="num max-w-64 truncate text-2xs" title={i.value}>
                    {i.value}
                  </code>
                  <CopyButton value={i.value} />
                </span>
              </li>
            ))}
          </ul>

          <h2 className="label mt-4 mb-2">Repositories</h2>
          <ul className="space-y-1">
            {REPO_INDEX.map((r) => (
              <li key={r.label} className="text-xs">
                <a href={r.url} target="_blank" rel="noreferrer" className="num text-[var(--color-ion)] underline">
                  {r.label}
                </a>
                <span className="text-[var(--text-muted)]"> — {r.what}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-3">Document index</h2>
          {docGroups.map((g) => (
            <div key={g} className="mb-3">
              <div className="mb-1 text-2xs uppercase tracking-wider text-[var(--text-muted)]">{g}</div>
              <ul className="space-y-1">
                {DOCUMENT_INDEX.filter((d) => d.group === g).map((d) => (
                  <li key={d.label} className="text-xs">
                    <a href={d.url} target="_blank" rel="noreferrer" className="text-[var(--color-ion)] underline">
                      {d.label}
                    </a>
                    <span className="text-[var(--text-muted)]"> — {d.what}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
