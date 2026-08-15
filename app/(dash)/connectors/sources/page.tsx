/**
 * §9.5 — Data sources.
 *
 * What a dashboard is expected to have and this one did not: a place to add a
 * connection without editing a file and redeploying. Everything else about the
 * connector layer — the SLA scheduler, the assertion gate, the fixture
 * fallback — was already built for people who can push code. This page is for
 * the person who has just been handed a token.
 */
import Link from 'next/link';
import { isCredentialStorageConfigured } from '@/lib/credentials/crypto';
import { listSources } from '@/lib/credentials/store';
import { getSourceType, SOURCE_TYPES } from '@/lib/credentials/source-types';
import { getDb } from '@/lib/db/client';
import { ModuleHeader } from '@/components/table/DataTable';
import { AddSourceButton } from '@/components/connectors/SourceForm';
import { SourceCard } from '@/components/connectors/SourceCard';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export default async function SourcesPage() {
  const hasDb = Boolean(getDb());
  const canStore = isCredentialStorageConfigured();
  const sources = hasDb && canStore ? await listSources() : [];

  // Types with no source yet, so the page reads as "what is still unconnected"
  // rather than only as a list of what happens to exist.
  const configured = new Set(sources.map((s) => s.type));
  const unconfigured = SOURCE_TYPES.filter((t) => !configured.has(t.id));

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Data sources"
        question="What is connected, and what can I connect right now without a deploy?"
        sources={['data_source — credentials encrypted at rest (AES-256-GCM)']}
      >
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-xs text-[var(--text-muted)]">
            A source added here overrides the matching environment variable, so an existing deploy
            keeps working until you replace it. Secrets are write-only: once saved they are never
            sent back to a browser, only replaced.
          </p>
          {hasDb && canStore && <AddSourceButton />}
        </div>
      </ModuleHeader>

      {!hasDb && (
        <Blocker
          title="No database configured"
          body="Credentials need somewhere to live. Set DATABASE_URL and run `npm run db:push`, then this page can store connections."
        />
      )}

      {hasDb && !canStore && (
        <Blocker
          title="CREDENTIAL_KEY is not set"
          body="Without it a stored credential could only be written in plaintext, which is strictly worse than the environment variables this replaces. Generate one with `openssl rand -base64 32` and set it in the environment. Nothing will be stored until you do."
        />
      )}

      {sources.length > 0 && (
        <section className="space-y-3">
          <h2 className="label">Connected</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {sources.map((s) => (
              <SourceCard
                key={s.sourceId}
                source={s}
                type={getSourceType(s.type)}
                overridesEnv={(getSourceType(s.type)?.supersedes ?? []).some((v) => Boolean(process.env[v]))}
              />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="label">Available{sources.length > 0 ? ' — not yet connected' : ''}</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {unconfigured.map((t) => (
            <div key={t.id} className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-3">
              <div className="text-xs text-[var(--text-primary)]">{t.label}</div>
              <p className="mt-1 text-2xs text-[var(--text-muted)]">{t.blurb}</p>
              <p className="mt-2 text-2xs text-[var(--text-muted)]">
                <span className="text-[var(--text-primary)]">Turns on:</span> {t.enables.join(', ')}
              </p>
              {/* An env var already covering this is worth saying, so nobody
                  adds a second credential for something already working. */}
              {t.supersedes.some((v) => process.env[v]) && (
                <p className="mt-1.5 text-2xs text-[var(--color-warn)]">
                  Currently set by environment variable — adding it here would take precedence.
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <p className="text-2xs text-[var(--text-muted)]">
        Adding a source does not run it. See{' '}
        <Link href="/connectors" className="text-[var(--color-ion)] underline">
          Connectors
        </Link>{' '}
        for status and to run one now, or{' '}
        <Link href="/connectors/setup" className="text-[var(--color-ion)] underline">
          Connection setup
        </Link>{' '}
        for the full preflight.
      </p>
    </div>
  );
}

function Blocker({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2.5">
      <div className="text-xs font-semibold text-[var(--color-warn)]">{title}</div>
      <p className="mt-1 max-w-3xl text-2xs text-[var(--text-muted)]">{body}</p>
    </div>
  );
}
