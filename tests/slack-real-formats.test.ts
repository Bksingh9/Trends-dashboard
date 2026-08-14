/**
 * Parsers tested against messages the source actually sent.
 *
 * Every assertion here is a number read off a real Slack message, not one this
 * codebase invented. That distinction is the whole point: both parsers under
 * test were originally written against a *guess* at the format, and both were
 * completely wrong — `slack-catalogue-report` looked for four fields the report
 * has never contained, and `slack-alerts` treated structured Sentry alerts as
 * opaque prose.
 *
 * A parser tested only against text its own author invented tests nothing but
 * that author's imagination.
 */
import { describe, expect, it } from 'vitest';
import { SLACK_ALERT_SAMPLES, SENTRY_FACTS } from '@/fixtures/slack-samples';
import {
  CATALOGUE_REPORT_SAMPLES,
  CATALOGUE_SYNC_ERRORS,
  CATALOGUE_REPORT_CADENCE,
} from '@/fixtures/catalogue-report-samples';
import {
  classifyMessage,
  issueKeyFor,
  parseHealthDigest,
  parseSentryAlert,
  severityOf,
  stripSlackFormatting,
  titleFor,
} from '@/lib/connectors/slack-parse';
import {
  parseCatalogueSyncReport,
  reconcileReport,
  topDefect,
} from '@/lib/connectors/catalogue-report-parse';

/* ── #companion-app-alerts ───────────────────────────────────────────────── */

