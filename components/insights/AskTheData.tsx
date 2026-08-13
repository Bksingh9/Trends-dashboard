'use client';

/**
 * §8.4 / §28.6 — Ask the data.
 *
 * The generated SQL is shown to the user *before* results, always. Read-only
 * role, statement timeout, row limit, table allowlist, and Postgres only —
 * generated SQL never reaches BigQuery.
 */
import { useState } from 'react';
import { CopyButton } from '@/components/shell/CopyButton';

interface AskResponse {
  question: string;
  sql: string;
  violations: string[];
  executed: boolean;
  rows: Record<string, unknown>[];
  rowCount: number;
  error?: string;
  answeredFromMetricLayer?: string;
}

export function AskTheData() {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);

  async function ask(execute: boolean) {
    setPending(true);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, execute, sql: execute ? result?.sql : undefined }),
      });
      setResult((await res.json()) as AskResponse);
    } catch (e) {
      setResult({
        question,
        sql: '',
        violations: [],
        executed: false,
        rows: [],
        rowCount: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPending(false);
    }
  }

  const columns = result?.rows.length ? Object.keys(result.rows[0]) : [];

  return (
    <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
      <h2 className="label mb-1">Ask the data</h2>
      <p className="mb-3 text-2xs text-[var(--text-muted)]">
        Natural language over the Postgres marts only. The SQL is shown before it runs, every time.
        Read-only role, 15 s timeout, 5,000-row cap, table allowlist.
      </p>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(false);
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Which states had the lowest catalogue coverage last week?"
          className="min-w-0 flex-1 rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-sm outline-none focus:border-[var(--color-ion)]"
        />
        <button
          type="submit"
          disabled={pending || !question.trim()}
          className="rounded border border-[var(--color-ion)] px-3 py-2 text-sm text-[var(--color-ion)] disabled:opacity-40"
        >
          {pending ? 'Working…' : 'Generate SQL'}
        </button>
      </form>

      {result?.answeredFromMetricLayer && (
        <p className="mt-3 rounded border border-[var(--color-scan)]/40 bg-[var(--color-scan)]/5 px-3 py-2 text-xs">
          Answered from the metric layer as{' '}
          <code className="num">{result.answeredFromMetricLayer}</code> rather than generated SQL — two
          different numbers for the same question destroys trust faster than any missing feature
          (§28.6).
        </p>
      )}

      {result?.error && <p className="mt-3 text-xs text-[var(--color-alert)]">{result.error}</p>}

      {result?.violations && result.violations.length > 0 && (
        <ul className="mt-3 space-y-0.5">
          {result.violations.map((v) => (
            <li key={v} className="text-2xs text-[var(--color-alert)]">
              Guard: {v}
            </li>
          ))}
        </ul>
      )}

      {result?.sql && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="label">Generated SQL</span>
            <div className="flex gap-2">
              <CopyButton value={result.sql} />
              <button
                type="button"
                onClick={() => void ask(true)}
                disabled={pending || result.violations.length > 0}
                className="rounded border border-[var(--color-scan)] px-2 py-0.5 text-2xs text-[var(--color-scan)] disabled:opacity-40"
              >
                Run it
              </button>
            </div>
          </div>
          <pre className="num overflow-auto rounded border border-[var(--color-edge)] bg-[var(--color-ink)] p-3 text-2xs">
            {result.sql}
          </pre>
        </div>
      )}

      {result?.executed && (
        <div className="mt-3 overflow-auto rounded border border-[var(--color-edge)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-edge)]">
                {columns.map((c) => (
                  <th key={c} className="label px-2 py-1 text-left font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 100).map((row, i) => (
                <tr key={i} className="border-b border-[var(--color-edge)]/50">
                  {columns.map((c) => (
                    <td key={c} className="num px-2 py-1">
                      {String(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-[var(--color-edge)] px-2 py-1 text-2xs text-[var(--text-muted)]">
            {result.rowCount} rows · logged to ai_insight with the question, SQL and user
          </div>
        </div>
      )}
    </section>
  );
}
