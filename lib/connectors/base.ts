/**
 * §14.1 — The base connector contract.
 *
 * Every connector is a class implementing the same lifecycle. Nothing bypasses
 * this: `/connectors`, the fixture fallback, the assertion gate, and the run log
 * all depend on it.
 *
 * The lifecycle never throws to the UI. A broken connector degrades to the last
 * good snapshot or to fixtures, and says which.
 */
import { runAssertions, worstLevel } from '@/lib/assertions';
import type { DateWindow } from '@/lib/format/dates';
import { classifyError, DEFAULT_RETRY, withRetry, type RetryPolicy } from './retry';
import { finishRun, startRun, trailingRowCounts } from './run-log';
import type {
  Assertion,
  AssertionVerdict,
  ConnectorDescriptor,
  ConnectorResult,
  CostTier,
  LoadResult,
} from './types';

export abstract class BaseConnector<TRow, TNormalised = TRow> {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly freshnessSlaMinutes: number;
  abstract readonly costTier: CostTier;
  abstract readonly priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** What this connector powers, for the `/connectors` lineage view (§4.9). */
  abstract readonly powers: string[];
  abstract readonly assertions: Assertion<TNormalised>[];

  /** The §13 blocker to name in the UI when `isConfigured()` is false. */
  readonly blockedBy?: string;

  protected retryPolicy: RetryPolicy = DEFAULT_RETRY;

  /** Pure extraction. No writes, no side effects. */
  protected abstract extract(w: DateWindow): Promise<TRow[]>;

  /** Row-level normalisation: types, keys, timezone, currency. */
  protected abstract transform(rows: TRow[]): TNormalised[];

  /** Idempotent upsert into the mart. Must be safe to re-run (§27.5). */
  protected abstract load(rows: TNormalised[]): Promise<LoadResult>;

  /** Realistic fixture rows (§14.5), derived from the §1 baselines. */
  protected abstract fixture(w: DateWindow): TNormalised[];

  /** Credentials present and usable. */
  abstract isConfigured(): boolean;

  descriptor(): ConnectorDescriptor {
    return {
      id: this.id,
      displayName: this.displayName,
      priority: this.priority,
      freshnessSlaMinutes: this.freshnessSlaMinutes,
      costTier: this.costTier,
      powers: this.powers,
      blockedBy: this.blockedBy,
      configured: this.isConfigured(),
    };
  }

  async run(w: DateWindow): Promise<ConnectorResult<TNormalised>> {
    const runId = await startRun(this.id, w);
    const warnings: string[] = [];

    if (!this.isConfigured()) {
      return this.fixtureFallback(runId, w, this.blockedBy ?? 'not configured');
    }

    try {
      const raw = await withRetry(() => this.extract(w), this.retryPolicy, (attempt, _e, waitMs) => {
        warnings.push(`retry ${attempt} after ${waitMs}ms`);
      });
      const rows = this.transform(raw);

      const verdicts = await runAssertions(this.assertions, rows, {
        connector: this.id,
        window: w,
        trailingRowCounts: await trailingRowCounts(this.id),
      });

      if (worstLevel(verdicts) === 'fail') {
        // Mart untouched. Keep serving the last good snapshot (§6.3).
        await finishRun(runId, {
          status: 'fail',
          assertions: verdicts,
          error: failureSummary(verdicts),
        });
        await this.alertConnectorDown(verdicts);
        return {
          ok: false,
          rows: [],
          meta: this.meta(w, 0, 'cache', [
            ...warnings,
            'Hard assertion failed — mart not updated, serving last good snapshot',
          ]),
          error: { code: 'assertion_failed', message: failureSummary(verdicts), retryable: false },
          assertions: verdicts,
        };
      }

      const loaded = await this.load(rows);
      await finishRun(runId, {
        status: worstLevel(verdicts) === 'warn' ? 'warn' : 'success',
        rowsIngested: loaded.rowsIngested,
        assertions: verdicts,
      });

      return {
        ok: true,
        rows,
        // `readSource` lets a connector that fell back to a local bridge report
        // `cache` instead of `live`. A successful extract is not the same claim
        // as a live one, and a snapshot reported as live is exactly the failure
        // §14.5 exists to prevent — worse here than a fixture, because it looks
        // like a working feed.
        meta: this.meta(w, loaded.rowsIngested, this.readSource(), [
          ...warnings,
          ...this.readWarnings(),
          ...verdicts.filter((v) => v.level === 'warn').map((v) => v.message),
        ]),
        assertions: verdicts,
      };
    } catch (e) {
      const err = classifyError(e);
      await finishRun(runId, { status: 'fail', error: err.message });
      // Never throw to the UI.
      return {
        ok: false,
        rows: [],
        meta: this.meta(w, 0, 'cache', [...warnings, `Connector error: ${err.message}`]),
        error: err,
      };
    }
  }

