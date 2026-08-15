# ADR-004 — A source type and its connection test are one declaration

**Date:** 2026-08-15
**Status:** Accepted
**Supersedes:** nothing. **Fixes:** a defect introduced in `b8d842e`.

## The defect

`b8d842e` shipped a data-source manager with thirteen types in the picker and
**eight** connection tests. `mysql`, `snowflake`, `rest-api`, `csv-url` and
`gcs` could be chosen, filled in and saved, and did nothing. The failure path:

```ts
return {
  ok: false,
  summary: `No connection test is implemented for ${type.label} yet — it will be saved untested.`,
  steps: [],
};
```

That message is honest and still wrong, because the surrounding UI treats
"saved" as "configured". Someone holding a Snowflake password would have pasted
it, seen it stored with a masked preview on the sources page, and reasonably
concluded the warehouse was connected.

This is the same shape as the two failures this whole project was commissioned
over — `avis_base_view` reporting itself healthy while stale, and `fact_scan_daily`
existing with no writer. Config that looks complete and moves no data.

## Decision

Three changes, in increasing order of how much they actually prevent.

### 1. Implement the missing five (weakest — fixes today only)

- `mysql` — `mysql2`, `SELECT 1` plus a table count.
- `sqlserver` — `mssql`, added because Power BI's centre of gravity is SQL Server
  and its absence made the catalogue read as Google-only.
- `snowflake` — **no driver**. `snowflake-sdk` is a large dependency for one
  `SELECT 1`, and Snowflake's SQL API v2 does not accept a username and
  password at all; it wants a key-pair JWT or OAuth. The original form had a
  password field nobody could have made work. It now takes a PKCS#8 PEM and
  signs the JWT with `node:crypto`, the same way `lib/gcp/auth.ts` already does.
- `rest-api` — fetches, parses, and then checks the rows are **where the path
  says they are**. A 200 with the array somewhere else is the silent failure
  worth catching.
- `csv-url` — `Range: bytes=0-16383` first, so reading a header off a 500 MB
  export is not a 500 MB download. Reports ragged rows in the sample, because a
  ragged CSV becomes a wrong number three screens later.
- `gcs` — token exchange scoped to `devstorage.read_only`, then a list under the
  prefix. An empty result is reported as a failure naming the prefix, since
  "authenticated and empty" is nearly always a prefix typo.

### 2. Assert coverage in `credentials.test.ts` (stronger — fixes recurrence)

```ts
const missing = SOURCE_TYPES.filter((t) => !TESTS[t.id]).map((t) => t.id);
expect(missing).toEqual([]);
```

Plus the reverse, so a test for a type that no longer exists is also caught.
This is the same pattern as the orphan-mart test, which was proven by deleting
`bq-ga4-scans` from the registry and watching it fail.

### 3. Derive both from one declaration (strongest — fixes expressibility)

For the eighteen SaaS families added here, `lib/credentials/saas.ts` declares
the type **and** its probe as one object, and exports `SAAS_TYPES` and
`SAAS_TESTS` from the same array. There is no way to add a type and forget the
test, because they are not two things.

A test catches a mistake after it is made; this makes the mistake
inexpressible. The hand-written tests remain hand-written where the probe is
genuinely more than one HTTP call (BigQuery's three hops, Postgres's read-only
verification, Slack's per-channel check), and those stay covered by (2).

## Why these eighteen, and why `genericOnly`

The catalogue now matches what a Geckoboard or Looker Studio user expects to
find: Stripe, HubSpot, Salesforce, Shopify, Zendesk, Intercom, Mixpanel, Meta
Ads, Google Ads, Airtable, Notion, GitHub, Mailchimp, Linear, Asana, Trello,
Pipedrive.

Every one is marked `genericOnly`, and the picker says "explore only". That
label is a promise, not decoration. A §5 metric has a named owner, a freshness
SLA, an assertion gate that leaves the mart untouched on a hard fail, and a row
on the health board. None of these have any of that. Blurring the distinction
would let somebody put a Stripe number on a NOC wall display with no freshness
guarantee behind it — which is precisely how `avis_base_view` went unnoticed for
two weeks.

## Consequences

- Three new dependencies: `mysql2`, `mssql`, `@types/mssql`. Snowflake, Stripe,
  HubSpot and the other fifteen add none — they are `fetch`.
- `testConnection` now runs `validate()` before dialling out, so a typo costs no
  round trip and no rate-limit budget. The result names the **field**, not a hop.
- The "no test implemented" branch is now a loud failure that calls itself a bug
  in the build rather than a degraded mode. It is unreachable while (2) passes.
- Every probe is a real call. None inspects config and reports success.
