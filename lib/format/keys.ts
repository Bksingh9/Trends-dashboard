/**
 * §27.1 — Join keys.
 *
 * Any place a join happens without going through these functions is a bug
 * waiting to happen. Store-code and EAN normalisation account for most silent
 * join failures in retail data work.
 */
import { createHash } from 'node:crypto';
import { normalizeEan } from './ean';

/**
 * Platform store id. Trim, string, never numeric.
 *
 * §19.3: retail codes carry leading zeros. If any layer treats them as numeric,
 * `00421` becomes `421` and every join silently drops.
 */
export function normalizeStoreId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export interface StoreCodeResult {
  code: string;
  warning?: string;
}

/** Retail store code. Trim, preserve leading zeros, warn on unexpected shape. */
export function normalizeStoreCode(raw: unknown): StoreCodeResult {
  const code = String(raw ?? '').trim();
  if (code && !/^[A-Za-z0-9\-_]+$/.test(code)) {
    return { code, warning: `unexpected store code format: ${code}` };
  }
  return { code };
}

/** Internal item code. Trim, upper. */
export function normalizeItemCode(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase();
}

/** GA4 session identity: user_pseudo_id + ga_session_id, concatenated. */
export function sessionKey(userPseudoId: unknown, gaSessionId: unknown): string {
  return `${String(userPseudoId ?? '')}-${String(gaSessionId ?? '')}`;
}

/**
 * §27.4 — PII. `customer_id` is personal data belonging to Reliance and is
 * hashed with a server-side salt before it enters Postgres. New-vs-repeat
 * analysis works fine on hashes; the dashboard exposes no customer-level
 * drilldown in v1, so the plaintext is never needed downstream.
 */
export function hashCustomerId(raw: unknown, salt = process.env.CUSTOMER_ID_SALT ?? ''): string {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  if (!salt && process.env.NODE_ENV === 'production') {
    throw new Error('CUSTOMER_ID_SALT is required in production — see §27.4');
  }
  return createHash('sha256')
    .update(`${salt}:${v}`)
    .digest('hex')
    .slice(0, 32);
}

/** Re-exported so every join key lives behind one import. */
export { normalizeEan };
