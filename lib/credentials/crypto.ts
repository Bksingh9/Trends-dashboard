/**
 * Encryption for stored credentials.
 *
 * A dashboard that lets someone paste a credential into a form has taken on a
 * duty the `.env` model never had: those secrets now live in a database that
 * gets backed up, replicated, and read by anyone with a psql prompt. Storing
 * them in plaintext would be strictly worse than the environment variables this
 * replaces, so this is not optional and there is no "encryption off" mode.
 *
 * AES-256-GCM, because the tag makes tampering detectable. A secret that can be
 * silently altered is a secret that can be swapped for an attacker's endpoint.
 *
 * The key comes from `CREDENTIAL_KEY` and never from a default. A hardcoded
 * fallback key is the same as no encryption while looking like encryption,
 * which is worse, because it stops anyone asking the question.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard; 96 bits is what the mode is specified for
const TAG_BYTES = 16;

export class CredentialKeyMissing extends Error {
  constructor() {
    super(
      'CREDENTIAL_KEY is not set. Stored credentials cannot be encrypted, so they will not be stored at all. ' +
        'Generate one with: openssl rand -base64 32',
    );
    this.name = 'CredentialKeyMissing';
  }
}

/**
 * Accepts any passphrase and derives 32 bytes by SHA-256.
 *
 * Deliberately *not* a KDF with a work factor: this key comes from a secrets
 * manager or a generated env var, not from a human-chosen password, so there is
 * no low-entropy input for bcrypt/scrypt to defend. Adding one would imply a
 * threat model that does not apply and slow every read.
 */
function key(): Buffer {
  const raw = process.env.CREDENTIAL_KEY;
  if (!raw || raw.trim().length < 16) throw new CredentialKeyMissing();
  return createHash('sha256').update(raw.trim()).digest();
}

export function isCredentialStorageConfigured(): boolean {
  const raw = process.env.CREDENTIAL_KEY;
  return Boolean(raw && raw.trim().length >= 16);
}

/**
 * `v1:<iv>:<tag>:<ciphertext>`, all base64url.
 *
 * The version prefix is here from the first commit so a future algorithm change
 * can decrypt old rows instead of orphaning every credential in the database.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':');
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Stored credential is malformed or was written by a newer version');
  }
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Stored credential has an implausible IV or auth tag');
  }
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  // Throws on a bad tag — which is the point. A credential that has been
  // tampered with must fail loudly rather than decrypt to something plausible.
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * What the UI is allowed to see.
 *
 * A stored secret is **write-only** from the browser's point of view. Once
 * saved it is never sent back — not to re-populate a form, not to "reveal", not
 * to confirm. The only affordance is replace. Anything else turns every XSS in
 * the dashboard into a credential exfiltration.
 */
export function maskSecret(plaintext: string): string {
  const s = plaintext.trim();
  if (s.length <= 8) return '••••';
  // A service-account JSON blob has no meaningful tail; say what it is instead.
  if (s.startsWith('{')) {
    try {
      const email = (JSON.parse(s) as { client_email?: string }).client_email;
      return email ? `service account · ${email}` : 'service account JSON';
    } catch {
      return 'JSON credential';
    }
  }
  return `••••${s.slice(-4)}`;
}

/** Constant-time compare, for verifying a value the caller supplied. */
export function secretMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
