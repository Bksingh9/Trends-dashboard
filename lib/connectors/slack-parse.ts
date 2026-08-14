/**
 * §18.8 — parsing what `#companion-app-alerts` actually posts.
 *
 * This module was written *after* reading the channel, against the verbatim
 * messages in `fixtures/slack-samples.ts`. The version it replaces treated
 * every message as opaque text, fingerprinted it, and used the first 180
 * characters as a title. Run against the real channel that produces rows whose
 * title is a Slack-markup blob, whose priority is decided by grepping for words
 * ("P0", "outage") that never appear in a Sentry alert, and which turn the
 * nightly roll-up into a fresh "issue" every single night.
 *
 * Two shapes share the channel and need different handling:
 *
 *   Sentry alert — one incident, with an error type, endpoint, event count,
 *                  affected users, state and short id. A `fact_issues` row.
 *   EOD digest   — a per-service count from the Manus-assistant bot. Not an
 *                  incident; loading it as one invents an issue a night.
 *
 * Anything else is a human talking, and must produce nothing at all.
 */

export type SlackMessageKind = 'sentry' | 'digest' | 'other';

export interface SentryAlert {
  /** `PromoIntegrationError`, `TypeError`, or the bare `Error`. */
  errorType: string;
  /** `POST /apply-promotions` — the operation, when the alert names one. */
  endpoint: string | null;
  /** The exception message inside the code fence. */
  message: string;
  /** Sentry's own stable identifier: `HASHIRA-1J`. The natural key. */
  shortId: string | null;
  /** `hashira`, `gringotts` — the service, not the numeric project id. */
  project: string | null;
  eventCount: number | null;
  /**
   * Null and zero are different: most alerts omit the line entirely, and
   * reading that as "nobody affected" would rank a 1,251-event outage below a
   * quiet one that happened to report a count.
   */
  usersAffected: number | null;
  /** `Regressed`, `New`, `Ongoing` — absent on many alerts. */
  state: string | null;
  firstSeen: string | null;
  issueUrl: string | null;
  environment: string | null;
}

export interface HealthDigest {
  /** `EOD 14 Aug`, as written. Not parsed to a date — the year is not stated. */
  label: string;
  services: Array<{ service: string; issues: number }>;
  totalIssues: number;
}

/** Strip Slack's `<url|label>` link markup down to the label. */
export function stripSlackLinks(text: string): string {
  return text.replace(/<([^|>]+)\|([^>]*)>/g, '$2').replace(/<(https?:[^>]+)>/g, '$1');
}