describe('§18.8 — Sentry alerts from the real channel', () => {
  it('classifies every captured message correctly', () => {
    for (const s of SLACK_ALERT_SAMPLES) {
      expect(classifyMessage(s), `${s.username}: ${s.text.slice(0, 40)}`).toBe(s.kind);
    }
  });

  it('parses every Sentry alert — a partial parse rate is a silent data loss', () => {
    const sentry = SLACK_ALERT_SAMPLES.filter((s) => s.kind === 'sentry');
    expect(sentry.length).toBeGreaterThanOrEqual(5);
    for (const s of sentry) {
      const a = parseSentryAlert(s.text);
      expect(a, `failed to parse ${s.ts}`).not.toBeNull();
      expect(a!.errorType).toBeTruthy();
      expect(a!.message).toBeTruthy();
      expect(a!.shortId).toBeTruthy();
      expect(a!.project).toBeTruthy();
      expect(a!.eventCount).toBeGreaterThan(0);
    }
  });

  it('extracts the exact fields off the PromoIntegrationError alert', () => {
    const a = parseSentryAlert(SLACK_ALERT_SAMPLES[0].text)!;
    expect(a.errorType).toBe('PromoIntegrationError');
    expect(a.endpoint).toBe('POST /apply-promotions');
    expect(a.message).toBe('Failed to fetch details for all 1 product(s)');
    expect(a.eventCount).toBe(36);
    expect(a.usersAffected).toBe(11);
    expect(a.state).toBe('Regressed');
    expect(a.firstSeen).toBe('2026-07-05');
    expect(a.shortId).toBe('HASHIRA-1J');
    expect(a.project).toBe('hashira');
    expect(a.environment).toBe('sng');
  });

  it('leaves usersAffected null when the alert omits it, rather than zero', () => {
    // Three of five real alerts omit the line. Reading absence as "nobody
    // affected" would rank a 746-event outage below a quiet one that happened
    // to report a count.
    const a = parseSentryAlert(SLACK_ALERT_SAMPLES[2].text)!;
    expect(a.eventCount).toBe(746);
    expect(a.usersAffected).toBeNull();
    expect(a.state).toBeNull();
  });

  it('reads the project label, not the numeric project id', () => {
    // The href carries `project=4510674776686592`, which means nothing to a
    // reader. The label is the service name people say out loud.
    const a = parseSentryAlert(SLACK_ALERT_SAMPLES[3].text)!;
    expect(a.project).toBe('gringotts');
    expect(a.environment).toBe('production');
    expect(a.shortId).toBe('GRINGOTTS-1JZB');
  });

  it('ranks severity by impact, not by vocabulary', () => {
    // The old rule grepped for "P0|critical|down|outage". None of those words
    // appears in any real alert, so every incident landed as P2 — including
    // this 1,251-event failure affecting 154 people.
    const worst = parseSentryAlert(SLACK_ALERT_SAMPLES[4].text)!;
    expect(worst.eventCount).toBe(1251);
    expect(worst.usersAffected).toBe(154);
    expect(severityOf(worst)).toBe('P0');

    const quiet = parseSentryAlert(SLACK_ALERT_SAMPLES[0].text)!;
    expect(severityOf(quiet)).toBe('P1');

    for (const s of SLACK_ALERT_SAMPLES.filter((x) => x.kind === 'sentry')) {
      expect(/p0|critical|outage/i.test(s.text), 'a real alert used priority vocabulary').toBe(false);
    }
  });

  it('keys an issue on Sentry short id, so a regression is one row not three', () => {
    const a = parseSentryAlert(SLACK_ALERT_SAMPLES[0].text)!;
    expect(issueKeyFor(a)).toBe('SENTRY-HASHIRA-1J');
    // Stable across re-alerts of the same incident.
    expect(issueKeyFor(parseSentryAlert(SLACK_ALERT_SAMPLES[0].text)!)).toBe(issueKeyFor(a));
  });

  it('writes a title a human can act on, with no Slack markup left in it', () => {
    const t = titleFor(parseSentryAlert(SLACK_ALERT_SAMPLES[0].text)!);
    expect(t).toBe(
      'PromoIntegrationError on POST /apply-promotions [hashira] — Failed to fetch details for all 1 product(s)',
    );
    expect(t).not.toMatch(/[<>*`]|:[a-z_]+:/);
  });

  it('never turns the nightly digest into an issue', () => {
    // Otherwise the board grows one bogus issue a night whose title is a table.
    for (const s of SLACK_ALERT_SAMPLES.filter((x) => x.kind === 'digest')) {
      expect(classifyMessage(s)).toBe('digest');
      const d = parseHealthDigest(s.text)!;
      expect(d).not.toBeNull();
      expect(d.services.map((x) => x.service)).toEqual(SENTRY_FACTS.projects);
    }
  });

  it('reads the per-service counts out of the digest table', () => {
    const d = parseHealthDigest(SLACK_ALERT_SAMPLES[5].text)!;
    expect(d.label).toBe('EOD 14 Aug');
    expect(d.services.find((s) => s.service === 'hashira')!.issues).toBe(5);
    expect(d.services.find((s) => s.service === 'computron')!.issues).toBe(0);
    // "1 issue" singular must parse the same as "5 issues".
    expect(d.services.find((s) => s.service === 'avis')!.issues).toBe(1);
    expect(d.totalIssues).toBe(10);
  });

  it('produces nothing at all from a human talking in the channel', () => {
    const human = SLACK_ALERT_SAMPLES.find((s) => s.kind === 'other')!;
    expect(classifyMessage(human)).toBe('other');
    expect(parseSentryAlert(human.text)).toBeNull();
    expect(parseHealthDigest(human.text)).toBeNull();
  });

  it('strips Slack markup down to something readable', () => {
    expect(stripSlackFormatting('<https://x.test|*Boom*>')).toBe('Boom');
    expect(stripSlackFormatting(':red_circle: *Error*')).toBe('Error');
  });
});

/* ── #sng-catalogue-lack ─────────────────────────────────────────────────── */

describe('§18.6 — the Daily Catalog Sync Report, as actually posted', () => {
  it('parses every captured report', () => {
    for (const s of CATALOGUE_REPORT_SAMPLES) {
      expect(parseCatalogueSyncReport(s.text), `failed on ${s.ts}`).not.toBeNull();
    }
  });

  it('reads the AJIO pipeline figures exactly', () => {
    const r = parseCatalogueSyncReport(CATALOGUE_REPORT_SAMPLES[0].text)!;
    expect(r.reportDate).toBe('2026-08-14');
    const ajio = r.pipelines.find((p) => p.pipeline === 'AJIO')!;
    expect(ajio.synced).toBe(1982);
    expect(ajio.inboundFailed).toBe(147);
    expect(ajio.outboundFailed).toBe(2935);
  });

  it("agrees with the report's own arithmetic", () => {
    // §6.3 — the error tables must sum to the stated failure counts. A short
    // breakdown makes the top defect look smaller than it is, and the report is
    // the source of truth for its own totals.
    for (const s of CATALOGUE_REPORT_SAMPLES) {
      const r = parseCatalogueSyncReport(s.text)!;
      for (const check of reconcileReport(r)) {
        expect(
          check.agrees,
          `${s.ts} ${check.pipeline}/${check.direction}: stated ${check.stated}, parsed ${check.summed}`,
        ).toBe(true);
      }
    }
  });

  it('never counts the TOTAL row as an error type', () => {
    // Including it would inflate every breakdown by exactly 100%.
    const r = parseCatalogueSyncReport(CATALOGUE_REPORT_SAMPLES[0].text)!;
    const ajio = r.pipelines.find((p) => p.pipeline === 'AJIO')!;
    for (const e of [...ajio.inboundErrors, ...ajio.outboundErrors]) {
      expect(e.errorType.toLowerCase()).not.toBe('total');
    }
    expect(ajio.outboundErrors).toHaveLength(6);
  });

  it('attributes each failure table to the pipeline above it', () => {
    // Parsing the code fences globally would give SAP's empty tables to AJIO
    // and silently zero out the real failure counts.
    const r = parseCatalogueSyncReport(CATALOGUE_REPORT_SAMPLES[0].text)!;
    const sap = r.pipelines.find((p) => p.pipeline === 'SAP')!;
    expect(sap.synced).toBe(0);
    expect(sap.inboundErrors).toEqual([]);
    expect(sap.outboundErrors).toEqual([]);
  });

  it('confirms §13.9 from the source: the SAP pipeline is genuinely idle', () => {
    // Recorded as an open assumption. The report states it, every hour.
    for (const s of CATALOGUE_REPORT_SAMPLES) {
      const sap = parseCatalogueSyncReport(s.text)!.pipelines.find((p) => p.pipeline === 'SAP')!;
      expect(sap.synced + sap.inboundFailed + sap.outboundFailed).toBe(0);
    }
  });

  it('finds the dominant catalogue defect', () => {
    // The same failure `bq-catalogue-master` detects structurally by counting
    // item codes per EAN. Two independent sources naming the same top defect is
    // the strongest evidence in the build.
    for (const s of CATALOGUE_REPORT_SAMPLES) {
      const top = topDefect(parseCatalogueSyncReport(s.text)!)!;
      expect(top.errorType).toBe('EAN already assigned to item code');
      expect(top.direction).toBe('outbound');
    }
    const worst = topDefect(parseCatalogueSyncReport(CATALOGUE_REPORT_SAMPLES[0].text)!)!;
    expect(worst.count).toBe(2742);
  });

  it('parses the stage-wise reconcile block', () => {
    const r = parseCatalogueSyncReport(CATALOGUE_REPORT_SAMPLES[0].text)!;
    expect(r.reconcile).toEqual([
      { stage: 'resolve', total: 2806, success: 0, failed: 0 },
      { stage: 'resync', total: 73, success: 0, failed: 26 },
    ]);
    expect(r.reconcileFailed).toBe(26);
  });

  it('records that the report is hourly, not daily', () => {
    // §18.6 said "expected daily by 09:00 IST" and the connector declared a
    // 36-hour SLA. A genuine two-hour outage would have gone unremarked for a
    // day and a half.
    expect(CATALOGUE_REPORT_CADENCE.everyMinutes).toBe(60);
    const r = parseCatalogueSyncReport(CATALOGUE_REPORT_SAMPLES[0].text)!;
    expect(r.windowStart).toBe('2026-08-14 17:00:08');
    expect(r.windowEnd).toBe('2026-08-14 18:00:09');
  });

  it('covers every error type seen in the wild with a documented direction', () => {
    for (const s of CATALOGUE_REPORT_SAMPLES) {
      const r = parseCatalogueSyncReport(s.text)!;
      for (const p of r.pipelines) {
        for (const [dir, errs] of [
          ['inbound', p.inboundErrors],
          ['outbound', p.outboundErrors],
        ] as const) {
          for (const e of errs) {
            const known = CATALOGUE_SYNC_ERRORS[e.errorType];
            expect(known, `undocumented error type "${e.errorType}"`).toBeDefined();
            // The source files each error under a heading; the taxonomy must
            // agree with the source rather than with §20.3's inference.
            expect(known.direction, `${e.errorType} direction`).toBe(dir);
          }
        }
      }
    }
  });
});
