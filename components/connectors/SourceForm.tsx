'use client';

/**
 * "Add a data source" — the form, generated from the type description.
 *
 * Generated rather than hand-written per type, because a hand-written form
 * drifts from the validation and the connection test that are supposed to
 * describe the same thing. `SOURCE_TYPES` is the single description; the form,
 * the checks and the test all read it.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { searchSourceTypes, type SourceType } from '@/lib/credentials/source-types';
import { saveSourceAction, testSourceAction, type SaveOutcome } from '@/app/(dash)/connectors/sources/actions';
import { cn } from '@/lib/cn';

const FIELD =
  'w-full rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--color-ion)] focus:outline-none';

const CATEGORY_LABEL: Record<SourceType['category'], string> = {
  warehouse: 'Warehouses',
  database: 'Databases',
  spreadsheet: 'Spreadsheets',
  messaging: 'Messaging',
  observability: 'Observability',
  analytics: 'Analytics',
  file: 'Files & storage',
  commerce: 'Commerce',
  crm: 'CRM',
  ads: 'Advertising',
  generic: 'Custom',
};

/** Companion-specific sources first — they are what this dashboard is for. */
const CATEGORY_ORDER: Array<SourceType['category']> = [
  'warehouse',
  'database',
  'spreadsheet',
  'messaging',
  'observability',
  'analytics',
  'file',
  'commerce',
  'crm',
  'ads',
  'generic',
];

export function AddSourceButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-add-source
        onClick={() => setOpen(true)}
        className="rounded border border-[var(--color-ion)] px-2.5 py-1 text-xs text-[var(--color-ion)] hover:bg-[var(--color-ion)]/10"
      >
        + Add a data source
      </button>
      {open && <SourcePicker onClose={() => setOpen(false)} />}
    </>
  );
}

