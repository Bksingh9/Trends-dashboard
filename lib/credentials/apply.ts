/**
 * Making stored sources actually take effect.
 *
 * Without this the sources page is a form that stores credentials nothing
 * reads — which would be worse than not having it, because someone would paste
 * a token, see it saved, and reasonably conclude the connector was configured.
 *
 * The mechanism is deliberately boring: on each ETL entry point, load enabled
 * sources and project them onto `process.env` **before** any connector runs.
 * Everything downstream — `config`, `isConfigured()`, the doctor, every
 * connector — keeps reading the environment exactly as it always has, and none
 * of it needs to know this feature exists.
 *
 * The alternative, threading a credential object through every connector,
 * would touch sixteen classes to change where a string comes from. This touches
 * one place and leaves the seam visible: `sourceOrigins()` reports what came
 * from where, so "which credential is in force" is answerable.
 */
import { listSources, resolveSource } from './store';
import { getSourceType, SOURCE_TYPES } from './source-types';

/**
 * Which env var each stored field maps onto.
 *
 * Explicit rather than derived from `supersedes`, because the mapping is not
 * positional — a Slack source has one token and four channel ids, and getting
 * them in the wrong order would point the alerting at the catalogue channel.
 */
const FIELD_TO_ENV: Record<string, Record<string, string>> = {
  bigquery: {
    serviceAccountJson: 'GCP_SA_KEY_JSON',
    projectId: 'GCP_PROJECT_ID',
    ga4Dataset: 'BQ_GA4_DATASET',
    maxBytesBilled: 'BQ_MAX_BYTES_BILLED',
  },
  postgres: { url: 'DATABASE_URL', readonlyUrl: 'DATABASE_URL_READONLY' },
  'google-sheets': {
    serviceAccountJson: 'GCP_SA_KEY_JSON',
    storeMasterId: 'SHEET_STORE_MASTER_ID',
    eventsSheetId: 'SHEET_GA4_EVENTS_ID',
    tasksSheetId: 'SHEET_TASKS_ID',
  },
  slack: {
    botToken: 'SLACK_BOT_TOKEN',
    catalogueChannel: 'SLACK_CATALOGUE_CHANNEL',
    alertsChannel: 'SLACK_ALERTS_CHANNEL',
    nocChannel: 'SLACK_NOC_CHANNEL',
    digestChannel: 'SLACK_DIGEST_CHANNEL',
  },
  sentry: { authToken: 'SENTRY_AUTH_TOKEN', org: 'SENTRY_ORG', projects: 'SENTRY_PROJECTS' },
  jira: {
    baseUrl: 'JIRA_BASE_URL',
    email: 'JIRA_EMAIL',
    apiToken: 'JIRA_API_TOKEN',
    projectKey: 'JIRA_PROJECT_KEY',
    componentFilter: 'JIRA_COMPONENT_FILTER',
  },
  ga4: { serviceAccountJson: 'GCP_SA_KEY_JSON', propertyId: 'GA4_PROPERTY_ID' },
  anthropic: { apiKey: 'ANTHROPIC_API_KEY', model: 'AI_MODEL' },
};

export interface AppliedSource {
  type: string;
  name: string;
  /** Env vars this source set, and whether it displaced an existing value. */
  applied: Array<{ envVar: string; overrode: boolean }>;
}

/**
 * Projects enabled sources onto the environment. Idempotent; safe to call more
 * than once per process.
 *
 * A source with no database, no `CREDENTIAL_KEY`, or a decryption failure is
 * skipped silently *here* and reported loudly on the sources page. An ETL run
 * must not die because one of eight credentials cannot be read — the other
 * seven still have work to do.
 */
export async function applyStoredSources(): Promise<AppliedSource[]> {
  const out: AppliedSource[] = [];
  let sources: Awaited<ReturnType<typeof listSources>>;
  try {
    sources = await listSources();
  } catch {
    return out;
  }

  for (const s of sources.filter((x) => x.enabled)) {
    const map = FIELD_TO_ENV[s.type];
    if (!map) continue;

    let resolved: Awaited<ReturnType<typeof resolveSource>> = null;
    try {
      resolved = await resolveSource(s.type, s.name);
    } catch {
      continue; // reported on the page; never fatal to a run
    }
    if (!resolved) continue;

    const applied: AppliedSource['applied'] = [];
    const values = { ...resolved.config, ...resolved.secrets };
    for (const [field, envVar] of Object.entries(map)) {
      const v = (values[field] ?? '').trim();
      if (!v) continue;
      applied.push({ envVar, overrode: Boolean(process.env[envVar]) });
      process.env[envVar] = v;
    }
    out.push({ type: s.type, name: s.name, applied });
  }
  return out;
}

/**
 * Where each credential is currently coming from, for the UI and the doctor.
 *
 * Two credentials for the same thing is a situation someone must be able to
 * see rather than discover during an incident.
 */
export async function sourceOrigins(): Promise<
  Array<{ envVar: string; from: 'ui' | 'env' | 'unset'; sourceName?: string }>
> {
  const stored = await listSources().catch(() => []);
  const byEnv = new Map<string, string>();
  for (const s of stored.filter((x) => x.enabled)) {
    const map = FIELD_TO_ENV[s.type] ?? {};
    for (const [field, envVar] of Object.entries(map)) {
      if (s.config[field] || s.secretPreview[field]) byEnv.set(envVar, s.name);
    }
  }

  const all = new Set<string>();
  for (const t of SOURCE_TYPES) for (const v of t.supersedes) all.add(v);

  return [...all].sort().map((envVar) => {
    const sourceName = byEnv.get(envVar);
    if (sourceName) return { envVar, from: 'ui' as const, sourceName };
    return { envVar, from: process.env[envVar] ? ('env' as const) : ('unset' as const) };
  });
}

/** Sanity check used by tests: every declared `supersedes` var is mapped. */
export function unmappedSupersedes(): Array<{ type: string; envVar: string }> {
  const gaps: Array<{ type: string; envVar: string }> = [];
  for (const t of SOURCE_TYPES) {
    const mapped = new Set(Object.values(FIELD_TO_ENV[t.id] ?? {}));
    for (const v of t.supersedes) {
      if (!mapped.has(v)) gaps.push({ type: t.id, envVar: v });
    }
  }
  return gaps;
}

export { FIELD_TO_ENV, getSourceType };
