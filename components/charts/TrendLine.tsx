'use client';

/**
 * General-purpose trend line with an optional target/SLO reference line and a
 * 7-day rolling mean. Used by `/sales`, `/catalogue` and `/app-health` so the
 * chart vocabulary stays consistent across modules (§29.4).
 */
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatByUnit } from '@/lib/format/currency';
import { formatDateKey } from '@/lib/format/dates';

export interface TrendSeries {
  id: string;
  label: string;
  color: string;
  unit: 'count' | 'inr' | 'ratio' | 'ms' | 'score' | 'days';
  points: Array<{ dateKey: string; value: number | null }>;
  /** Draw a 7-day rolling mean alongside the raw series. */
  rollingMean?: boolean;
  /** Right-hand axis, for dual-axis charts like orders vs e-GMV. */
  axis?: 'left' | 'right';
}

export interface TrendLineProps {
  title: string;
  subtitle?: string;
  series: TrendSeries[];
  /** Horizontal reference line — a coverage target or a latency SLO. */
  reference?: { value: number; label: string; axis?: 'left' | 'right' };
  /** Vertical markers — deploys/releases (§21.3). */
  markers?: Array<{ dateKey: string; label: string }>;
  height?: number;
  sourceNote: string;
  className?: string;
}

function rolling(points: Array<{ dateKey: string; value: number | null }>, window = 7) {
  return points.map((p, i) => {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1).map((x) => x.value).filter((v): v is number => v != null);
    return { dateKey: p.dateKey, value: slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null };
  });
}

export function TrendLine({
  title,
  subtitle,
  series,
  reference,
  markers = [],
  height = 240,
  sourceNote,
  className,
}: TrendLineProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const dates = useMemo(() => series[0]?.points.map((p) => p.dateKey) ?? [], [series]);
  const scales = useMemo(() => {
    const forAxis = (axis: 'left' | 'right') => {
      const vals = series
        .filter((s) => (s.axis ?? 'left') === axis)
        .flatMap((s) => s.points.map((p) => p.value))
        .filter((v): v is number => v != null);
      if (reference && (reference.axis ?? 'left') === axis) vals.push(reference.value);
      if (vals.length === 0) return { min: 0, max: 1 };
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const pad = (max - min) * 0.12 || max * 0.12 || 1;
      return { min: Math.max(0, min - pad), max: max + pad };
    };
    return { left: forAxis('left'), right: forAxis('right') };
  }, [series, reference]);

  const W = 1000;
  const H = height;
  const padL = 56;
  const padR = series.some((s) => s.axis === 'right') ? 56 : 16;
  const padT = 12;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const x = (i: number) => padL + (dates.length <= 1 ? plotW / 2 : (i / (dates.length - 1)) * plotW);
  const y = (v: number, axis: 'left' | 'right' = 'left') => {
    const s = scales[axis];
    return padT + plotH - ((v - s.min) / (s.max - s.min || 1)) * plotH;
  };

  const path = (pts: Array<{ dateKey: string; value: number | null }>, axis: 'left' | 'right') => {
    let d = '';
    let pen = false;
    pts.forEach((p, i) => {
      if (p.value == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value, axis).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  return (
    <figure className={cn('rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4', className)}>
      <figcaption className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <span className="label">{title}</span>
          {subtitle && <p className="mt-0.5 text-2xs text-[var(--text-muted)]">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 text-2xs">
          {series.map((s) => (
            <span key={s.id} className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              {s.label}
              {s.axis === 'right' && <span className="text-[var(--text-muted)]">(R)</span>}
            </span>
          ))}
        </div>
      </figcaption>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label={title}
             onMouseLeave={() => setHoverIdx(null)}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const v = scales.left.min + (scales.left.max - scales.left.min) * (1 - f);
            return (
              <g key={f}>
                <line x1={padL} y1={padT + f * plotH} x2={W - padR} y2={padT + f * plotH}
                      stroke="var(--color-edge)" strokeWidth={1} />
                <text x={padL - 8} y={padT + f * plotH + 4} textAnchor="end" className="num"
                      fontSize={10} fill="var(--text-muted)">
                  {formatByUnit(v, series.find((s) => (s.axis ?? 'left') === 'left')?.unit ?? 'count')}
                </text>
              </g>
            );
          })}

          {series.some((s) => s.axis === 'right') &&
            [0, 0.5, 1].map((f) => {
              const v = scales.right.min + (scales.right.max - scales.right.min) * (1 - f);
              return (
                <text key={f} x={W - padR + 8} y={padT + f * plotH + 4} className="num"
                      fontSize={10} fill="var(--text-muted)">
                  {formatByUnit(v, series.find((s) => s.axis === 'right')?.unit ?? 'inr')}
                </text>
              );
            })}

          {reference && (
            <g>
              <line
                x1={padL} y1={y(reference.value, reference.axis ?? 'left')}
                x2={W - padR} y2={y(reference.value, reference.axis ?? 'left')}
                stroke="var(--color-warn)" strokeWidth={1} strokeDasharray="5 4"
              />
              <text x={W - padR - 4} y={y(reference.value, reference.axis ?? 'left') - 5}
                    textAnchor="end" fontSize={10} fill="var(--color-warn)">
                {reference.label}
              </text>
            </g>
          )}

          {markers.map((m) => {
            const i = dates.indexOf(m.dateKey);
            if (i < 0) return null;
            return (
              <g key={`${m.dateKey}-${m.label}`}>
                <line x1={x(i)} y1={padT} x2={x(i)} y2={padT + plotH}
                      stroke="var(--color-ion)" strokeWidth={1} strokeDasharray="2 3" opacity={0.7} />
                <text x={x(i) + 3} y={padT + 10} fontSize={9} fill="var(--color-ion)">{m.label}</text>
              </g>
            );
          })}

          {series.map((s) => (
            <g key={s.id}>
              {s.rollingMean && (
                <path d={path(rolling(s.points), s.axis ?? 'left')} fill="none" stroke={s.color}
                      strokeWidth={2.5} opacity={0.28} />
              )}
              <path d={path(s.points, s.axis ?? 'left')} fill="none" stroke={s.color} strokeWidth={1.6} />
            </g>
          ))}

          {dates.map((d, i) => (
            <rect key={d} x={x(i) - plotW / Math.max(1, dates.length) / 2} y={padT}
                  width={plotW / Math.max(1, dates.length)} height={plotH} fill="transparent"
                  onMouseEnter={() => setHoverIdx(i)} />
          ))}

          {hoverIdx != null && (
            <line x1={x(hoverIdx)} y1={padT} x2={x(hoverIdx)} y2={padT + plotH}
                  stroke="var(--text-muted)" strokeWidth={1} opacity={0.5} />
          )}

          {dates.map((d, i) =>
            i % Math.ceil(dates.length / 8) === 0 ? (
              <text key={`t-${d}`} x={x(i)} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
                {d.slice(5)}
              </text>
            ) : null,
          )}
        </svg>

        {hoverIdx != null && (
          <div className="pointer-events-none absolute top-2 left-16 rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-2xs">
            <div className="num mb-1 font-medium">{formatDateKey(dates[hoverIdx])}</div>
            {series.map((s) => (
              <div key={s.id} className="num flex items-center justify-between gap-3">
                <span style={{ color: s.color }}>{s.label}</span>
                <span>{formatByUnit(s.points[hoverIdx]?.value ?? null, s.unit)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="mt-2 text-2xs text-[var(--text-muted)]">Source: {sourceNote}</p>
    </figure>
  );
}
