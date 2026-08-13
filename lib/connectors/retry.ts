/**
 * §14.2 — Retry policy.
 *
 * `quotaExceeded` is deliberately non-retryable: retrying a blown daily quota
 * just burns the next window. Surface it red and stop.
 */

export interface RetryPolicy {
  attempts: number;
  backoff: 'exponential';
  jitter: number;
  retryOn: string[];
  neverRetryOn: string[];
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 4,
  backoff: 'exponential', // 1s, 4s, 16s, 64s
  jitter: 0.3,
  retryOn: [
    '429',
    '500',
    '502',
    '503',
    '504',
    'ETIMEDOUT',
    'ECONNRESET',
    'rateLimitExceeded',
    'backendError',
    'internalError',
  ],
  neverRetryOn: ['401', '403', 'accessDenied', 'notFound', 'invalidQuery', 'quotaExceeded'],
};

export function classifyError(e: unknown): { code: string; message: string; retryable: boolean } {
  const message = e instanceof Error ? e.message : String(e);
  const candidates = [
    (e as { code?: string | number })?.code,
    (e as { status?: number })?.status,
    (e as { statusCode?: number })?.statusCode,
    (e as { response?: { status?: number } })?.response?.status,
  ]
    .filter((c) => c != null)
    .map(String);

  const haystack = [...candidates, message].join(' ');

  for (const never of DEFAULT_RETRY.neverRetryOn) {
    if (haystack.includes(never)) return { code: never, message, retryable: false };
  }
  for (const on of DEFAULT_RETRY.retryOn) {
    if (haystack.includes(on)) return { code: on, message, retryable: true };
  }
  return { code: candidates[0] ?? 'unknown', message, retryable: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  onAttempt?: (attempt: number, err: unknown, waitMs: number) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const { retryable } = classifyError(e);
      const isLast = attempt === policy.attempts - 1;
      if (!retryable || isLast) throw e;
      const base = 4 ** attempt * 1000; // 1s, 4s, 16s, 64s
      const jitter = base * policy.jitter * (Math.random() * 2 - 1);
      const waitMs = Math.max(0, Math.round(base + jitter));
      onAttempt?.(attempt + 1, e, waitMs);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

/**
 * §14.3 — Slack is tier-limited and returns `Retry-After`. Respect it exactly
 * rather than guessing at a backoff.
 */
export async function respectRetryAfter(res: { status: number; headers: Headers }): Promise<boolean> {
  if (res.status !== 429) return false;
  const after = Number(res.headers.get('retry-after') ?? '1');
  await sleep((Number.isFinite(after) ? after : 1) * 1000);
  return true;
}