function SourcePicker({ onClose }: { onClose: () => void }) {
  const [chosen, setChosen] = useState<SourceType | null>(null);
  const [query, setQuery] = useState('');

  const matches = searchSourceTypes(query);
  const byCategory = matches.reduce<Record<string, SourceType[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});
  const categories = CATEGORY_ORDER.filter((c) => byCategory[c]?.length);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={chosen ? `Configure ${chosen.label}` : 'Choose a data source type'}
    >
      <div className="w-full max-w-2xl rounded border border-[var(--color-edge)] bg-[var(--surface)] p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="display text-lg">{chosen ? `Connect ${chosen.label}` : 'Add a data source'}</h2>
            <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
              {chosen
                ? chosen.blurb
                : 'Credentials are encrypted before they reach the database and are never shown again.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-[var(--color-edge)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:border-[var(--color-alert)]"
          >
            ✕
          </button>
        </div>

        {!chosen ? (
          <div className="space-y-4">
            <input
              autoFocus
              data-source-search
              className={FIELD}
              placeholder="Search — try “sheets”, “sql”, “excel”, “api”…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {categories.length === 0 && (
              <p className="py-6 text-center text-xs text-[var(--text-muted)]">
                Nothing matches “{query}”. A REST API or CSV source will connect almost anything.
              </p>
            )}
            {categories.map((cat) => (
              <div key={cat}>
                <div className="label mb-1.5">{CATEGORY_LABEL[cat]}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {byCategory[cat].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      data-source-type={t.id}
                      onClick={() => setChosen(t)}
                      className="rounded border border-[var(--color-edge)] p-2.5 text-left hover:border-[var(--color-ion)]"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs text-[var(--text-primary)]">{t.label}</span>
                        {/* A source that cannot move a KPI is a different
                            promise from one that can, so it says which. */}
                        {t.genericOnly && (
                          <span className="shrink-0 text-2xs text-[var(--text-muted)]">explore only</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-2xs text-[var(--text-muted)]">{t.blurb}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <SourceFields type={chosen} onBack={() => setChosen(null)} onDone={onClose} />
        )}
      </div>
    </div>
  );
}

function SourceFields({
  type,
  onBack,
  onDone,
}: {
  type: SourceType;
  onBack: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(type.label);
  const [values, setValues] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [, startTransition] = useTransition();

  const errorFor = (k: string) => outcome?.fieldErrors?.find((e) => e.field === k)?.message;

  const run = async (what: 'test' | 'save') => {
    setBusy(what);
    setOutcome(null);
    try {
      const r =
        what === 'test'
          ? await testSourceAction(type.id, values)
          : await saveSourceAction(type.id, name, values);
      setOutcome(r);
      if (what === 'save' && r.ok) {
        startTransition(() => router.refresh());
        // Left open on purpose when the test failed, so the message stays
        // readable and the credential does not have to be pasted twice.
        if (r.test?.ok !== false) setTimeout(onDone, 1200);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="label">Name</span>
        <input className={cn(FIELD, 'mt-1')} value={name} onChange={(e) => setName(e.target.value)} />
        <span className="mt-0.5 block text-2xs text-[var(--text-muted)]">
          Two projects of the same type need two names.
        </span>
      </label>

      {type.fields.map((f) => (
        <label key={f.key} className="block">
          <span className="label">
            {f.label}
            {f.required && <span className="text-[var(--color-alert)]"> *</span>}
          </span>
          {f.kind === 'textarea' ? (
            <textarea
              rows={4}
              className={cn(FIELD, 'mt-1 font-mono')}
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          ) : (
            <input
              type={f.kind === 'password' ? 'password' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              className={cn(FIELD, 'mt-1')}
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          )}
          {errorFor(f.key) ? (
            <span className="mt-0.5 block text-2xs text-[var(--color-alert)]">{errorFor(f.key)}</span>
          ) : (
            f.help && <span className="mt-0.5 block text-2xs text-[var(--text-muted)]">{f.help}</span>
          )}
        </label>
      ))}

      <div className="rounded border border-[var(--color-edge)] bg-[var(--color-ink)]/40 p-2.5 text-2xs text-[var(--text-muted)]">
        <div>
          <span className="text-[var(--text-primary)]">Turns on:</span> {type.enables.join(', ')}
        </div>
        <div className="mt-1">
          <span className="text-[var(--text-primary)]">Test does:</span> {type.testDescription}
        </div>
      </div>

      {outcome && <TestReport outcome={outcome} />}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-[var(--color-edge)] px-2 py-1 text-xs text-[var(--text-muted)]"
        >
          Back
        </button>
        <div className="flex-1" />
        <button
          type="button"
          data-test-connection
          disabled={busy !== null}
          onClick={() => run('test')}
          className="rounded border border-[var(--color-edge)] px-2.5 py-1 text-xs hover:border-[var(--color-ion)] disabled:opacity-50"
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          data-save-source
          disabled={busy !== null}
          onClick={() => run('save')}
          className="rounded border border-[var(--color-ion)] bg-[var(--color-ion)]/10 px-2.5 py-1 text-xs text-[var(--color-ion)] disabled:opacity-50"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/** Every hop that was attempted, so a failure is located rather than guessed. */
function TestReport({ outcome }: { outcome: SaveOutcome }) {
  return (
    <div
      data-test-result
      className={cn(
        'rounded border p-2.5 text-2xs',
        outcome.ok
          ? 'border-[var(--color-scan)]/50 bg-[var(--color-scan)]/5'
          : 'border-[var(--color-alert)]/50 bg-[var(--color-alert)]/5',
      )}
    >
      <div className={outcome.ok ? 'text-[var(--color-scan)]' : 'text-[var(--color-alert)]'}>
        {outcome.message}
      </div>
      {outcome.test?.steps.map((s) => (
        <div key={s.label} className="mt-1 flex gap-2">
          <span className={s.ok ? 'text-[var(--color-scan)]' : 'text-[var(--color-alert)]'}>
            {s.ok ? '✓' : '✕'}
          </span>
          <span className="text-[var(--text-muted)]">
            {s.label} — {s.detail}
          </span>
        </div>
      ))}
      {outcome.test?.findings?.map((f) => (
        <div key={f} className="mt-1 text-[var(--text-muted)]">
          · {f}
        </div>
      ))}
    </div>
  );
}
