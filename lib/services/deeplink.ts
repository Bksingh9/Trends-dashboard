/**
 * §2.7 / §4.4 / §4.10 — Deep links and QR codes.
 *
 * The open-in-app column is the highest-value small feature in the dashboard for
 * NOC and store-visit work: someone looking at a dark store opens that store's
 * Companion journey in one tap, instead of hunting for the URL and hand-editing
 * a store id.
 */
import QRCode from 'qrcode';
import { config } from '@/lib/config';

export function entryUrl(storeId: string): string {
  return config.prodEntryUrl.replace('{store_id}', encodeURIComponent(storeId));
}

/** Server-rendered SVG so the table needs no client-side QR work. */
export async function qrSvg(url: string, size = 128): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    width: size,
    margin: 1,
    color: { dark: '#0F1319', light: '#E9EBE6' },
    errorCorrectionLevel: 'M',
  });
}

/** §4.10 — the environment registry, with a live reachability check. */
export interface EnvironmentEntry {
  envKey: string;
  displayName: string;
  urlTemplate: string;
  purpose: string;
  isCustomerFacing: boolean;
}

export const ENVIRONMENTS: EnvironmentEntry[] = [
  {
    envKey: 'prod',
    displayName: 'Prod — customer entry',
    urlTemplate: config.prodEntryUrl,
    purpose: 'The real journey, inside AJIO. store_id is the platform store id from dim_store.',
    isCustomerFacing: true,
  },
  {
    envKey: 'prod_api',
    displayName: 'Prod theme / API host',
    urlTemplate: config.prodApiHost,
    purpose: 'API base — cart, catalogue, order endpoints.',
    isCustomerFacing: false,
  },
  {
    envKey: 'prod_console',
    displayName: 'Prod platform console',
    urlTemplate: config.prodConsoleUrl,
    purpose: 'Platform configuration for the Companion application.',
    isCustomerFacing: false,
  },
];

export interface ReachabilityResult {
  envKey: string;
  status: 'ok' | 'unreachable' | 'unknown';
  checkedAt: string;
  detail?: string;
}

/**
 * A simple HEAD check. If the prod entry point is down, `/reference` should be
 * the first place that shows it.
 */
export async function checkReachability(entry: EnvironmentEntry): Promise<ReachabilityResult> {
  const url = entry.urlTemplate.replace('{store_id}', config.defaultTestStoreId);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return {
      envKey: entry.envKey,
      status: res.ok || res.status < 500 ? 'ok' : 'unreachable',
      checkedAt: new Date().toISOString(),
      detail: `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      envKey: entry.envKey,
      status: 'unknown',
      checkedAt: new Date().toISOString(),
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/** §4.10 — the document index. Links only; no content mirroring. */
export const DOCUMENT_INDEX = [
  { group: 'Specs & journeys', label: 'Companion Master QA Spec', url: 'https://docs.google.com/document/d/1X62B3VjozQygRmQo4tJ50IClCDROSMcZcpl5NkXGbl8', what: 'Journey definitions, expected behaviour per step' },
  { group: 'Specs & journeys', label: 'AJIO Trends Companion Phase 2 Feature Spec', url: 'https://drive.google.com/file/d/1iquBV-2_EFBa6hXmxF8oQjVB3FVRQTMe', what: 'Roadmap context' },
  { group: 'Specs & journeys', label: 'UX Audit & Engagement Proposal (Home)', url: 'https://docs.google.com/document/d/1JhLrJru_QucD2RdMIlGjzR_YOI9nCn4OSPIMHJPJsRI', what: 'Nishit Gajjar, Jul 2026' },
  { group: 'Data', label: 'GA4 event sheet', url: 'https://docs.google.com/spreadsheets/d/1vbYPH919bSLRcYPz273X3Tz2QPOprXmhU4Mb8ehJwNY', what: 'Event dictionary — cross-check against code' },
  { group: 'Data', label: 'App URLs + Store Code × Store ID', url: 'https://docs.google.com/spreadsheets/d/11eqPcFZnGm4mAG0SS5DvS_4o8IwcpJSMsXE_HorQreE', what: 'Critical — the store dimension' },
  { group: 'Data', label: 'RPOS APIs (Quip)', url: 'https://gofynd.quip.com/83RgAh9CLjcK/RPOS-APIs', what: 'createInvoice, product details, trigger coupons — needed for latency SLOs' },
  { group: 'Tracking', label: 'Companion App — Tasks List', url: 'https://docs.google.com/spreadsheets/d/1cG0HJ-Ekw_0emZ2o47uqZ66Yq7W-l0ZC2ZONxUcddoQ', what: '45 tasks across 10 workstreams' },
  { group: 'Tracking', label: 'Jira board NI', url: 'https://gofynd.atlassian.net/jira/software/c/projects/NI/boards/11030', what: 'Shared across four products — filter by component' },
  { group: 'Tracking', label: 'Geckoboard (superseded)', url: 'https://share.geckoboard.com/dashboards/WEY6NLKTN7LXIYOF', what: 'The dashboard this replaces' },
  { group: 'Design', label: 'Figma — Companion APP', url: 'https://figma.com/design/wxQuN4vDntjto20cA2l55n/Companion-APP', what: 'Design source' },
  { group: 'QA', label: 'QA test sheet', url: 'https://docs.google.com/spreadsheets/d/11nVtmR1jj75JNT-tywexXjuHPN-t_1KZ', what: 'Test cases' },
  { group: 'QA', label: 'Automation guide', url: 'https://drive.google.com/file/d/18wqsiSCP8XU-LF0A4gYGuc-Y3YTsifvm', what: 'Playwright suite context' },
];

/** §2.1 — repos and identifiers, copyable, so engineers stop asking in Slack. */
export const REPO_INDEX = [
  { label: 'hashira-theme', url: 'https://dev.azure.com/GoFynd/ScanAndGo/_git/hashira-theme', what: 'Companion theme — holds the GTM/GA4 instrumentation' },
  { label: 'hashira', url: 'https://dev.azure.com/GoFynd/ScanAndGo/_git/hashira', what: 'Backend' },
  { label: 'comp-app-android-sdk', url: 'https://dev.azure.com/GoFynd/ScanAndGo/_git/comp-app-android-sdk', what: 'Android SDK' },
  { label: 'comp-app-ios-sdk', url: 'https://dev.azure.com/GoFynd/ScanAndGo/_git/comp-app-ios-sdk', what: 'iOS SDK' },
  { label: 'comp-app-android-poc', url: 'https://dev.azure.com/GoFynd/ScanAndGo/_git/comp-app-android-poc', what: 'Android host replica' },
  { label: 'comp-app-ios-poc', url: 'https://dev.azure.com/GoFynd/ScanAndGo/_git/comp-app-ios-poc', what: 'iOS host replica' },
];

export const IDENTIFIERS = [
  { label: 'Prod application id', value: config.companionProdAffiliateId },
  { label: 'GA4 property', value: config.ga4PropertyId },
  { label: 'GA4 account', value: config.ga4AccountId },
  { label: 'BigQuery project', value: config.gcpProjectId },
  { label: 'Orders mart', value: config.bqOrdersTable },
  { label: 'Catalogue master', value: config.bqItemTable },
  { label: 'GA4 → BQ dataset', value: config.bqGa4Dataset || 'UNKNOWN — §13.1, blocks Phase 3' },
  { label: 'Sentry org', value: config.sentryOrg },
  { label: 'Jira project', value: `${config.jiraProjectKey} (board ${config.jiraBoardId})` },
];
