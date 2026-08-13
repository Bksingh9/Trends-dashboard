/**
 * §0 — production-only enforcement, at config level and at row level.
 *
 * Mixing a pre-production affiliate id into `avis_base_view` queries silently
 * corrupts every business number, and the corruption is invisible because test
 * orders look exactly like real ones.
 */
import { describe, expect, it } from 'vitest';
import {
  assertProductionOnly,
  assertRowsAreProduction,
  NonProductionValueError,
  PROD_AFFILIATE,
} from '@/lib/config/env-guard';

describe('assertProductionOnly', () => {
  it('accepts a production-only config', () => {
    expect(() =>
      assertProductionOnly({
        COMPANION_PROD_AFFILIATE_ID: PROD_AFFILIATE,
        GCP_PROJECT_ID: 'sng-prod',
        BQ_ORDERS_TABLE: 'sng-prod.sng_analytics_dwh.avis_base_view',
        COMPANION_PROD_API_HOST: 'https://trends-companion-app.jiocommerce.io',
      }),
    ).not.toThrow();
  });

  it('throws on the UAT application id', () => {
    expect(() =>
      assertProductionOnly({ SOME_ID: '693c0445d7f8e24a31075570' }),
    ).toThrow(NonProductionValueError);
  });

  it.each([
    ['snghostz5.example.com'],
    ['platform.sngz5.io'],
    ['https://uat.jiocommerce.io'],
    ['https://something.de/path'],
  ])('throws on non-production marker %s', (value) => {
    expect(() => assertProductionOnly({ SOME_HOST: value })).toThrow();
  });

  it('throws when the affiliate id is not the production id', () => {
    expect(() => assertProductionOnly({ COMPANION_PROD_AFFILIATE_ID: 'deadbeef' })).toThrow(
      /not the production id/,
    );
  });

  it('does not scan secret values for environment markers', () => {
    // A random base64 secret containing "-uat-" is not an environment
    // identifier, and hard-failing boot over it would be a false positive.
    expect(() =>
      assertProductionOnly({
        NEXTAUTH_SECRET: 'abc-uat-def',
        JIRA_API_TOKEN: 'x.de.y',
        DATABASE_URL: 'postgres://u:p@host/db',
        COMPANION_PROD_AFFILIATE_ID: PROD_AFFILIATE,
      }),
    ).not.toThrow();
  });
});

describe('assertRowsAreProduction — row level, not config level', () => {
  it('accepts rows carrying only the production affiliate id', () => {
    const r = assertRowsAreProduction([{ affiliate_id: PROD_AFFILIATE }, { affiliate_id: PROD_AFFILIATE }]);
    expect(r.ok).toBe(true);
  });

  it('rejects a batch containing any other affiliate id', () => {
    // §15.5 — connectors assert the environment of what they *ingested*, not
    // just that config looked right.
    const r = assertRowsAreProduction([
      { affiliate_id: PROD_AFFILIATE },
      { affiliate_id: '693c0445d7f8e24a31075570' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offending).toContain('693c0445d7f8e24a31075570');
  });

  it('ignores null affiliate ids rather than failing the whole load', () => {
    const r = assertRowsAreProduction([{ affiliate_id: null }, { affiliate_id: PROD_AFFILIATE }]);
    expect(r.ok).toBe(true);
  });
});
