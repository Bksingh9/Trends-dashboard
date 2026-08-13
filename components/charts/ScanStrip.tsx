'use client';

/**
 * §10.3 — The signature element.
 *
 * A horizontal strip rendering the last 90 minutes of scan activity as vertical
 * bars at 1-minute resolution. Bar height is scan volume, bar colour is
 * `--scan`, and every failed scan draws a thin `--alert` tick at the baseline.
 *
 * Read left to right it looks like a barcode, and it behaves like one: dense
 * where the stores are busy, gapped where they've gone quiet, red-flecked where
 * the catalogue is failing.
 *
 * It earns its place because it is the only element on the page that shows the
 * product actually being used, right now — and a person can read it in under a
 * second from across a room. Everything else on the page stays quiet so this
 * reads.
 */
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format/currency';
import type { DataSourceState } from '@/lib/connectors/types';
import { StatePill } from '@/components/data-state';

export interface ScanMinutePoint {
  minute: string; // ISO
  scans: number;
  failures: number;
  stores: number;
}

export interface ScanStripProps {
  data: ScanMinutePoint[];
  state: DataSourceState;
  /** A14 — when intraday export is off there is no near-live source, and the
      strip says so rather than faking liveness (§16.6). */
  liveness: 'intraday' | 'last_complete_day' | 'fixture';
  height?: number;
  className?: string;
  compact?: boolean;
}

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function ScanStrip({
  data,
  state,
  liveness,
  height = 56,
  className,
  compact = false,
}: ScanStripProps) {
  const [hover, setHover] = useState<number | null>(null);

  const { max, totals } = useMemo(() => {
    const max = Math.max(1, ...data.map((d) => d.scans));
    return {
      max,
      totals: {
        scans: data.reduce((a, d) => a + d.scans, 0),
        failures: data.reduce((a, d) => a + d.failures, 0),
      },
    };
  }, [data]);

  const barW = 100 / Math.max(1, data.length);
  const active = hover != null ? data[hover] : null;
  const h = compact ? 28 : height;

  return (
    <section
      className={cn('rounded border border-[var(--color-edge)] bg-[var(--surface)] p-3', className)}
      aria-label="Scan activity, last 90 minutes"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="label">Scan strip</span>
          {!compact && (
            <span className="text-2xs text-[var(--text-muted)]">
              last 90 min · 1-min resolution · IST
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {liveness === 'last_complete_day' && (
            <span className="text-2xs text-[var(--color-warn)]" title="A14 — GA4 streaming (intraday) export is not enabled, so there is no near-live source.">
              last complete day
            </span>
          )}
          <StatePill state={state} />
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 100 ${h}`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height: h }}
          role="img"
          aria-label={`${formatCount(totals.scans)} scans and ${formatCount(totals.failures)} failures in the last 90 minutes`}
          onMouseLeave={() => setHover(null)}
        >
          {data.map((d, i) => {
            const barH = (d.scans / max) * (h - 6);
            const x = i * barW;
            const isNewest = i === data.length - 1;
            return (
              <g
                key={d.minute}
                onMouseEnter={() => setHover(i)}
                className={isNewest ? 'scan-bar-newest' : undefined}
              >
                {/* Invisible hit area — the bars are thin and the strip is meant
                    to be hoverable at speed. */}
                <rect x={x} y={0} width={barW} height={h} fill="transparent" />
                <rect
                  x={x + barW * 0.18}
                  y={h - 3 - barH}
                  width={barW * 0.64}
                  height={Math.max(0, barH)}
                  fill="var(--color-scan)"
                  opacity={hover == null || hover === i ? 0.92 : 0.42}
                />
                {d.failures > 0 && (
                  /* Failed scans as a thin tick at the baseline — red flecks
                     where the catalogue is failing. */
                  <rect
                    x={x + barW * 0.18}
                    y={h - 3}
                    width={barW * 0.64}
                    height={Math.min(3, 1 + d.failures * 0.4)}
                    fill="var(--color-alert)"
                  />
                )}
              </g>
            );
          })}
          <line x1={0} y1={h - 3} x2={100} y2={h - 3} stroke="var(--color-edge)" strokeWidth={0.3} />
        </svg>

        {active && (
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1 text-2xs shadow-lg"
            style={{ left: `${Math.min(88, (hover! / data.length) * 100)}%` }}
          >
            <div className="num font-medium">{IST_TIME.format(new Date(active.minute))} IST</div>
            <div className="num text-[var(--color-scan)]">{formatCount(active.scans)} scans</div>
            <div className="num text-[var(--color-alert)]">{formatCount(active.failures)} failed</div>
            <div className="num text-[var(--text-muted)]">{formatCount(active.stores)} stores</div>
          </div>
        )}
      </div>

      {!compact && (
        <div className="mt-2 flex items-center justify-between text-2xs text-[var(--text-muted)]">
          <span className="num">
            {formatCount(totals.scans)} scans · {formatCount(totals.failures)} failed
          </span>
          <span>
            Source:{' '}
            {liveness === 'fixture'
              ? 'fixture'
              : liveness === 'intraday'
                ? 'GA4 intraday export'
                : 'GA4 daily export (last complete day)'}
          </span>
        </div>
      )}
    </section>
  );
}
