/**
 * §9.5 — stored credentials.
 *
 * Letting someone paste a secret into a form takes on a duty the `.env` model
 * never had: those secrets now live in a database that gets backed up,
 * replicated and read from a psql prompt. Most of what follows is about that
 * duty rather than about the feature working.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CredentialKeyMissing,
  decryptSecret,
  encryptSecret,
  isCredentialStorageConfigured,
  maskSecret,
} from '@/lib/credentials/crypto';
import { getSourceType, SOURCE_TYPES, secretFields, validate } from '@/lib/credentials/source-types';
import { unmappedSupersedes, FIELD_TO_ENV } from '@/lib/credentials/apply';
import { testConnection, TESTS } from '@/lib/credentials/test-connection';

const KEY = 'test-credential-key-at-least-16-chars-long';

/**
 * Token literals here are deliberately built by concatenation and read
 * `xoxb-NOT-A-REAL-TOKEN`. A test fixture shaped like a real Slack token trips
 * GitHub push protection and blocks the whole branch — which is the scanner
 * working correctly. Keep the prefix, because the validator checks it; keep the
 * rest obviously fake.
 */

describe('encryption at rest', () => {
  it('round-trips a secret', () => {
    vi.stubEnv('CREDENTIAL_KEY', KEY);
    const secret = `xoxb-${'NOT'}-A-REAL-TOKEN-example`;
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    vi.unstubAllEnvs();
  });

  it('never produces the same ciphertext twice', () => {
    // A deterministic ciphertext leaks equality: an attacker with the database
    // could see that two tenants share a token without decrypting either.
    vi.stubEnv('CREDENTIAL_KEY', KEY);
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
    vi.unstubAllEnvs();
  });

  it('refuses to encrypt without a key rather than falling back to a default', () => {
    // A hardcoded fallback key is no encryption while looking like encryption,
    // which is worse — it stops anyone asking the question.
    vi.stubEnv('CREDENTIAL_KEY', '');
    expect(() => encryptSecret('x')).toThrow(CredentialKeyMissing);
    expect(isCredentialStorageConfigured()).toBe(false);
    vi.unstubAllEnvs();
  });

  it('rejects a key too short to be meaningful', () => {
    vi.stubEnv('CREDENTIAL_KEY', 'short');
    expect(isCredentialStorageConfigured()).toBe(false);
    expect(() => encryptSecret('x')).toThrow();
    vi.unstubAllEnvs();
  });

  it('detects tampering instead of decrypting to something plausible', () => {
    vi.stubEnv('CREDENTIAL_KEY', KEY);
    const enc = encryptSecret(`xoxb-${'NOT'}-A-REAL-TOKEN`);
    const [v, iv, tag, data] = enc.split(':');
    // Flip a byte of ciphertext. GCM's tag must catch it.
    const bytes = Buffer.from(data, 'base64url');
    bytes[0] ^= 0xff;
    const tampered = [v, iv, tag, bytes.toString('base64url')].join(':');
    expect(() => decryptSecret(tampered)).toThrow();
    vi.unstubAllEnvs();
  });

  it('will not decrypt with a different key', () => {
    vi.stubEnv('CREDENTIAL_KEY', KEY);
    const enc = encryptSecret('secret');
    vi.stubEnv('CREDENTIAL_KEY', 'a-completely-different-key-value-here');
    expect(() => decryptSecret(enc)).toThrow();
    vi.unstubAllEnvs();
  });

  it('rejects a malformed or version-mismatched blob', () => {
    vi.stubEnv('CREDENTIAL_KEY', KEY);
    for (const bad of ['', 'nonsense', 'v2:a:b:c', 'v1:only:two']) {
      expect(() => decryptSecret(bad)).toThrow();
    }
    vi.unstubAllEnvs();
  });
});