/** Strip `*bold*`, backticks and leading `:emoji:`. */
export function stripSlackFormatting(text: string): string {
  return stripSlackLinks(text)
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/[*`]/g, '')
    .trim();
}

/**
 * Which shape is this?
 *
 * Keyed off the sender first, because that is what Slack actually guarantees —
 * the Sentry app posts Sentry alerts. Content is the fallback for the case
 * where the bot is renamed, which has happened once already.
 */
export function classifyMessage(msg: { username?: string; text: string }): SlackMessageKind {
  const from = (msg.username ?? '').toLowerCase();
  if (from.includes('sentry') || /Short ID:\s*[A-Z]/.test(msg.text)) return 'sentry';
  if (from.includes('manus') || /Companion App Health\s*—\s*EOD/.test(msg.text)) return 'digest';
  return 'other';
}

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parses one Sentry alert. Returns null when the message is not one, rather
 * than a half-filled object — a row with no error type and no short id is
 * indistinguishable from a parse failure once it is in the mart.
 */
export function parseSentryAlert(text: string): SentryAlert | null {
  // The headline: `:red_circle: <url|*ErrorType*>`. The link label carries the
  // type; the href carries the issue id and the environment.
  const head = /<(https?:\/\/[^|]+)\|\*([^*]+)\*>/.exec(text);
  if (!head) return null;

  const issueUrl = head[1];
  const errorType = head[2].trim();

  const shortId = /Short ID:\s*([A-Z][A-Z0-9-]*)/.exec(text)?.[1] ?? null;
  // Without either an id or a code-fenced message there is nothing to key on.
  const fence = /```([\s\S]*?)```/.exec(text);
  if (!shortId && !fence) return null;

  // The line between the headline and the code fence, when there is one. It is
  // the operation (`POST /apply-promotions`), and it is what makes two
  // different failures of the same error type distinguishable.
  const lines = text.split('\n').map((l) => l.trim());
  const headIdx = lines.findIndex((l) => l.includes(head[0]));
  const candidate = lines[headIdx + 1] ?? '';
  const endpoint = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+\S+/.test(candidate) ? candidate : null;

  // `Project: <url|hashira>` — the label, not the numeric id in the href. The
  // numeric id is the Sentry-internal project key and means nothing to a
  // reader; the label is the service name people say out loud.
  const project = /Project:\s*<[^|]*\|([^>]+)>/.exec(text)?.[1]?.trim() ?? null;

  return {
    errorType,
    endpoint,
    message: fence ? fence[1].trim() : '',
    shortId,
    project,
    eventCount: num(/Events:\s*\*?([\d,]+)\*?/.exec(text)?.[1]),
    usersAffected: num(/Users Affected:\s*\*?([\d,]+)\*?/.exec(text)?.[1]),
    state: /State:\s*\*?([A-Za-z]+)\*?/.exec(text)?.[1] ?? null,
    firstSeen: /First Seen:\s*\*?(\d{4}-\d{2}-\d{2})\*?/.exec(text)?.[1] ?? null,
    issueUrl,
    environment: /[?&]environment=([a-z0-9_-]+)/i.exec(issueUrl)?.[1] ?? null,
  };
}

/** Parses the nightly per-service roll-up. */
export function parseHealthDigest(text: string): HealthDigest | null {
  const label = /\*Companion App Health\s*—\s*([^*]+)\*/.exec(text)?.[1]?.trim() ?? null;
  const fence = /```([\s\S]*?)```/.exec(text);
  if (!label || !fence) return null;

  const services: HealthDigest['services'] = [];
  for (const line of fence[1].split('\n')) {
    // `hashira           🟢  5 issues  ↑0% vs prev 24h`
    const m = /^([a-z][a-z0-9_-]*)\s+\S+\s+(\d+)\s+issues?/i.exec(line.trim());
    if (m) services.push({ service: m[1], issues: Number(m[2]) });
  }
  if (services.length === 0) return null;

  return { label, services, totalIssues: services.reduce((a, s) => a + s.issues, 0) };
}

/**
 * §8.4 — severity from impact, not from vocabulary.
 *
 * The old rule grepped for "P0", "critical", "down", "outage". None of those
 * words appear in a Sentry alert, so every real incident landed as P2 —
 * including a 1,251-event failure affecting 154 users.
 *
 * Thresholds are deliberately about *users*, then volume. An error firing
 * 1,251 times against 154 people is a different thing from one firing 466
 * times against nobody the tracker could identify.
 */
export function severityOf(a: SentryAlert): 'P0' | 'P1' | 'P2' | 'P3' {
  const users = a.usersAffected ?? 0;
  const events = a.eventCount ?? 0;

  if (users >= 100 || events >= 1000) return 'P0';
  if (users >= 10 || events >= 250) return 'P1';
  if (events >= 25) return 'P2';
  return 'P3';
}

/**
 * A stable key for one incident across every alert Slack sends about it.
 *
 * Sentry's short id is the right key when present: the same issue regressing
 * three times in a week is one problem, and keying on the message timestamp
 * would make it three. Falling back to a hash of type+endpoint keeps alerts
 * without a short id from colliding into a single row.
 */
export function issueKeyFor(a: SentryAlert): string {
  if (a.shortId) return `SENTRY-${a.shortId}`;
  const basis = `${a.errorType}|${a.endpoint ?? ''}|${a.message}`.toLowerCase();
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = (h * 31 + basis.charCodeAt(i)) | 0;
  return `SENTRY-X${Math.abs(h).toString(36).toUpperCase()}`;
}

/** A one-line title a human can act on, without Slack markup. */
export function titleFor(a: SentryAlert): string {
  const where = a.endpoint ? ` on ${a.endpoint}` : '';
  const svc = a.project ? ` [${a.project}]` : '';
  const detail = a.message ? ` — ${a.message}` : '';
  return `${a.errorType}${where}${svc}${detail}`.slice(0, 300);
}
