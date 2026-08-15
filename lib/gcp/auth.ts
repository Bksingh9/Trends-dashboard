/**
 * §14.4 — Secrets.
 *
 * One GCP service account covers BigQuery, the GA4 Data API, Sheets, and Cloud
 * Logging. The key arrives base64-encoded in `GCP_SA_KEY_JSON` and is decoded at
 * runtime into a credentials object — it is never written to disk.
 *
 * Auth is a self-signed JWT exchanged for an access token, which avoids pulling
 * in the full googleapis SDK for what is ~40 lines of crypto.
 */
import { createSign } from 'node:crypto';
import { config } from '@/lib/config';

export const GCP_SCOPES = [
  'https://www.googleapis.com/auth/bigquery.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/logging.read',
] as const;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/**
 * Cached against the raw credential, not merely "cached".
 *
 * `config` is built once at import from `process.env`, so a key that arrives
 * later — which is exactly what "Test connection" does, by setting
 * `GCP_SA_KEY_JSON` for the length of one call — was invisible. Every GCP
 * connection test failed with "GCP_SA_KEY_JSON not configured", including the
 * ones holding a perfectly good key, and the message blamed the credential.
 *
 * Reading `process.env` first and keying the cache on the value fixes both: a
 * new key is picked up, and an unchanged one is still parsed once.
 */
let cachedKey: ServiceAccountKey | null | undefined;
let cachedFrom: string | undefined;

function rawKeyJson(): string {
  return (process.env.GCP_SA_KEY_JSON ?? config.gcpSaKeyJson ?? '').trim();
}

export function serviceAccountKey(): ServiceAccountKey | null {
  const rawInput = rawKeyJson();
  if (cachedKey !== undefined && cachedFrom === rawInput) return cachedKey;
  cachedFrom = rawInput;
  if (!rawInput) {
    cachedKey = null;
    return null;
  }
  try {
    const raw = rawInput;
    // Accept either raw JSON or base64, so a paste-in-Vercel mistake is survivable.
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as ServiceAccountKey;
    cachedKey = parsed.client_email && parsed.private_key ? parsed : null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

export function isGcpConfigured(): boolean {
  return serviceAccountKey() !== null;
}

/**
 * Keyed by account **and** scopes.
 *
 * A single global token cache returns whichever token was fetched first. Test
 * one service account, then another, and the second reports "connected" on the
 * first one's token — a credential that was never checked, reported as working.
 * With two projects and two keys in play that is not hypothetical.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** Exchanges a signed JWT for an OAuth access token. Cached until ~1 min before expiry. */
export async function getAccessToken(scopes: readonly string[] = GCP_SCOPES): Promise<string> {
  const key = serviceAccountKey();
  if (!key) throw new Error('GCP_SA_KEY_JSON not configured — see §13.2');

  const cacheKey = `${key.client_email}|${[...scopes].sort().join(' ')}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes.join(' '),
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key.replace(/\\n/g, '\n'), 'base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`GCP token exchange failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

export function resetTokenCache(): void {
  tokenCache.clear();
  cachedKey = undefined;
  cachedFrom = undefined;
}
