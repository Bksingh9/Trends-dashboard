'use client';

/**
 * §4.11 — Help & Support Analytics.
 *
 * Client-side because it has a date range and a refresh button, and both change
 * without a navigation. It calls `/api/analytics/help-events`; it never touches
 * GA4, and there is no credential in this bundle to touch it with.
 *
 * Four states, all of them real:
 *
 * - **loading** — skeletons, not a spinner over stale numbers. A number that is
 *   still on screen while a different range loads will be read as the answer.
 * - **error** — the named remedy from the endpoint. "Could not load" sends
 *   someone hunting for an afternoon; "the Data API is not enabled on this
 *   project" is a console click, and the two have different owners.
 * - **empty** — stated as a measured zero, with the caveat that an event which
 *   never fired and an event nobody triggered look identical here (§16.9).
 * - **live** — the numbers, with the range they cover.
 */
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatCount, formatINR } from '@/lib/format/currency';

const HELP_EVENTS = ['help_support_sheet_view', 'help_support_tap', 'help_support_call_tap'] as const;

const SERIES_COLOUR: Record<string, string> = {
  help_support_sheet_view: 'var(--color-ion)',
  help_support_tap: 'var(--color-scan)',
  help_support_call_tap: 'var(--color-warn)',
};

const LABEL: Record<string, string> = {
  help_support_sheet_view: 'Help sheet viewed',
  help_support_tap: 'Help tapped',
  help_support_call_tap: 'Call tapped',
};

interface Payload {
  state: 'live' | 'missing';
  kind?: string;
  error?: string;
  remedy?: string;
  propertyId?: string;
  range: { startDate: string; endDate: string };
  summary: {
    eventCount: number;
    totalUsers: number;
    eventCountPerActiveUser: number;
    totalRevenue: number;
  } | null;
  events: Array<{
    eventName: string;
    eventCount: number;
    totalUsers: number;
    eventCountPerActiveUser: number;
    totalRevenue: number;
  }>;
  timeSeries: Array<Record<string, number | string>>;
  warnings?: string[];
}

const PRESETS: Array<{ label: string; start: string; end: string }> = [
  { label: '7d', start: '7daysAgo', end: 'yesterday' },
  { label: '28d', start: '28daysAgo', end: 'yesterday' },
  { label: '90d', start: '90daysAgo', end: 'yesterday' },
];

