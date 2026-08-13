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

let cachedKey: ServiceAccountKey | null | undefined;

export function serviceAccountKey(): ServiceAccountKey | null {
  if (cachedKey !== undefined) return cachedKey;
  if (!config.gcpSaKeyJson) {
    cachedKey = null;
    return null;
  }
  try {
    const raw = config.gcpSaKeyJson.trim();
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

let tokenCache: { token: string; expiresAt: number } | null = null;

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** Exchanges a signed JWT for an OAuth access token. Cached until ~1 min before expiry. */
export async function getAccessToken(scopes: readonly string[] = GCP_SCOPES): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const key = serviceAccountKey();
  if (!key) throw new Error('GCP_SA_KEY_JSON not configured — see §13.2');

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
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

export function resetTokenCache(): void {
  tokenCache = null;
  cachedKey = undefined;
}
