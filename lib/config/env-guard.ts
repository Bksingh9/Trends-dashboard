/**
 * §0 — Production-only enforcement.
 *
 * This dashboard reads production data exclusively. One environment, one
 * application id, one GA4 property, one BigQuery project. UAT / Z0 / Z5 are out
 * of scope and must not be wired in.
 *
 * Why this is mechanical rather than a convention: mixing a pre-production
 * affiliate id into `avis_base_view` queries, or a UAT store into `dim_store`,
 * silently corrupts every business number on the dashboard — and the corruption
 * is invisible, because test orders look exactly like real ones.
 */

export const PROD_AFFILIATE = '6978c8d5b2f0316521d38b37';

/** Patterns that identify a non-production environment. See §0 and §2.2. */
const FORBIDDEN: RegExp[] = [
  /693c0445d7f8e24a31075570/, // the UAT application id
  /snghostz\d/i,
  /sngz\d/i,
  /platform\.sngz/i,
  /\.de\b/i,
  /\buat\b/i,
];

/**
 * Keys whose values are opaque secrets rather than environment identifiers.
 *
 * Scanning a random secret for environment markers is both pointless (a token is
 * not an environment identifier) and actively harmful: a base64 secret
 * containing the substring `-uat-` would hard-fail boot for no reason. Secrets
 * are excluded from the scan; every value that actually names an environment is
 * still covered. Recorded as a deviation in ADR-000.
 */
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|_KEY|KEY_JSON|CREDENTIALS|DATABASE_URL)$/i;

export class NonProductionValueError extends Error {
  constructor(
    readonly key: string,
    readonly value: string,
  ) {
    super(`Non-production value in ${key}: ${value} — see §0`);
    this.name = 'NonProductionValueError';
  }
}

/**
 * Runs at boot. Throws on any non-production value reaching config.
 *
 * Deliberately throws rather than warns: a dashboard that boots against UAT and
 * shows the numbers to Reliance leadership is the failure this prevents.
 */
export function assertProductionOnly(cfg: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === '') continue;
    if (SECRET_KEY_PATTERN.test(k)) continue;
    for (const pat of FORBIDDEN) {
      if (pat.test(v)) throw new NonProductionValueError(k, v);
    }
  }

  const affiliate = cfg.COMPANION_PROD_AFFILIATE_ID;
  if (affiliate !== undefined && affiliate !== PROD_AFFILIATE) {
    throw new Error(
      `Affiliate id is not the production id (got ${affiliate}, expected ${PROD_AFFILIATE}) — see §0`,
    );
  }
}

/**
 * Row-level environment enforcement (§0 consequence 1, §15.5).
 *
 * Connectors assert the environment of what they *ingested*, not just that
 * config looked right. `bq-orders` refuses to load rows carrying any other
 * affiliate id.
 */
export function assertRowsAreProduction<T extends { affiliate_id?: string | null }>(
  rows: T[],
): { ok: true } | { ok: false; offending: string[] } {
  const offending = new Set<string>();
  for (const r of rows) {
    const id = r.affiliate_id;
    if (id != null && id !== PROD_AFFILIATE) offending.add(id);
  }
  return offending.size === 0 ? { ok: true } : { ok: false, offending: [...offending] };
}
