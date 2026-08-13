/**
 * §30 — Connector build order and readiness.
 *
 * The critical path is #1 → #2 → #3 → #4: store master, catalogue report,
 * orders, GA4 events. Those four make the dashboard real; everything after is
 * depth.
 *
 * This registry backs `/connectors` (§4.9) — the page that makes the rest of the
 * dashboard trustworthy.
 */
import { minutesSince } from '@/lib/format/dates';
import { lastRunFor } from './run-log';
import type { ConnectorStatus } from './types';
import type { BaseConnector } from './base';

import { sheetsStoreMaster } from './sheets-store-master';
import { slackCatalogueReport } from './slack-catalogue-report';
import { bqOrders } from './bq-orders';
import { bqGa4Events } from './bq-ga4-events';
import { bqCatalogueMaster } from './bq-catalogue-master';
import { sentry } from './sentry';
import { jira } from './jira';
import { ga4Api } from './ga4-api';
import { apiLatency } from './api-latency';
import { gcpLogging } from './gcp-logging';
import { slackAlerts } from './slack-alerts';
import { amplitude } from './amplitude';
import { testEanCanary } from './test-ean-canary';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Build order from §30. The order here is the order shown on `/connectors`. */
export const CONNECTORS: BaseConnector<any, any>[] = [
  sheetsStoreMaster,
  slackCatalogueReport,
  bqOrders,
  bqGa4Events,
  bqCatalogueMaster,
  sentry,
  jira,
  ga4Api,
  apiLatency,
  gcpLogging,
  slackAlerts,
  amplitude,
  testEanCanary,
];
/* eslint-enable @typescript-eslint/no-explicit-any */

export function getConnector(id: string) {
  return CONNECTORS.find((c) => c.id === id);
}

export async function connectorStatuses(): Promise<ConnectorStatus[]> {
  return Promise.all(
    CONNECTORS.map(async (c) => {
      const d = c.descriptor();
      const run = await lastRunFor(c.id);
      const freshnessMinutes = run?.finishedAt ? minutesSince(run.finishedAt) : null;
      const withinSla = freshnessMinutes != null && freshnessMinutes <= d.freshnessSlaMinutes;

      // grey = never configured, so it is not a failure — it is a known blocker.
      const health: ConnectorStatus['health'] = !d.configured
        ? 'grey'
        : run?.status === 'fail'
          ? 'red'
          : run?.status === 'warn' || !withinSla
            ? 'amber'
            : run?.status === 'success'
              ? 'green'
              : 'grey';

      return {
        ...d,
        lastRunAt: run?.finishedAt ?? run?.startedAt ?? null,
        lastStatus: (run?.status === 'running' ? 'warn' : (run?.status ?? 'never')) as ConnectorStatus['lastStatus'],
        rowsIngested: run?.rowsIngested ?? null,
        freshnessMinutes,
        withinSla,
        lastError: run?.error ?? null,
        assertions: run?.assertions ?? [],
        health,
      };
    }),
  );
}

/**
 * §4.9 — the lineage view: for each KPI, which connector produced it. Derived
 * from each connector's declared `powers` rather than maintained by hand, so it
 * cannot drift from the code.
 */
export function lineage(): Array<{ metricOrPage: string; connectors: string[] }> {
  const m = new Map<string, string[]>();
  for (const c of CONNECTORS) {
    for (const p of c.descriptor().powers) {
      const list = m.get(p) ?? [];
      list.push(c.id);
      m.set(p, list);
    }
  }
  return [...m.entries()]
    .map(([metricOrPage, connectors]) => ({ metricOrPage, connectors }))
    .sort((a, b) => a.metricOrPage.localeCompare(b.metricOrPage));
}