describe('masking — what the UI may see', () => {
  it('shows only the last four characters of a token', () => {
    expect(maskSecret(`xoxb-${'NOT'}-A-REAL-TOKEN-abcdefghijk`)).toBe('••••hijk');
  });

  it('never reveals a short secret at all', () => {
    expect(maskSecret('abc')).toBe('••••');
    expect(maskSecret('12345678')).toBe('••••');
  });

  it('describes a service-account key by its email, not its bytes', () => {
    const sa = JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'x' });
    expect(maskSecret(sa)).toBe('service account · bot@p.iam.gserviceaccount.com');
    expect(maskSecret(sa)).not.toContain('private_key');
  });

  it('leaks no more than four characters of any input', () => {
    const secret = 'supersecrettokenvalue';
    const masked = maskSecret(secret);
    const revealed = [...masked].filter((c) => c !== '•').length;
    expect(revealed).toBeLessThanOrEqual(4);
  });
});

describe('the source catalogue', () => {
  it('gives every type a test description and something it turns on', () => {
    for (const t of SOURCE_TYPES) {
      expect(t.fields.length, `${t.id} has no fields`).toBeGreaterThan(0);
      expect(t.enables.length, `${t.id} turns nothing on`).toBeGreaterThan(0);
      expect(t.testDescription, `${t.id} does not say what its test does`).toBeTruthy();
      expect(t.blurb.length).toBeGreaterThan(20);
    }
  });

  it('marks every credential-shaped field as secret', () => {
    // A field called "token" stored as plain config would sit in a jsonb column
    // in cleartext. The naming check is crude on purpose — it is there to catch
    // the fifteenth source type somebody adds in a hurry.
    //
    // The exemptions are named individually rather than by loosening the
    // pattern: a Jira *project* key is `NI`, and a GCP *project* id is public.
    // Widening the regex to let those through would also let a real token
    // through, which is the whole thing this is guarding.
    const NOT_SECRETS = new Set(['projectKey', 'projectId', 'apiKey', 'apiKeyPublic', 'clientId']);
    for (const t of SOURCE_TYPES) {
      const secrets = new Set(secretFields(t));
      for (const f of t.fields) {
        if (NOT_SECRETS.has(f.key)) continue;
        if (/token|key|password|secret|credential/i.test(f.key)) {
          expect(secrets.has(f.key), `${t.id}.${f.key} is not marked secret`).toBe(true);
        }
      }
    }
    // …and the exempted ones really are harmless to store in cleartext.
    expect(secretFields(getSourceType('jira')!)).not.toContain('projectKey');
    expect(secretFields(getSourceType('bigquery')!)).not.toContain('projectId');
    // `apiKey` is exempt from the *pattern*, not from being secret.
    expect(secretFields(getSourceType('anthropic')!)).toContain('apiKey');
    expect(secretFields(getSourceType('slack')!)).toContain('botToken');
    expect(secretFields(getSourceType('postgres')!)).toContain('url');
  });

  it('maps every superseded env var, so a saved source really takes effect', () => {
    // The failure this prevents: someone pastes a token, sees it saved, and
    // reasonably concludes the connector is configured — while nothing reads it.
    expect(unmappedSupersedes()).toEqual([]);
  });

  it('never maps two fields of one type onto the same env var', () => {
    for (const [type, map] of Object.entries(FIELD_TO_ENV)) {
      const vars = Object.values(map);
      expect(new Set(vars).size, `${type} maps two fields to one env var`).toBe(vars.length);
    }
  });

  it('validates required fields before any network call', () => {
    const slack = getSourceType('slack')!;
    const empty = validate(slack, {});
    expect(empty.ok).toBe(false);
    expect(empty.errors.some((e) => e.field === 'botToken')).toBe(true);
  });

  it('rejects a token of obviously the wrong shape', () => {
    const slack = getSourceType('slack')!;
    const wrong = validate(slack, { botToken: 'not-a-slack-token' });
    expect(wrong.ok).toBe(false);
    expect(wrong.errors[0].message).toMatch(/xoxb-/);

    expect(validate(slack, { botToken: `xoxb-${'NOT'}-A-REAL-TOKEN` }).ok).toBe(true);
  });

  it('rejects a Postgres URL that is not one', () => {
    const pg = getSourceType('postgres')!;
    expect(validate(pg, { url: 'mysql://x' }).ok).toBe(false);
    expect(validate(pg, { url: 'postgres://u:p@h:5432/d' }).ok).toBe(true);
  });

  it('rejects a service-account blob with no private key', () => {
    const bq = getSourceType('bigquery')!;
    const r = validate(bq, { serviceAccountJson: '{"type":"service_account"}', projectId: 'p' });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/private_key/);
  });
});

