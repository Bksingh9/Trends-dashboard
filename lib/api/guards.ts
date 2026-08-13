/**
 * Request guards for the write-ish and expensive endpoints.
 *
 * Two things this exists for: a cron URL must not be triggerable by anyone who
 * can guess it (each run can cost a BigQuery scan), and `/api/ask` must not be
 * a free channel into the model or the database (§28.9).
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Constant-time string comparison. A plain `===` on a secret leaks its prefix
 * length through timing; for a shared cron secret that is a small risk, but it
 * costs nothing to close.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself be a leak, so
  // compare against a same-length buffer and AND in the length check.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function isCronAuthorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret) {
    // No secret configured: allowed outside production so a local run works,
    // denied in production so an unprotected deploy fails closed rather than
    // exposing an endpoint that can run up a BigQuery bill.
    return process.env.NODE_ENV !== 'production';
  }
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  return safeEqual(header, expected);
}

/**
 * §28.9 — rate-limit `/api/ask` per user. In-memory and per-instance, which is
 * the right amount of machinery for an internal dashboard: it stops a runaway
 * loop or an impatient user, and it is not trying to stop an attacker who
 * already has an authenticated session.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}

const buckets = new Map<string, number[]>();

export function rateLimit(
  key: string,
  { limit = 20, windowSeconds = 60 }: { limit?: number; windowSeconds?: number } = {},
): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

  if (hits.length >= limit) {
    const oldest = hits[0];
    buckets.set(key, hits);
    return {
      allowed: false,
      remaining: 0,
      resetInSeconds: Math.ceil((windowMs - (now - oldest)) / 1000),
    };
  }

  hits.push(now);
  buckets.set(key, hits);

  // Opportunistic cleanup so the map cannot grow without bound.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }

  return { allowed: true, remaining: limit - hits.length, resetInSeconds: windowSeconds };
}

export function resetRateLimits(): void {
  buckets.clear();
}
