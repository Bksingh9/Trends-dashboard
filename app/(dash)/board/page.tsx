/**
 * §4.10 — Board.
 *
 * The wall display. Every other page in this build answers a question by
 * argument: header, caveats, filters, a table you can sort. A board answers by
 * assertion, at a size readable from across a room, to people who will not
 * click anything.
 *
 * That makes it the most dangerous surface here and the reason the widget layer
 * is built the way it is: tiles cannot compute, they render §5 metrics, and the
 * fixture / stale marker travels with the value onto the tile. A green number
 * on a NOC wall that has not moved in two weeks is precisely how
 * `avis_base_view` went unnoticed.
 */
import Link from 'next/link';
import { buildBoard, boardableMetrics } from '@/lib/widgets/board';
import { listWidgets } from '@/lib/widgets/store';
import { SERIES } from '@/lib/widgets/series';
import { getMetric } from '@/lib/metrics/registry';
import { parseFilters, type RawParams } from '@/lib/params/filters';
import { Tile } from '@/components/widgets/Tile';
import { AddWidgetButton, RemoveWidgetButton, type PickerOption } from '@/components/widgets/BoardEditor';
import { formatIST } from '@/lib/format/dates';
import type { WidgetKind } from '@/lib/widgets/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const DOMAIN_LABEL: Record<string, string> = {
  business: 'Sales',
  journey: 'Journey',
  stores: 'Stores',
  catalogue: 'Catalogue',
  app_health: 'App health',
  issues: 'Issues',
  loyalty: 'Loyalty',
  series: 'Lists and trends',
};

/** Which tile kinds a metric can honestly be drawn as. */
function kindsForMetric(unit: string): WidgetKind[] {
  // A gauge needs a ceiling that means something, and only a ratio has one
  // without somebody inventing it. A count gets a number, a goal against an
  // explicit target, or a traffic light.
  return unit === 'ratio' ? ['number', 'gauge', 'goal', 'status'] : ['number', 'goal', 'status'];
}

export default async function BoardPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const params = await searchParams;
  const filters = parseFilters(params, 28);
  const listing = await listWidgets();
  const board = await buildBoard(listing.specs, filters.window);

  const options: PickerOption[] = [
    ...boardableMetrics().map((id) => {
      const def = getMetric(id)!;
      return {
        id,
        kind: 'metric' as const,
        label: def.label,
        description: def.description,
        domain: DOMAIN_LABEL[def.domain] ?? def.domain,
        kinds: kindsForMetric(def.unit),
        caveat: def.caveat,
      };
    }),
    ...SERIES.map((s) => ({
      id: s.id,
      kind: 'series' as const,
      label: s.label,
      description: s.description,
      domain: DOMAIN_LABEL.series,
      kinds: s.kinds as WidgetKind[],
    })),
  ];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-2xl">Board</h1>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {board.window.start} → {board.window.end} · built {formatIST(board.builtAt, { withTime: true })}
            {listing.isDefault && ' · showing the starting board'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AddWidgetButton options={options} disabled={listing.readOnlyReason} />
        </div>
      </header>

      {board.warnings.length > 0 && (
        <div className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-3 py-2 text-2xs text-[var(--text-muted)]">
          {board.warnings.map((w) => (
            <div key={w}>▲ {w}</div>
          ))}
        </div>
      )}

      {/* Twelve columns, like every board product, so a tile's size is a real
          choice rather than a suggestion the layout ignores. */}
      <div className="grid grid-cols-12 gap-3">
        {board.widgets.map((w) => (
          <Tile
            key={w.spec.id}
            widget={w}
            onRemove={listing.readOnlyReason ? undefined : <RemoveWidgetButton widgetId={w.spec.id} />}
          />
        ))}
      </div>

      {board.widgets.length === 0 && (
        <p className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-6 text-xs text-[var(--text-muted)]">
          This board is empty. Add a tile — every option is a §5 metric or a declared list, so whatever
          you put here arrives with its formula, its source and its freshness attached.
        </p>
      )}

      <p className="text-2xs text-[var(--text-muted)]">
        A tile shows the same number as its page, because it is the same metric — nothing here
        computes. Definitions are in{' '}
        <Link href="/reference" className="text-[var(--color-ion)] underline">
          Reference
        </Link>
        ; targets come from{' '}
        <Link href="/settings" className="text-[var(--color-ion)] underline">
          Settings
        </Link>{' '}
        unless a tile overrides one.
        {listing.readOnlyReason && (
          <span className="ml-1 text-[var(--color-warn)]">{listing.readOnlyReason}</span>
        )}
      </p>
    </div>
  );
}
