'use server';

/**
 * §9.5 — server actions behind "Add a data source".
 *
 * Server actions rather than API routes, so a credential posted from a form
 * never becomes a URL, never lands in an access log, and never needs a
 * client-side fetch that could be replayed from the console.
 *
 * Every one of these is gated on the §9.4 `thresholds` capability. Adding a
 * credential is the most privileged thing this dashboard can do — more so than
 * running a connector, which is merely expensive.
 */
import { revalidatePath } from 'next/cache';
import { canEdit, getSessionUser } from '@/lib/auth';
import { isCredentialStorageConfigured } from '@/lib/credentials/crypto';
import {
  deleteSource,
  listSources,
  recordTest,
  saveSource,
  setEnabled,
  type StoredSource,
} from '@/lib/credentials/store';
import { getSourceType, validate } from '@/lib/credentials/source-types';
import { testConnection, type TestResult } from '@/lib/credentials/test-connection';

function authorise(): string | null {
  const user = getSessionUser();
  return canEdit(user.role, 'thresholds')
    ? null
    : `Your role (${user.role}) cannot manage data sources. §9.4 gives exec read-only access.`;
}

export interface SaveOutcome {
  ok: boolean;
  message: string;
  fieldErrors?: Array<{ field: string; message: string }>;
  test?: TestResult;
}

/**
 * Tests without saving.
 *
 * Deliberately separate from save, because the answer to "does this credential
 * work" is useful on its own — and because a credential that fails its test
 * should still be *savable*. The blocker is often on the other side (a sheet
 * not yet shared, a bot not yet invited), and forcing someone to re-paste a
 * 2 KB service-account key once the grant lands is hostile.
 */
export async function testSourceAction(
  typeId: string,
  values: Record<string, string>,
): Promise<SaveOutcome> {
  const denied = authorise();
  if (denied) return { ok: false, message: denied };

  const type = getSourceType(typeId);
  if (!type) return { ok: false, message: `Unknown source type "${typeId}"` };

  const v = validate(type, values);
  if (!v.ok) return { ok: false, message: 'Some fields need attention.', fieldErrors: v.errors };

  const test = await testConnection(typeId, values);
  return { ok: test.ok, message: test.summary, test };
}

export async function saveSourceAction(
  typeId: string,
  name: string,
  values: Record<string, string>,
): Promise<SaveOutcome> {
  const denied = authorise();
  if (denied) return { ok: false, message: denied };

  if (!isCredentialStorageConfigured()) {
    return {
      ok: false,
      message:
        'CREDENTIAL_KEY is not set, so this cannot be encrypted and will not be stored. ' +
        'Generate one with `openssl rand -base64 32` and set it in the environment.',
    };
  }

  const type = getSourceType(typeId);
  if (!type) return { ok: false, message: `Unknown source type "${typeId}"` };
  if (!name.trim()) return { ok: false, message: 'Give the source a name — two BigQuery projects need two names.' };

  const v = validate(type, values);
  if (!v.ok) return { ok: false, message: 'Some fields need attention.', fieldErrors: v.errors };

  try {
    const user = getSessionUser();
    const { sourceId } = await saveSource({ type: typeId, name: name.trim(), values, createdBy: user.email });

    // Tested after saving so the result is recorded against the row. A source
    // whose last test failed is visible on the card without anyone re-running it.
    const test = await testConnection(typeId, values);
    await recordTest(sourceId, test.ok, test.summary);

    revalidatePath('/connectors/sources');
    revalidatePath('/connectors');
    return {
      ok: true,
      message: test.ok
        ? `Saved. ${test.summary}`
        : `Saved, but the connection test failed: ${test.summary}`,
      test,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function toggleSourceAction(sourceId: number, enabled: boolean): Promise<SaveOutcome> {
  const denied = authorise();
  if (denied) return { ok: false, message: denied };
  await setEnabled(sourceId, enabled);
  revalidatePath('/connectors/sources');
  revalidatePath('/connectors');
  return { ok: true, message: enabled ? 'Enabled.' : 'Disabled — its credentials are kept.' };
}

export async function deleteSourceAction(sourceId: number): Promise<SaveOutcome> {
  const denied = authorise();
  if (denied) return { ok: false, message: denied };
  await deleteSource(sourceId);
  revalidatePath('/connectors/sources');
  revalidatePath('/connectors');
  return { ok: true, message: 'Deleted. The credential is gone; the environment variable, if any, takes over again.' };
}

export async function listSourcesAction(): Promise<StoredSource[]> {
  return listSources();
}
