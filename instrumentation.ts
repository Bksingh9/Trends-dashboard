/**
 * §0 — the production-only guard runs at boot, once per process, and throws on
 * violation. A dashboard that boots against UAT and shows those numbers to
 * Reliance leadership is the failure this prevents.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { validateConfig } = await import('@/lib/config');
  validateConfig();
}
