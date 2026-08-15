/**
 * §4.10 — reading and writing a saved board.
 *
 * With no database, or with an empty table, `DEFAULT_BOARD` is served. That is
 * a deliberate difference from the data-sources page, which blocks without
 * storage: a credential nobody can save is a feature that silently does
 * nothing, whereas a board nobody can save is still a perfectly good board —
 * it just resets. Saying so is enough.
 */
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { dashboardWidget } from '@/lib/db/schema';
import { getMetric } from '@/lib/metrics/registry';
import { getSeries } from './series';
import { DEFAULT_BOARD } from './board';
import { WIDGET_KINDS, type WidgetSize, type WidgetSpec } from './types';

export const DEFAULT_BOARD_NAME = 'default';

export interface BoardListing {
  specs: WidgetSpec[];
  /** True when these are the built-in defaults rather than a saved layout. */
  isDefault: boolean;
  /** Set when a layout cannot be saved, so the page can say why. */
  readOnlyReason?: string;
}

export async function listWidgets(board = DEFAULT_BOARD_NAME): Promise<BoardListing> {
  const db = getDb();
  if (!db) {
    return {
      specs: DEFAULT_BOARD,
      isDefault: true,
      readOnlyReason: 'No DATABASE_URL, so changes to this board cannot be saved.',
    };
  }

  try {
    const rows = await db
      .select()
      .from(dashboardWidget)
      .where(eq(dashboardWidget.board, board))
      .orderBy(asc(dashboardWidget.position));

    if (rows.length === 0) return { specs: DEFAULT_BOARD, isDefault: true };

    return {
      specs: rows.map((r) => ({
        id: r.widgetId,
        kind: r.kind as WidgetSpec['kind'],
        metricId: r.metricId ?? undefined,
        seriesId: r.seriesId ?? undefined,
        title: r.title ?? undefined,
        target: r.target == null ? null : Number(r.target),
        size: r.size as WidgetSize,
        order: r.position,
      })),
      isDefault: false,
    };
  } catch (e) {
    // A missing table is the common case before `db:push`, and it must not be
    // an error page — the board still works, it just will not persist.
    return {
      specs: DEFAULT_BOARD,
      isDefault: true,
      readOnlyReason: `Board storage is unavailable (${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}). Run \`npm run db:push\`.`,
    };
  }
}

export interface AddWidgetInput {
  kind: string;
  metricId?: string;
  seriesId?: string;
  title?: string;
  size?: string;
  target?: number | null;
  board?: string;
}

export class WidgetRejected extends Error {}

/**
 * Validated before insert, not on render.
 *
 * A row pointing at a metric that does not exist would render as a permanent
 * "unavailable" tile that nobody can explain — better to refuse it at the point
 * somebody can still fix the choice.
 */
export function validateWidget(input: AddWidgetInput): WidgetSpec {
  const kind = input.kind as WidgetSpec['kind'];
  if (!WIDGET_KINDS.includes(kind)) throw new WidgetRejected(`Unknown widget kind "${input.kind}"`);

  const size = (input.size ?? 'sm') as WidgetSize;
  if (!['sm', 'md', 'lg'].includes(size)) throw new WidgetRejected(`Unknown size "${input.size}"`);

  if (kind === 'text') {
    if (!input.title?.trim()) throw new WidgetRejected('A text tile needs something to say');
    return { id: newId(), kind, title: input.title.trim(), size, order: 0 };
  }

  if (kind === 'leaderboard' || kind === 'trend') {
    const def = input.seriesId ? getSeries(input.seriesId) : undefined;
    if (!def) throw new WidgetRejected(`A ${kind} needs a series; "${input.seriesId ?? ''}" is not one`);
    if (!def.kinds.includes(kind)) {
      // A leaderboard of a daily time series ranks dates, which is nonsense
      // that renders perfectly well.
      throw new WidgetRejected(`"${def.label}" cannot be drawn as a ${kind} — it supports ${def.kinds.join(', ')}`);
    }
    return { id: newId(), kind, seriesId: def.id, title: input.title?.trim() || undefined, size, order: 0 };
  }

  const metric = input.metricId ? getMetric(input.metricId) : undefined;
  if (!metric) throw new WidgetRejected(`"${input.metricId ?? ''}" is not a metric in the §5 registry`);
  if ((kind === 'goal' || kind === 'gauge') && metric.unit === 'count' && input.target == null) {
    // A goal with no target draws a progress bar against an invented ceiling.
    throw new WidgetRejected(`A ${kind} on a count metric needs an explicit target`);
  }

  return {
    id: newId(),
    kind,
    metricId: metric.id,
    title: input.title?.trim() || undefined,
    target: input.target ?? null,
    size,
    order: 0,
  };
}

export async function addWidget(input: AddWidgetInput): Promise<WidgetSpec> {
  const spec = validateWidget(input);
  const board = input.board ?? DEFAULT_BOARD_NAME;
  const db = getDb();
  if (!db) throw new WidgetRejected('No database is configured, so this board cannot be saved.');

  const existing = await listWidgets(board);
  // The first save materialises the defaults, so adding one tile to the
  // starting board does not silently discard the other ten.
  if (existing.isDefault) {
    await db.insert(dashboardWidget).values(
      DEFAULT_BOARD.map((w) => ({
        widgetId: `${board}-${w.id}`,
        board,
        kind: w.kind,
        metricId: w.metricId ?? null,
        seriesId: w.seriesId ?? null,
        title: w.title ?? null,
        target: w.target == null ? null : String(w.target),
        size: w.size,
        position: w.order,
      })),
    );
  }

  const position = Math.max(0, ...existing.specs.map((s) => s.order)) + 1;
  await db.insert(dashboardWidget).values({
    widgetId: spec.id,
    board,
    kind: spec.kind,
    metricId: spec.metricId ?? null,
    seriesId: spec.seriesId ?? null,
    title: spec.title ?? null,
    target: spec.target == null ? null : String(spec.target),
    size: spec.size,
    position,
  });

  return { ...spec, order: position };
}

export async function removeWidget(widgetId: string, board = DEFAULT_BOARD_NAME): Promise<void> {
  const db = getDb();
  if (!db) throw new WidgetRejected('No database is configured.');

  const existing = await listWidgets(board);
  if (existing.isDefault) {
    // Removing from the starting board means saving it first, minus that one —
    // otherwise the removal appears to work and is gone on the next render.
    const keep = DEFAULT_BOARD.filter((w) => w.id !== widgetId);
    await db.insert(dashboardWidget).values(
      keep.map((w) => ({
        widgetId: `${board}-${w.id}`,
        board,
        kind: w.kind,
        metricId: w.metricId ?? null,
        seriesId: w.seriesId ?? null,
        title: w.title ?? null,
        target: w.target == null ? null : String(w.target),
        size: w.size,
        position: w.order,
      })),
    );
    return;
  }

  await db.delete(dashboardWidget).where(eq(dashboardWidget.widgetId, widgetId));
}

function newId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