export function HelpSupportAnalytics() {
  const [start, setStart] = useState('28daysAgo');
  const [end, setEnd] = useState('yesterday');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async (s: string, e: string) => {
    setLoading(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/analytics/help-events?startDate=${encodeURIComponent(s)}&endDate=${encodeURIComponent(e)}`);
      setData((await res.json()) as Payload);
    } catch (err) {
      // The fetch itself failing is a different problem from GA4 failing, and
      // the endpoint's own error path never runs in that case.
      setFailed(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(start, end);
  }, [load, start, end]);

  return (
    <section data-help-support className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="display text-lg">Help &amp; Support Analytics</h2>
          <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
            {HELP_EVENTS.join(' · ')} — live from the GA4 Data API
            {data?.propertyId && `, property ${data.propertyId}`}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              data-help-range={p.label}
              onClick={() => {
                setStart(p.start);
                setEnd(p.end);
              }}
              className={cn(
                'rounded border px-2 py-1 text-2xs',
                start === p.start && end === p.end
                  ? 'border-[var(--color-ion)] text-[var(--color-ion)]'
                  : 'border-[var(--color-edge)] text-[var(--text-muted)] hover:border-[var(--color-ion)]',
              )}
            >
              {p.label}
            </button>
          ))}
          <input
            type="date"
            aria-label="Start date"
            data-help-start
            onChange={(e) => e.target.value && setStart(e.target.value)}
            className="rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-1.5 py-1 text-2xs text-[var(--text-primary)]"
          />
          <input
            type="date"
            aria-label="End date"
            data-help-end
            onChange={(e) => e.target.value && setEnd(e.target.value)}
            className="rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-1.5 py-1 text-2xs text-[var(--text-primary)]"
          />
          <button
            type="button"
            data-help-refresh
            onClick={() => void load(start, end)}
            disabled={loading}
            className="rounded border border-[var(--color-edge)] px-2 py-1 text-2xs text-[var(--text-muted)] hover:border-[var(--color-ion)] disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {loading && <Skeleton />}

      {!loading && failed && (
        <Problem title="The dashboard could not reach its own endpoint" body={failed} remedy="Check the server is running and try Refresh." />
      )}

      {!loading && !failed && data?.state === 'missing' && (
        <Problem
          title={data.error ?? 'GA4 did not answer'}
          body={
            data.kind === 'api_disabled'
              ? 'The credential is fine — the API it is calling has never been switched on for this project.'
              : data.kind === 'no_access'
                ? 'The credential is fine and the API is on — this service account simply is not on the property.'
                : 'No data was returned for this range.'
          }
          remedy={data.remedy}
        />
      )}

      {!loading && !failed && data?.state === 'live' && data.summary && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Total help events" value={formatCount(data.summary.eventCount)} />
            <Kpi label="Total users" value={formatCount(data.summary.totalUsers)} />
            <Kpi
              label="Events per active user"
              value={data.summary.eventCountPerActiveUser.toFixed(2)}
              note="Recomputed from the totals — a ratio cannot be summed across events."
            />
            <Kpi label="Revenue" value={formatINR(data.summary.totalRevenue)} note="Help events carry no revenue." />
          </div>

          {(data.warnings ?? []).map((w) => (
            <p key={w} className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-3 py-2 text-2xs text-[var(--text-muted)]">
              ▲ {w}
            </p>
          ))}

          {data.events.length === 0 ? (
            <p className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-6 text-xs text-[var(--text-muted)]">
              No help events between {data.range.startDate} and {data.range.endDate}. The property answered, so this
              is a measured zero — unless these events were never instrumented, which looks identical from here.
            </p>
          ) : (
            <>
              <TimeSeries points={data.timeSeries} />
              <div className="overflow-x-auto rounded border border-[var(--color-edge)] bg-[var(--surface)]">
                <table className="w-full text-xs">
                  <caption className="px-3 py-2 text-left text-2xs text-[var(--text-muted)]">
                    By event · {data.range.startDate} → {data.range.endDate}
                  </caption>
                  <thead className="text-2xs text-[var(--text-muted)]">
                    <tr className="border-y border-[var(--color-edge)]">
                      <th className="px-3 py-1.5 text-left font-normal">Event</th>
                      <th className="px-3 py-1.5 text-right font-normal">Events</th>
                      <th className="px-3 py-1.5 text-right font-normal">Users</th>
                      <th className="px-3 py-1.5 text-right font-normal">Per active user</th>
                      <th className="px-3 py-1.5 text-right font-normal">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.map((e) => (
                      <tr key={e.eventName} className="border-b border-[var(--color-edge)]/50">
                        <td className="px-3 py-1.5">
                          <span
                            className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                            style={{ backgroundColor: SERIES_COLOUR[e.eventName] ?? 'var(--text-muted)' }}
                            aria-hidden
                          />
                          {LABEL[e.eventName] ?? e.eventName}
                          <span className="ml-1.5 text-2xs text-[var(--text-muted)]">{e.eventName}</span>
                        </td>
                        <td className="num px-3 py-1.5 text-right">{formatCount(e.eventCount)}</td>
                        <td className="num px-3 py-1.5 text-right">{formatCount(e.totalUsers)}</td>
                        <td className="num px-3 py-1.5 text-right">{e.eventCountPerActiveUser.toFixed(2)}</td>
                        <td className="num px-3 py-1.5 text-right">{formatINR(e.totalRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-3">
      <div className="label truncate">{label}</div>
      <div className="num mt-1.5 text-2xl leading-none text-[var(--text-primary)]">{value}</div>
      {note && <p className="mt-1.5 text-2xs text-[var(--text-muted)]">{note}</p>}
    </div>
  );
}

function Skeleton() {
  return (
    <div data-help-loading className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[5.5rem] animate-pulse rounded border border-[var(--color-edge)] bg-[var(--surface)]" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded border border-[var(--color-edge)] bg-[var(--surface)]" />
    </div>
  );
}

function Problem({ title, body, remedy }: { title: string; body: string; remedy?: string }) {
  return (
    <div data-help-error className="rounded border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2.5">
      <div className="text-xs font-semibold text-[var(--color-warn)]">{title}</div>
      <p className="mt-1 max-w-3xl text-2xs text-[var(--text-muted)]">{body}</p>
      {remedy && (
        <p className="mt-1.5 max-w-3xl text-2xs text-[var(--text-primary)]">
          <span className="text-[var(--color-warn)]">Fix: </span>
          {remedy}
        </p>
      )}
    </div>
  );
}

/** One line per event. Shared y-scale, because three scales is three charts. */
function TimeSeries({ points }: { points: Array<Record<string, number | string>> }) {
  if (points.length < 2) {
    return (
      <p className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4 text-2xs text-[var(--text-muted)]">
        Not enough days in this range to draw a line.
      </p>
    );
  }

  const w = 720;
  const h = 160;
  const max = Math.max(
    1,
    ...points.flatMap((p) => HELP_EVENTS.map((e) => Number(p[e] ?? 0))),
  );

  return (
    <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
      <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="label">Events by day</span>
        <span className="flex flex-wrap gap-2.5 text-2xs text-[var(--text-muted)]">
          {HELP_EVENTS.map((e) => (
            <span key={e} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLOUR[e] }} aria-hidden />
              {LABEL[e]}
            </span>
          ))}
        </span>
      </figcaption>

      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label="Help events by day">
        {HELP_EVENTS.map((e) => {
          const d = points
            .map((p, i) => {
              const x = (i / (points.length - 1)) * w;
              const y = h - (Number(p[e] ?? 0) / max) * (h - 8) - 4;
              return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
            })
            .join(' ');
          return <path key={e} d={d} fill="none" stroke={SERIES_COLOUR[e]} strokeWidth="2" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>

      {/* The scale, stated. A sparkline with no axis makes a two-event day and a
          two-hundred-event day look the same shape. */}
      <div className="mt-1 flex justify-between text-2xs text-[var(--text-muted)]">
        <span>{String(points[0].date)}</span>
        <span>peak {max}/day</span>
        <span>{String(points[points.length - 1].date)}</span>
      </div>
    </figure>
  );
}
