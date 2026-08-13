'use client';

/**
 * §4.5 — The Manhattan / skyline chart.
 *
 * Daily stacked bars, products scanned found vs not found, with coverage %
 * labelled per bar. This chart already exists in reporting and leadership
 * recognises it, so its form is preserved rather than redesigned.
 *
 * Days that are unreachable via Slack pagination render as a hatched gap
 * (§18.3): a visible hole is information; an invisible one is a lie about the
 * date range.
 */
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatCount, formatPct } from '@/lib/format/currency';
import { formatDateKey } from '@/lib/format/dates';

export interface ManhattanPoint {
  dateKey: string;
  uniqueScans: number;
  uniqueFailed: number;
  uniqueCoverage: number;
  /** null = unreachable, not "no report" */
  reportGenerated: boolean | null;
  source: string;
}

export interface ManhattanChartProps {
  data: ManhattanPoint[];
  /** Drawn as a reference line. Default 97% (§12). */
  target?: number;
  height?: number;
  className?: string;
}

export function ManhattanChart({ data, target = 0.97, height = 260, className }: ManhattanChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => Math.max(1, ...data.map((d) => d.uniqueScans)), [data]);

  const W = 1000;
  const H = height;
  const padL = 52;
  const padR = 16;
  const padT = 16;
  const padB = 38;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const barW = plotW / Math.max(1, data.length);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const active = hover != null ? data[hover] : null;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));

  return (
    <figure className={cn('rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4', className)}>
      <figcaption className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <span className="label">Scanned products — found vs not found</span>
          <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
            Daily distinct EANs scanned. Coverage % labelled per bar.
          </p>
        </div>
        <div className="flex items-center gap-3 text-2xs">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-[var(--color-scan)]" /> found
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-[var(--color-alert)]" /> not found
          </span>
          <span className="flex items-center gap-1">
            <span className="hatch inline-block h-2 w-2 rounded-sm" /> unreachable
          </span>
        </div>
      </figcaption>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img"
             aria-label="Daily catalogue coverage, found versus not found"
             onMouseLeave={() => setHover(null)}>
          {/* Axes with units — every chart gets them (§10.4). */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke="var(--color-edge)" strokeWidth={1} />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="num" fontSize={11} fill="var(--text-muted)">
                {formatCount(t)}
              </text>
            </g>
          ))}
          <text
            x={14} y={padT + plotH / 2} fontSize={11} fill="var(--text-muted)"
            transform={`rotate(-90 14 ${padT + plotH / 2})`} textAnchor="middle"
          >
            distinct EANs
          </text>

          {data.map((d, i) => {
            const x = padL + i * barW;
            const w = Math.max(1, barW * 0.72);
            const ox = x + (barW - w) / 2;

            if (d.reportGenerated === null) {
              return (
                <g key={d.dateKey} onMouseEnter={() => setHover(i)}>
                  <rect x={x} y={padT} width={barW} height={plotH} fill="transparent" />
                  <rect
                    x={ox} y={padT} width={w} height={plotH}
                    fill="url(#hatchPattern)" opacity={0.5}
                  />
                </g>
              );
            }

            const found = d.uniqueScans - d.uniqueFailed;
            const foundH = (found / max) * plotH;
            const failedH = (d.uniqueFailed / max) * plotH;
            const dim = hover != null && hover !== i;

            return (
              <g key={d.dateKey} onMouseEnter={() => setHover(i)}>
                <rect x={x} y={padT} width={barW} height={plotH} fill="transparent" />
                <rect x={ox} y={y(d.uniqueScans)} width={w} height={foundH}
                      fill="var(--color-scan)" opacity={dim ? 0.4 : 0.9} />
                <rect x={ox} y={y(d.uniqueScans) + foundH} width={w} height={failedH}
                      fill="var(--color-alert)" opacity={dim ? 0.4 : 0.9} />
                {barW > 34 && (
                  <text x={ox + w / 2} y={y(d.uniqueScans) - 5} textAnchor="middle"
                        className="num" fontSize={10}
                        fill={d.uniqueCoverage < target ? 'var(--color-warn)' : 'var(--text-muted)'}>
                    {(d.uniqueCoverage * 100).toFixed(1)}
                  </text>
                )}
                {(i % Math.ceil(data.length / 8) === 0 || data.length <= 10) && (
                  <text x={ox + w / 2} y={H - 12} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
                    {d.dateKey.slice(5)}
                  </text>
                )}
              </g>
            );
          })}

          <defs>
            <pattern id="hatchPattern" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-edge)" strokeWidth="3" />
            </pattern>
          </defs>
        </svg>

        {active && (
          <div className="pointer-events-none absolute top-2 right-2 rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-2xs">
            <div className="num mb-1 font-medium">{formatDateKey(active.dateKey)}</div>
            {active.reportGenerated === null ? (
              <div className="text-[var(--color-warn)]">
                Unreachable via Slack pagination — no report ingested for this day
              </div>
            ) : (
              <>
                <div className="num">Scanned {formatCount(active.uniqueScans)}</div>
                <div className="num text-[var(--color-alert)]">Failed {formatCount(active.uniqueFailed)}</div>
                <div className="num text-[var(--color-scan)]">
                  Coverage {formatPct(active.uniqueCoverage, { precision: 2 })}
                </div>
                <div className="mt-1 text-[var(--text-muted)]">Source: {active.source}</div>
              </>
            )}
          </div>
        )}
      </div>

      <p className="mt-2 text-2xs text-[var(--text-muted)]">
        Source: fact_catalogue_daily (slack-catalogue-report) · target {formatPct(target, { precision: 0 })} ·
        scan-observed coverage, not audited or true coverage (§16.5.2)
      </p>
    </figure>
  );
}
