/**
 * §18.4 / §18.5 — the Slack bridge.
 *
 * A fallback read path is the easiest place in a pipeline to lose provenance.
 * The bridge works, so the run succeeds, so the run says `live` — and a
 * fortnight-old export is now indistinguishable on screen from a working feed.
 * Most of what follows guards that one property.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromSnapshot, isScopeOrAuthFailure, readChannel, SnapshotUnavailable } from '@/lib/connectors/slack-snapshot';
import { directionOf, mapGapReason } from '@/lib/connectors/slack-catalogue-sync-report';

const CHANNEL = 'C0AV6FU1YUU';
const dirs: string[] = [];

function snapshotDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-snap-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const msg = (ts: string, text: string) => ({ ts, text, username: 'Tatsu Bot' });

describe('reading a snapshot', () => {
  it('accepts a bare array, which is what a workspace export writes', () => {
    const dir = snapshotDir({ [`${CHANNEL}-2026-08-15.json`]: [msg('1000', 'a'), msg('2000', 'b')] });
    expect(fromSnapshot(CHANNEL, dir).messages).toHaveLength(2);
  });

  it('accepts a conversations.history response, which is what a capture writes', () => {
    // Requiring one shape would guarantee somebody hands over the other.
    const dir = snapshotDir({ [`${CHANNEL}-x.json`]: { ok: true, messages: [msg('1000', 'a')] } });
    expect(fromSnapshot(CHANNEL, dir).messages).toHaveLength(1);
  });

  it('reads only the files for the channel asked for', () => {
    const dir = snapshotDir({
      [`${CHANNEL}-1.json`]: [msg('1000', 'mine')],
      'C0B0APYNZTQ-1.json': [msg('2000', 'someone else’s')],
    });
    const r = fromSnapshot(CHANNEL, dir);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].text).toBe('mine');
  });

  it('throws rather than returning nothing when no snapshot matches', () => {
    // An empty array would be read as "the channel was quiet", which is a
    // finding. "No snapshots for this channel" is a setup problem.
    const dir = snapshotDir({ 'C0B0APYNZTQ-1.json': [msg('1', 'x')] });
    expect(() => fromSnapshot(CHANNEL, dir)).toThrow(SnapshotUnavailable);
    expect(() => fromSnapshot(CHANNEL, dir)).toThrow(/No snapshot files for channel/);
  });

  it('survives one malformed file without losing the others', () => {
    const dir = snapshotDir({
      [`${CHANNEL}-good.json`]: [msg('1000', 'kept')],
      [`${CHANNEL}-bad.json`]: '{ this is not json',
    });
    expect(fromSnapshot(CHANNEL, dir).messages).toHaveLength(1);
  });

  it('sorts newest first, so every parser sees one ordering', () => {
    const dir = snapshotDir({
      [`${CHANNEL}-a.json`]: [msg('1000', 'old')],
      [`${CHANNEL}-b.json`]: [msg('3000', 'new')],
    });
    expect(fromSnapshot(CHANNEL, dir).messages.map((m) => m.text)).toEqual(['new', 'old']);
  });
});

describe('the fallback never claims to be live', () => {
  it('reports cache, not live, when the API failed', async () => {
    const dir = snapshotDir({ [`${CHANNEL}-1.json`]: [msg('1000', 'from snapshot')] });
    vi.stubEnv('SLACK_SNAPSHOT_DIR', dir);

    const r = await readChannel(CHANNEL, async () => {
      throw new Error('missing_scope');
    });
    expect(r.source).toBe('cache');
    expect(r.messages).toHaveLength(1);
  });

  it('says which failure it survived and how old the bridge is', async () => {
    const dir = snapshotDir({ [`${CHANNEL}-1.json`]: [msg('1000', 'x')] });
    vi.stubEnv('SLACK_SNAPSHOT_DIR', dir);

    const r = await readChannel(CHANNEL, async () => {
      throw new Error('missing_scope');
    });
    expect(r.warnings[0]).toContain('missing_scope');
    expect(r.warnings[0]).toMatch(/newest \d+h old/);
    expect(r.warnings[0]).toContain('not a live feed');
  });

  it('reports live and no warning when the API answers', async () => {
    const dir = snapshotDir({ [`${CHANNEL}-1.json`]: [msg('1000', 'stale')] });
    vi.stubEnv('SLACK_SNAPSHOT_DIR', dir);

    const r = await readChannel(CHANNEL, async () => [msg('9999', 'fresh')]);
    expect(r.source).toBe('live');
    expect(r.warnings).toEqual([]);
    expect(r.messages[0].text).toBe('fresh');
  });

  it('rethrows the original error when no snapshot is configured', async () => {
    // Silently swallowing a Slack outage because a bridge might exist would
    // hide the outage.
    vi.stubEnv('SLACK_SNAPSHOT_DIR', '');
    await expect(
      readChannel(CHANNEL, async () => {
        throw new Error('missing_scope');
      }),
    ).rejects.toThrow(/missing_scope/);
  });

  it('names both failures when the API and the snapshot are both unusable', async () => {
    // "Slack is down" and "the snapshot directory is empty" send someone to
    // different places.
    const dir = snapshotDir({ 'other-channel.json': [msg('1', 'x')] });
    vi.stubEnv('SLACK_SNAPSHOT_DIR', dir);
    await expect(
      readChannel(CHANNEL, async () => {
        throw new Error('missing_scope');
      }),
    ).rejects.toThrow(/missing_scope[\s\S]*snapshot fallback also failed/);
  });
});

describe('which Slack errors a snapshot may stand in for', () => {
  it('covers the scope and auth failures, and nothing else', () => {
    for (const e of ['missing_scope', 'not_in_channel', 'invalid_auth', 'token_revoked']) {
      expect(isScopeOrAuthFailure(e), e).toBe(true);
    }
    // A bad channel id is a configuration mistake, not something a snapshot
    // should paper over.
    for (const e of ['channel_not_found', 'ratelimited', 'internal_error']) {
      expect(isScopeOrAuthFailure(e), e).toBe(false);
    }
  });
});

describe('mapping bot error strings to §20.3 reasons', () => {
  it('maps the defects that have a reason', () => {
    expect(mapGapReason('EAN already assigned to item code')).toBe('ean_assigned_to_multiple_item_codes');
    expect(mapGapReason('Duplicate GTIN')).toBe('ean_assigned_to_multiple_item_codes');
    expect(mapGapReason('Category Mapping Not Found')).toBe('category_not_mapped');
  });

  it('returns null for an unmapped defect rather than guessing a neighbour', () => {
    // The bot invents error strings faster than anyone maps them. An unmapped
    // defect must still be counted; filing it under the nearest reason would
    // put the count somewhere it does not belong.
    expect(mapGapReason('Some brand new upstream error')).toBeNull();
    expect(mapGapReason('Category invalid')).toBeNull();
  });

  it('reads direction off the taxonomy, not off the reason', () => {
    expect(directionOf('EAN already assigned to item code')).toBe('outbound');
    expect(directionOf('Category Mapping Not Found')).toBe('inbound');
    expect(directionOf('nothing like this')).toBeNull();
  });

  it('prefers the longest matching key', () => {
    // "Duplicate GTIN" and a hypothetical "GTIN" must not both match loosely
    // and let the shorter one win.
    expect(mapGapReason('Outbound failure: Duplicate GTIN found for item')).toBe(
      'ean_assigned_to_multiple_item_codes',
    );
  });
});