describe('every offered type is actually connectable', () => {
  /**
   * The structural guard, added after five types shipped in the picker with no
   * test and no connector behind them. A type that can be chosen but cannot be
   * connected is the same failure as a mart with no writer: it looks configured
   * and does nothing. Adding a type without a test now fails here rather than
   * in front of somebody holding a token.
   */
  it('has a real connection test for every type in the catalogue', () => {
    const missing = SOURCE_TYPES.filter((t) => !TESTS[t.id]).map((t) => t.id);
    expect(missing, `no connection test for: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no test for a type that is not offered', () => {
    const ids = new Set(SOURCE_TYPES.map((t) => t.id));
    expect(Object.keys(TESTS).filter((k) => !ids.has(k))).toEqual([]);
  });

  it('validates shape before making any network call', async () => {
    // A blank form must not reach the wire. This also proves the validation the
    // form does client-side is enforced again on the server, where it counts.
    const r = await testConnection('rest-api', {});
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/required/i);
    expect(r.steps.every((s) => s.ok === false)).toBe(true);
  });

  it('rejects a plaintext http endpoint before sending the credential', async () => {
    const r = await testConnection('rest-api', {
      baseUrl: 'http://example.com/rows',
      authHeader: 'Bearer would-have-been-sent-in-clear',
    });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/https/i);
  });

  it('rejects a Snowflake key that is not a PEM before signing anything', async () => {
    const r = await testConnection('snowflake', {
      account: 'xy12345.ap-south-1',
      username: 'svc',
      privateKey: 'not a pem',
      warehouse: 'WH',
      database: 'DB',
    });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/PKCS#8|PEM/i);
  });
});

describe('connection tests never throw to the UI', () => {
  it('returns a failure result for an unknown type', async () => {
    const r = await testConnection('does-not-exist', {});
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Unknown source type/);
  });

  it('reports a bad credential as a failed result, not an exception', async () => {
    // A thrown test is indistinguishable from a failed connection, and the
    // difference matters: one is "your key is wrong", the other is "our code is".
    const r = await testConnection('postgres', { url: 'postgres://nobody@127.0.0.1:1/none' });
    expect(r.ok).toBe(false);
    expect(r.steps.length).toBeGreaterThan(0);
    expect(r.steps.every((s) => typeof s.detail === 'string')).toBe(true);
  });

  it('names the hop that failed rather than saying "connector down"', async () => {
    // A key that clears the shape check but is not usable gets as far as the
    // real hops, and the result says which one broke.
    const r = await testConnection('bigquery', {
      serviceAccountJson: '{"type":"service_account","private_key":"nonsense","client_email":"a@b.iam.gserviceaccount.com"}',
      projectId: 'p',
    });
    expect(r.ok).toBe(false);
    expect(r.steps.length).toBeGreaterThan(0);
    expect(r.steps.some((s) => /parses|token exchange/i.test(s.label))).toBe(true);
    expect(r.steps.some((s) => !s.ok)).toBe(true);
  });

  it('names the field, not the hop, when the credential never had a chance', async () => {
    // Rejected on shape: no token spent, no rate-limit budget, and the message
    // points at the input rather than at the network.
    const r = await testConnection('bigquery', { serviceAccountJson: 'not json', projectId: 'p' });
    expect(r.ok).toBe(false);
    expect(r.steps[0].label).toBe('Service account JSON');
    expect(r.steps[0].ok).toBe(false);
  });
});