  /**
   * Runs the real lifecycle over fixture rows: transform → assertions → load.
   *
   * This exists because `fixtureFallback` deliberately does *not* load, which
   * means that until the first credential arrives, every connector's `load()`
   * has never executed even once. The first production run would then also be
   * the first test of the idempotent upsert (§27.5) — on real data, against a
   * real mart, with nothing to compare against. Seeding moves that discovery to
   * a local database where getting it wrong costs nothing.
   *
   * Two guards make it safe:
   *
   *  - **It refuses to run in production.** Fixture rows in a production mart
   *    would be indistinguishable from real ones at the row level; there is no
   *    honest way to un-mix them afterwards.
   *  - **The run is flagged `seeded`.** The serving layer reads that flag and
   *    reports the mart as `fixture` no matter how many rows it holds, so a
   *    seeded page never renders as live (§14.5).
   */
  async seed(w: DateWindow): Promise<ConnectorResult<TNormalised>> {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_FIXTURE_SEED !== 'i-understand') {
      throw new Error(
        `Refusing to seed ${this.id} in production: fixture rows in a production mart cannot be told apart from real ones afterwards.`,
      );
    }

    const runId = await startRun(this.id, w);
    // `fixture()` returns rows already in normalised shape — that is its
    // contract, since `fixtureFallback` hands them straight to the UI. Running
    // `transform` over them again would be transforming twice.
    const rows = this.fixture(w);

    // The gate runs on seeded rows too. Skipping it here would mean the
    // assertions are never exercised until a real load, which is the same
    // deferred-discovery problem this method exists to solve — and a fixture
    // that cannot pass its own connector's assertions is a broken fixture.
    const verdicts = await runAssertions(this.assertions, rows, {
      connector: this.id,
      window: w,
      trailingRowCounts: await trailingRowCounts(this.id),
    });

    if (worstLevel(verdicts) === 'fail') {
      await finishRun(runId, {
        status: 'fail',
        assertions: verdicts,
        seeded: true,
        error: `Fixture failed its own connector's assertions: ${failureSummary(verdicts)}`,
      });
      return {
        ok: false,
        rows: [],
        meta: this.meta(w, 0, 'fixture', ['Seed blocked — the fixture does not satisfy this connector’s assertions']),
        error: { code: 'assertion_failed', message: failureSummary(verdicts), retryable: false },
        assertions: verdicts,
      };
    }

    const loaded = await this.load(rows);
    await finishRun(runId, {
      status: worstLevel(verdicts) === 'warn' ? 'warn' : 'success',
      rowsIngested: loaded.rowsIngested,
      assertions: verdicts,
      seeded: true,
    });

    return {
      ok: true,
      rows,
      meta: this.meta(w, loaded.rowsIngested, 'fixture', [
        `Seeded ${loaded.rowsIngested} fixture rows into ${loaded.table} — this mart is not live data`,
      ]),
      assertions: verdicts,
    };
  }

  protected async fixtureFallback(
    runId: number,
    w: DateWindow,
    reason: string,
  ): Promise<ConnectorResult<TNormalised>> {
    const rows = this.fixture(w);
    await finishRun(runId, {
      status: 'warn',
      rowsIngested: rows.length,
      error: `Not configured (${reason}) — served fixtures`,
    });
    return {
      ok: true,
      rows,
      meta: this.meta(w, rows.length, 'fixture', [`Fixture data — ${reason}`]),
    };
  }

  /**
   * What the last `extract()` actually read from. Overridden by connectors with
   * a fallback path; `live` for everything else.
   */
  protected readSource(): 'live' | 'cache' {
    return 'live';
  }

  /** Warnings the read path wants on the run, e.g. which snapshot was used. */
  protected readWarnings(): string[] {
    return [];
  }

  protected meta(
    w: DateWindow,
    rowCount: number,
    source: 'live' | 'cache' | 'fixture',
    warnings: string[] = [],
  ) {
    return {
      connector: this.id,
      fetchedAt: new Date().toISOString(),
      windowStart: w.start,
      windowEnd: w.end,
      rowCount,
      source,
      warnings,
    };
  }

  /** §8.5 — connector hard-failures post to Slack immediately. */
  protected async alertConnectorDown(verdicts: AssertionVerdict[]): Promise<void> {
    const { alertConnectorDown } = await import('@/lib/alerts');
    await alertConnectorDown(this.id, this.displayName, verdicts);
  }
}

function failureSummary(verdicts: AssertionVerdict[]): string {
  return verdicts
    .filter((v) => v.level === 'fail')
    .map((v) => `${v.id}: ${v.message}`)
    .join('; ');
}
