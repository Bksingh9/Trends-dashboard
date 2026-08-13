/**
 * §12 — Configuration.
 *
 * Thresholds and SLOs deliberately do NOT live here: they live in the database
 * (`/settings`) so ops can tune them without a deploy. This file is identity,
 * endpoints, and credentials only.
 */
import { assertProductionOnly, PROD_AFFILIATE } from './env-guard';

const env = (k: string, fallback = ''): string => process.env[k] ?? fallback;

export const config = {
  // App
  nextAuthUrl: env('NEXTAUTH_URL'),
  databaseUrl: env('DATABASE_URL'),
  tzDisplay: env('TZ_DISPLAY', 'Asia/Kolkata'),

  // Identity (§0, §2.2)
  companionProdAffiliateId: env('COMPANION_PROD_AFFILIATE_ID', PROD_AFFILIATE),
  totalTrendsStores: Number(env('TOTAL_TRENDS_STORES', '1765')),
  defaultTenant: env('DEFAULT_TENANT', 'trends'),

  // App entry points (§2.7) — seeded into dim_environment
  prodEntryUrl: env(
    'COMPANION_PROD_ENTRY_URL',
    'https://www.ajio.com/companion_app?store_id={store_id}',
  ),
  prodApiHost: env('COMPANION_PROD_API_HOST', 'https://trends-companion-app.jiocommerce.io'),
  prodConsoleUrl: `https://platform.jiocommerce.io/company/1/application/${PROD_AFFILIATE}`,
  defaultTestStoreId: env('DEFAULT_TEST_STORE_ID', '617'),

  // BigQuery (§15, §16, §20)
  gcpProjectId: env('GCP_PROJECT_ID', 'sng-prod'),
  gcpSaKeyJson: env('GCP_SA_KEY_JSON'),
  bqOrdersTable: env('BQ_ORDERS_TABLE', 'sng-prod.sng_analytics_dwh.avis_base_view'),
  bqItemTable: env('BQ_ITEM_TABLE', 'sng-prod.orbis_pipe_dwh.item'),
  /** §13.1 — UNKNOWN. Blocks Phase 3. Resolve with the SCHEMATA query in §16.1. */
  bqGa4Project: env('BQ_GA4_PROJECT'),
  /** §13.1 — UNKNOWN. GA4 default naming would be `analytics_524294430`. Do not assume. */
  bqGa4Dataset: env('BQ_GA4_DATASET'),
  bqMaxBytesBilled: env('BQ_MAX_BYTES_BILLED', String(50 * 1024 ** 3)),

  // GA4 (§17)
  ga4PropertyId: env('GA4_PROPERTY_ID', '524294430'),
  ga4AccountId: env('GA4_ACCOUNT_ID', '384216496'),

  // Slack (§18, Appendix B)
  slackBotToken: env('SLACK_BOT_TOKEN'),
  slackCatalogueChannel: env('SLACK_CATALOGUE_CHANNEL', 'C0AV6FU1YUU'),
  slackAlertsChannel: env('SLACK_ALERTS_CHANNEL', 'C0B0APYNZTQ'),
  slackNocChannel: env('SLACK_NOC_CHANNEL', 'C0BFJQDV05N'),
  slackDigestChannel: env('SLACK_DIGEST_CHANNEL'),

  // Sentry (§21)
  sentryOrg: env('SENTRY_ORG', 'fynd-f7'),
  sentryAuthToken: env('SENTRY_AUTH_TOKEN'),
  sentryProjects: env('SENTRY_PROJECTS'),

  // Jira (§22)
  jiraBaseUrl: env('JIRA_BASE_URL', 'https://gofynd.atlassian.net'),
  jiraProjectKey: env('JIRA_PROJECT_KEY', 'NI'),
  jiraBoardId: env('JIRA_BOARD_ID', '11030'),
  jiraEmail: env('JIRA_EMAIL'),
  jiraApiToken: env('JIRA_API_TOKEN'),
  /** §13/A11 — the NI board is shared across four products. Unset means unfiltered. */
  jiraComponentFilter: env('JIRA_COMPONENT_FILTER'),

  // Sheets (§19)
  sheetStoreMasterId: env('SHEET_STORE_MASTER_ID', '11eqPcFZnGm4mAG0SS5DvS_4o8IwcpJSMsXE_HorQreE'),
  sheetGa4EventsId: env('SHEET_GA4_EVENTS_ID', '1vbYPH919bSLRcYPz273X3Tz2QPOprXmhU4Mb8ehJwNY'),
  sheetTasksId: env('SHEET_TASKS_ID', '1cG0HJ-Ekw_0emZ2o47uqZ66Yq7W-l0ZC2ZONxUcddoQ'),

  // AI (§28)
  anthropicApiKey: env('ANTHROPIC_API_KEY'),
  aiModel: env('AI_MODEL', 'claude-sonnet-4-6'),
  aiBriefCron: env('AI_BRIEF_CRON', '0 8 * * *'),

  // Modules (§0)
  moduleLoyalty: env('MODULE_LOYALTY', 'false') === 'true',
  moduleAmplitude: env('MODULE_AMPLITUDE', 'false') === 'true',
  moduleTrueCoverage: env('MODULE_TRUE_COVERAGE', 'false') === 'true',
} as const;

/** Boot-time guard (§0). Called from instrumentation.ts so it runs once per process. */
export function validateConfig(): void {
  assertProductionOnly({
    COMPANION_PROD_AFFILIATE_ID: config.companionProdAffiliateId,
    COMPANION_PROD_ENTRY_URL: config.prodEntryUrl,
    COMPANION_PROD_API_HOST: config.prodApiHost,
    GCP_PROJECT_ID: config.gcpProjectId,
    BQ_ORDERS_TABLE: config.bqOrdersTable,
    BQ_ITEM_TABLE: config.bqItemTable,
    BQ_GA4_PROJECT: config.bqGa4Project,
    BQ_GA4_DATASET: config.bqGa4Dataset,
    GA4_PROPERTY_ID: config.ga4PropertyId,
    JIRA_BASE_URL: config.jiraBaseUrl,
    SENTRY_ORG: config.sentryOrg,
  });
}

export const isDbConfigured = (): boolean => config.databaseUrl.length > 0;
