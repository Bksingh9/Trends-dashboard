/**
 * §18.4 — reading Slack from a snapshot when the API will not answer.
 *
 * The `AI Dashboard Bot` token authenticates today and lacks `channels:history`
 * until the workspace admin reinstalls it. That is a wait measured in days, and
 * the alternative to waiting is worse than it looks: without a read path the
 * catalogue pages sit on fixtures, and a fixture that stays up for a fortnight
 * stops being read as a fixture.
 *
 * So a snapshot directory is a first-class read source. Someone exports the
 * channel history they already have access to, drops the JSON in
 * `SLACK_SNAPSHOT_DIR`, and the connectors parse it with **exactly the same
 * code** that parses a live response — same shape in, same parser, same
 * assertions. The only difference is provenance, and provenance is never
 * silent: a run served from a snapshot is `cache`, never `live`, and the
 * warning names the file and its age.
 *
 * What this is not: a way to pretend the token works. `fromSnapshot` is only
 * reached after a real API attempt has failed, and the reason it failed is
 * carried into the warning.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/lib/config';
import type { SlackMessage } from './slack-catalogue-report';

export interface SnapshotRead {
  messages: SlackMessage[];
  /** The files actually read, for the warning. */
  files: string[];
  /** Newest `mtime` across those files, ISO. How stale the bridge is. */
  newestAt: string | null;
}

export class SnapshotUnavailable extends Error {}

/**
 * Accepts the two shapes a Slack export actually arrives in.
 *
 * The official workspace export writes `[{...}, {...}]` — a bare array of
 * messages per file. A `conversations.history` capture writes
 * `{ ok: true, messages: [...] }`. Requiring one of them would guarantee
 * somebody hands over the other, so both are read rather than documented.
 */
function messagesFrom(parsed: unknown): SlackMessage[] {
  if (Array.isArray(parsed)) return parsed as SlackMessage[];
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { messages?: unknown };
    if (Array.isArray(body.messages)) return body.messages as SlackMessage[];
  }
  return [];
}

/**
 * `process.env` first, then `config`.
 *
 * `config` is built once at import, so a value set afterwards is invisible to
 * it — the same trap that made every GCP connection test fail with "not
 * configured" while holding a good key (ADR-007). Reading the environment
 * directly here means a snapshot directory pointed at during a run is honoured,
 * and the tests exercise the same path production does.
 */
function snapshotDir(): string {
  return process.env.SLACK_SNAPSHOT_DIR || config.slackSnapshotDir || '';
}

export function isSnapshotConfigured(): boolean {
  return Boolean(snapshotDir());
}

/**
 * Reads every snapshot for one channel.
 *
 * Files are matched on the channel id appearing in the filename, so a directory
 * can hold several channels at once — which is what happens the moment somebody
 * exports more than one. A directory with no match for this channel throws
 * rather than returning zero messages: "no snapshots for C0AV6FU1YUU" is a
 * setup problem, and an empty array would be read as "the channel was quiet".
 */
export function fromSnapshot(channelId: string, dir = snapshotDir()): SnapshotRead {
  if (!dir) throw new SnapshotUnavailable('SLACK_SNAPSHOT_DIR is not set');

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    throw new SnapshotUnavailable(
      `SLACK_SNAPSHOT_DIR (${dir}) could not be read: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const matching = entries
    .filter((f) => f.endsWith('.json'))
    .filter((f) => f.includes(channelId))
    .sort();

  if (matching.length === 0) {
    throw new SnapshotUnavailable(
      `No snapshot files for channel ${channelId} in ${dir}. ` +
        `Expected a filename containing the channel id, e.g. ${channelId}-2026-08-15.json. ` +
        `Found: ${entries.slice(0, 6).join(', ') || 'nothing'}`,
    );
  }

  const messages: SlackMessage[] = [];
  const files: string[] = [];
  let newest = 0;

  for (const file of matching) {
    const path = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // One malformed file must not lose the others. If every file is bad the
      // "no messages" throw below is what the caller sees, which is the right
      // failure — silently returning zero would read as "the channel was quiet".
      continue;
    }
    const found = messagesFrom(parsed);
    if (found.length === 0) continue;
    messages.push(...found);
    files.push(file);
    newest = Math.max(newest, statSync(path).mtimeMs);
  }

  if (messages.length === 0) {
    throw new SnapshotUnavailable(
      `Snapshot files for ${channelId} exist but contained no messages. ` +
        'Each file should be either a bare array of messages or a conversations.history response.',
    );
  }

  // Slack returns newest first; snapshots arrive in whatever order the export
  // wrote them. Sorting here means every downstream parser sees one ordering.
  messages.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));

  return { messages, files, newestAt: newest ? new Date(newest).toISOString() : null };
}

/**
 * The live read, with the snapshot behind it.
 *
 * Returns the source alongside the messages so the caller can set `cache`
 * rather than `live` — the one thing that must not be lost in the fallback.
 */
export async function readChannel(
  channelId: string,
  live: () => Promise<SlackMessage[]>,
): Promise<{ messages: SlackMessage[]; source: 'live' | 'cache'; warnings: string[] }> {
  const warnings: string[] = [];

  try {
    return { messages: await live(), source: 'live', warnings };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!isSnapshotConfigured()) throw e;

    try {
      const snap = fromSnapshot(channelId);
      const age = snap.newestAt
        ? `${Math.round((Date.now() - Date.parse(snap.newestAt)) / 3_600_000)}h old`
        : 'age unknown';
      warnings.push(
        `Slack read failed (${why.slice(0, 120)}) — served from a snapshot instead. ` +
          `${snap.messages.length} messages from ${snap.files.length} file(s), newest ${age}. ` +
          'This is a local bridge, not a live feed: it will not reflect anything posted since the export.',
      );
      return { messages: snap.messages, source: 'cache', warnings };
    } catch (snapErr) {
      // Both paths failed. Report both reasons — "Slack is down" and "the
      // snapshot directory is empty" send someone to different places.
      throw new Error(
        `Slack read failed (${why.slice(0, 120)}) and the snapshot fallback also failed ` +
          `(${snapErr instanceof Error ? snapErr.message.slice(0, 160) : String(snapErr)})`,
      );
    }
  }
}

/** True for the Slack errors a snapshot can legitimately stand in for. */
export function isScopeOrAuthFailure(message: string): boolean {
  return /missing_scope|not_in_channel|invalid_auth|account_inactive|token_revoked|not_authed/.test(message);
}
