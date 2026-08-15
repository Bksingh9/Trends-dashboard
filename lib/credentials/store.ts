/**
 * Reading and writing configured data sources.
 *
 * The rule that makes this safe to add to a running system: **a source
 * configured in the UI wins, and the environment variable is the fallback.**
 * Existing deploys keep working untouched, and the UI says which is in force
 * rather than leaving two sources of truth to disagree quietly — which is the
 * same class of bug as a stale mart rendering as live.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { dataSource } from '@/lib/db/schema';
import { decryptSecret, encryptSecret, isCredentialStorageConfigured, maskSecret } from './crypto';
import { getSourceType, secretFields, type SourceType } from './source-types';

export interface StoredSource {
  sourceId: number;
  type: string;
  name: string;
  config: Record<string, string>;
  /** Masked only. The plaintext never leaves the server. */
  secretPreview: Record<string, string>;
  enabled: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
}

export interface ResolvedSource extends StoredSource {
  /** Decrypted. Server-side callers only — never serialise this to a client. */
  secrets: Record<string, string>;
}

function toStored(r: typeof dataSource.$inferSelect): StoredSource {
  return {
    sourceId: r.sourceId,
    type: r.type,
    name: r.name,
    config: (r.config ?? {}) as Record<string, string>,
    secretPreview: (r.secretPreview ?? {}) as Record<string, string>,
    enabled: r.enabled,
    lastTestedAt: r.lastTestedAt?.toISOString() ?? null,
    lastTestOk: r.lastTestOk,
    lastTestDetail: r.lastTestDetail,
  };
}

/** Everything configured, safe to render. Never includes a decrypted secret. */
export async function listSources(): Promise<StoredSource[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db.select().from(dataSource).orderBy(dataSource.type, dataSource.name);
  return rows.map(toStored);
}

/**
 * One source with its secrets decrypted, for a connector to use.
 *
 * A decryption failure is deliberately *not* swallowed. It means the
 * `CREDENTIAL_KEY` has changed or a row was tampered with, and continuing with
 * a partially-decrypted credential set would produce a confusing auth error far
 * from the real cause.
 */
export async function resolveSource(type: string, name?: string): Promise<ResolvedSource | null> {
  const db = getDb();
  if (!db || !isCredentialStorageConfigured()) return null;

  const rows = await db
    .select()
    .from(dataSource)
    .where(name ? and(eq(dataSource.type, type), eq(dataSource.name, name)) : eq(dataSource.type, type));

  const row = rows.find((r) => r.enabled) ?? null;
  if (!row) return null;

  const encrypted = (row.secrets ?? {}) as Record<string, string>;
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(encrypted)) {
    secrets[k] = decryptSecret(v);
  }
  return { ...toStored(row), secrets };
}

/**
 * A single value, UI-first with the environment as fallback.
 *
 * This is the function connectors call. `envVar` names what it falls back to,
 * so the precedence is visible at every call site rather than buried here.
 */
export async function credential(
  type: string,
  field: string,
  envVar: string,
): Promise<{ value: string; from: 'ui' | 'env' | 'unset' }> {
  try {
    const src = await resolveSource(type);
    const v = src?.secrets[field] ?? src?.config[field];
    if (v) return { value: v, from: 'ui' };
  } catch {
    // A broken stored credential must not take down a deploy that has a
    // perfectly good environment variable. Fall through and report `env`.
  }
  const env = process.env[envVar];
  return env ? { value: env, from: 'env' } : { value: '', from: 'unset' };
}

export interface SaveInput {
  type: string;
  name: string;
  values: Record<string, string>;
  createdBy?: string;
}

/**
 * Creates or replaces a source.
 *
 * Blank secret fields on an update mean "leave it alone", not "clear it" —
 * because the form cannot show the existing value, so an empty box is the
 * normal state when someone edits a channel id and nothing else. Treating blank
 * as a deletion would silently disconnect a working source every time somebody
 * fixed a typo.
 */
export async function saveSource(input: SaveInput): Promise<{ sourceId: number }> {
  const db = getDb();
  if (!db) throw new Error('No database configured — there is nowhere to store a credential.');
  if (!isCredentialStorageConfigured()) {
    throw new Error(
      'CREDENTIAL_KEY is not set, so credentials cannot be encrypted. Refusing to store one in plaintext.',
    );
  }

  const type = getSourceType(input.type);
  if (!type) throw new Error(`Unknown source type "${input.type}"`);

  const existing = (
    await db
      .select()
      .from(dataSource)
      .where(and(eq(dataSource.type, input.type), eq(dataSource.name, input.name)))
  )[0];

  const secretKeys = new Set(secretFields(type));
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = { ...((existing?.secrets ?? {}) as Record<string, string>) };
  const preview: Record<string, string> = { ...((existing?.secretPreview ?? {}) as Record<string, string>) };

  for (const f of type.fields) {
    const raw = (input.values[f.key] ?? '').trim();
    if (secretKeys.has(f.key)) {
      if (!raw) continue; // keep what is already stored
      secrets[f.key] = encryptSecret(raw);
      preview[f.key] = maskSecret(raw);
    } else {
      config[f.key] = raw;
    }
  }

  if (existing) {
    await db
      .update(dataSource)
      .set({ config, secrets, secretPreview: preview, updatedAt: new Date() })
      .where(eq(dataSource.sourceId, existing.sourceId));
    return { sourceId: existing.sourceId };
  }

  const [row] = await db
    .insert(dataSource)
    .values({
      type: input.type,
      name: input.name,
      config,
      secrets,
      secretPreview: preview,
      createdBy: input.createdBy ?? null,
    })
    .returning({ sourceId: dataSource.sourceId });
  return { sourceId: row.sourceId };
}

export async function setEnabled(sourceId: number, enabled: boolean): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.update(dataSource).set({ enabled, updatedAt: new Date() }).where(eq(dataSource.sourceId, sourceId));
}

export async function deleteSource(sourceId: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.delete(dataSource).where(eq(dataSource.sourceId, sourceId));
}

export async function recordTest(
  sourceId: number,
  ok: boolean,
  detail: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(dataSource)
    .set({ lastTestedAt: new Date(), lastTestOk: ok, lastTestDetail: detail.slice(0, 500) })
    .where(eq(dataSource.sourceId, sourceId));
}

/**
 * Which env vars a stored source is currently overriding.
 *
 * Rendered on the source card. Two credentials for the same thing is a
 * situation someone must be able to see, not discover during an incident.
 */
export function overriddenEnvVars(type: SourceType): string[] {
  return type.supersedes.filter((v) => Boolean(process.env[v]));
}
