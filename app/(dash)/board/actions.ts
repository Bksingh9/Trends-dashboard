'use server';

/**
 * §4.10 — board mutations.
 *
 * Validation lives in `lib/widgets/store.ts` and runs here on the server, not
 * only in the form. A widget saved pointing at a metric that does not exist is
 * a permanent "unavailable" tile nobody can explain, so it is refused at the
 * point somebody can still fix the choice.
 */
import { revalidatePath } from 'next/cache';
import { addWidget, removeWidget, WidgetRejected, type AddWidgetInput } from '@/lib/widgets/store';

export interface BoardOutcome {
  ok: boolean;
  message: string;
}

export async function addWidgetAction(input: AddWidgetInput): Promise<BoardOutcome> {
  try {
    const spec = await addWidget(input);
    revalidatePath('/board');
    return { ok: true, message: `Added ${spec.title ?? spec.metricId ?? spec.seriesId}.` };
  } catch (e) {
    if (e instanceof WidgetRejected) return { ok: false, message: e.message };
    return {
      ok: false,
      message: `Could not save the widget: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
    };
  }
}

export async function removeWidgetAction(widgetId: string): Promise<BoardOutcome> {
  try {
    await removeWidget(widgetId);
    revalidatePath('/board');
    return { ok: true, message: 'Removed.' };
  } catch (e) {
    if (e instanceof WidgetRejected) return { ok: false, message: e.message };
    return {
      ok: false,
      message: `Could not remove it: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
    };
  }
}
