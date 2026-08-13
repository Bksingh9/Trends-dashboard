/**
 * §24 — Connector 12: `amplitude`. P3, optional, off by default.
 *
 * Org `relianceretail`, app `668622`. Behind `MODULE_AMPLITUDE=false`.
 *
 * Build this only if it answers something GA4 cannot. Determine which events
 * exist in Amplitude but not GA4 *before* writing a line of code — if the answer
 * is "none", close the ticket. Two overlapping analytics sources with slightly
 * different numbers is a liability, not a feature.
 */
import { config } from '@/lib/config';
import { rowVolume } from '@/lib/assertions';
import type { DateWindow } from '@/lib/format/dates';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

export interface AmplitudeRow {
  dateKey: string;
  eventName: string;
  count: number;
}

export class AmplitudeConnector extends BaseConnector<AmplitudeRow, AmplitudeRow> {
  readonly id = 'amplitude';
  readonly displayName = 'Amplitude (optional)';
  readonly freshnessSlaMinutes = 24 * 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P3' as const;
  readonly powers = ['retention / cohort curves, if they beat GA4'];
  readonly blockedBy = '§24 — justify first: which events exist here but not in GA4?';

  isConfigured(): boolean {
    return config.moduleAmplitude && Boolean(process.env.AMPLITUDE_API_KEY);
  }

  protected async extract(): Promise<AmplitudeRow[]> {
    throw new Error('amplitude connector is disabled — MODULE_AMPLITUDE=false (§24)');
  }

  protected transform(rows: AmplitudeRow[]): AmplitudeRow[] {
    return rows;
  }

  protected async load(rows: AmplitudeRow[]): Promise<LoadResult> {
    return { rowsIngested: rows.length, table: '(none)' };
  }

  protected fixture(_w: DateWindow): AmplitudeRow[] {
    return [];
  }

  readonly assertions: Assertion<AmplitudeRow>[] = [
    rowVolume<AmplitudeRow>({ tolerance: 0.9, zeroIsFail: false }),
  ];
}

export const amplitude = new AmplitudeConnector();
