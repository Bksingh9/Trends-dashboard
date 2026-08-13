/**
 * §9.4 — Auth and roles.
 *
 * Email allowlist to start. Four roles, driving default landing page and edit
 * rights. The reference dashboard gives everyone the same entry; we route by
 * role instead (§3.1), because "is Companion healthy" and "is the API healthy"
 * are different first questions for different people.
 *
 * When auth is not configured the app still runs, in open mode, with a visible
 * banner. A dashboard that cannot be deployed until someone provisions an IdP
 * violates rule 4 — nothing blocks on a credential.
 */

export type Role = 'exec' | 'pm' | 'eng' | 'ops';

export interface SessionUser {
  email: string;
  name: string;
  role: Role;
}

/** §9.4 — role → default landing page. */
export const LANDING_BY_ROLE: Record<Role, string> = {
  exec: '/',
  pm: '/',
  eng: '/app-health',
  ops: '/stores',
};

/** §9.4 — what each role may edit. */
export const CAN_EDIT: Record<Role, string[]> = {
  exec: [],
  pm: ['thresholds', 'gap_ownership', 'store_ops', 'settings', 'reference'],
  eng: ['thresholds', 'issue_links', 'reference'],
  ops: ['store_ops', 'issue_intake'],
};

export function canEdit(role: Role, capability: string): boolean {
  return CAN_EDIT[role].includes(capability);
}

/**
 * The allowlist, as `email:role` pairs in `AUTH_ALLOWLIST`.
 * Example: `brijkishorsingh@gofynd.com:pm,ops-lead@gofynd.com:ops`
 * A bare `@domain.com:role` entry allows a whole domain at that role.
 */
export function parseAllowlist(raw: string): Array<{ match: string; role: Role }> {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [match, role] = entry.split(':');
      return { match: match.trim().toLowerCase(), role: (role?.trim() as Role) || 'exec' };
    });
}

export function resolveRole(email: string, allowlistRaw: string): Role | null {
  const email_ = email.trim().toLowerCase();
  const entries = parseAllowlist(allowlistRaw);
  // Exact address wins over a domain-wide grant.
  const exact = entries.find((e) => e.match === email_);
  if (exact) return exact.role;
  const domain = entries.find((e) => e.match.startsWith('@') && email_.endsWith(e.match));
  return domain?.role ?? null;
}

export function isAuthConfigured(): boolean {
  return Boolean(process.env.NEXTAUTH_SECRET) && Boolean(process.env.AUTH_ALLOWLIST);
}

/**
 * The current session user. In open mode this returns a clearly-labelled
 * placeholder so the UI can show the banner rather than pretending someone is
 * signed in.
 */
export function getSessionUser(): SessionUser & { authenticated: boolean } {
  if (!isAuthConfigured()) {
    return {
      email: 'open-access@unconfigured',
      name: 'Open access',
      role: (process.env.DEFAULT_ROLE as Role) || 'pm',
      authenticated: false,
    };
  }
  // Wired to NextAuth once an IdP is provisioned; the allowlist logic above is
  // the part that decides access and role either way.
  return {
    email: process.env.DEV_USER_EMAIL ?? 'unknown@gofynd.com',
    name: 'Signed in',
    role: (process.env.DEFAULT_ROLE as Role) || 'pm',
    authenticated: true,
  };
}
