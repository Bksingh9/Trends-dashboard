# ADR-007 — What the live credential found

**Date:** 2026-08-15
**Status:** Accepted
**Relates to:** §13.1, §13.2, §16.1, §20.2, §4.9, §4.11
**Amends:** ADR-001's addendum on the catalogue master

Pointing the `superset-bq@fynd-jio-impetus-prod` service account at real
BigQuery settled three open questions and exposed three defects. None of the
defects was visible without a live credential, which is why they had survived
every previous review.

## Found: the EAN master

`analytics_boltic_sng.catalog` — Scan-and-Go's own catalogue.

| | rows | distinct | notes |
|---|---|---|---|
| `catalog` | 6,520,345 | 3,408,260 identifiers | 2,524,920 active and barcode-shaped |
| `catalog_listing` | 24,078,204 | — | store × product |
| `article` | 17,304,996 | — | store inventory |

`seller_identifier` holds real GS1 barcodes: `8907844327152` (Indian prefix),
`4062452450730` (Puma). This is what `rbl_catalog_structured_v7` was not —
49,955 of 50,000 sampled rows there carried `gtin_type = 'ALU'`, an internal
article code no customer can scan.

`bq-catalogue-master` now prefers this source. Two deliberate choices in
`SNG_ITEM_SQL`:

- **`gtin_type` is derived, not asserted.** The table has no identifier-type
  column. Stamping every row `EAN` would push the 13% that are not
  barcode-shaped into `dim_product.ean`, where no scan can match them — the
  exact failure the ALU discovery was about. Non-barcode-shaped rows are
  labelled `UNVERIFIED` and the existing filter excludes and counts them.
- **`category` is null,** because the table has none. `category_not_mapped` is a
  real §20.3 defect reason in the Tatsu sync report; reporting it is the point.

Verified: 332,873 real EAN rows loaded through the connector's own path.

## Found: the GA4 exports, and that neither is Companion

`analytics_528755832` and `analytics_541706798` both exist and are live (the
first has intraday tables). Reading their event names settles what they are:

- `528755832` — `page_view`, `element_clicked`, `login`, `audit_list_viewed`.
- `541706798` — `task_create_published`, `survey_create_published`, `app_error`.

Neither carries `scan_attempt`, `add_to_cart` or `purchase`. **They are internal
web tools, not Companion.** §13.1 is therefore partly settled and partly not:
the export for property 524294430 is not in this project, and pointing the
Companion funnel at either of these would put a different product's numbers
under a Companion heading.

## Fixed: three defects

### 1. BigQuery reads were returning one page

`runQuery` posted to `jobs.query` and returned `json.rows`. That endpoint
returns **at most the first page** — 50,000 rows, or fewer at the 10 MB page
ceiling — and hands back a `pageToken` for the rest. The token was ignored.

A 6.5 M-row catalogue would have loaded 50,000 rows, filled the mart, passed its
assertions on what arrived, and reported `live`. Every EAN past the cut would
have classified as `absent_from_master` — the most alarming reason in the §20.3
taxonomy, and entirely an artefact of the read.

The same call also treated an incomplete job as an empty one: `timeoutMs` bounds
the *request*, not the query, so anything slower than 60 s returned
`jobComplete: false` with no rows and read as a successful run over nothing.

`runQuery` now paginates and polls, and reports `truncated` and `pages`.
Truncation is **reported, never inferred** — a query returning exactly `maxRows`
rows and one cut off at `maxRows` are the same size and only one is partial.

### 2. A pasted credential could never be tested

`config` is built once at import from `process.env`. "Test connection" sets
`GCP_SA_KEY_JSON` for the length of one call, so `serviceAccountKey()` never saw
it. **Every GCP connection test failed** with "GCP_SA_KEY_JSON not configured",
including the ones holding a perfectly good key — and the message blamed the
credential. The key cache is now keyed on the raw value and reads `process.env`
first.

### 3. The token cache was shared across accounts

`tokenCache` was one global. Test account A, then account B, and B returns A's
token — reporting "connected" for a credential that was never checked. With two
projects and two keys in play that is not hypothetical. It is now keyed on
`client_email` + scopes.

Related: `listDatasets` used `INFORMATION_SCHEMA.SCHEMATA`, which is
region-scoped and returned 16 of 242 datasets. The BigQuery connection test drew
the obvious conclusion from an incomplete list and reported "No analytics_*
dataset here", which was false — both GA4 exports were among the missing 226.
It now uses `datasets.list`.

## Built: Browse BigQuery (§4.9)

The navigator every BI tool opens with — datasets, tables with row counts and
sizes, columns. Previously the only way to see inside the warehouse was
`npm run discover` from a terminal.

Metadata only: `datasets.list`, `tables.list`, `tables.get` and `__TABLES__` all
scan zero bytes. That is a constraint, not an optimisation — a browser that
bills a query every time somebody expands a folder is one nobody is allowed to
use twice.

## Built: Help & Support Analytics (§4.11)

GA4 Data API v1beta, property 524294430, three events:
`help_support_sheet_view`, `help_support_tap`, `help_support_call_tap`.

- The GA4 call happens in `/api/analytics/help-events` and nowhere else. No
  credential reaches the browser, a prop, or an RSC payload.
- **`eventCountPerUser` is recomputed, never summed.** It is a ratio, and ratios
  do not add; summing the three rows gives 7.37 where the answer is 5.86 — a
  plausible, meaningless number.
- **`totalUsers` comes from a property-level total,** not the sum of three
  per-event figures, because the same person appears in more than one.
- A failure returns 200 with `state: "missing"` and a **named remedy**. The four
  ways this fails have four different owners: the API not being enabled is a
  console click, the account not being on the property is a GA4 Admin task, a
  wrong id is a typo, and a missing key is a deploy. A status code cannot tell
  them apart, and "could not load help analytics" sends someone hunting.

Current state against property 524294430: `api_disabled`. The Data API has never
been enabled on the service account's project, so the section renders its error
state with the fix. **Two steps unblock it** — enable "Google Analytics Data
API" in the Cloud console, and add `superset-bq@fynd-jio-impetus-prod.iam.gserviceaccount.com`
as Viewer on property 524294430. Nothing else changes.

## Still blocked

- **Slack** — `slack.com` does not resolve from this environment. The connector
  and its parsers are built and tested against captured real messages; they
  cannot be exercised live here.
- **Google Sheets** — the auth hop works. No sheet has been shared with
  `superset-bq@…`, so there is nothing to read.
- **`sng-prod`** — now returns 200 with zero datasets rather than 403. The
  project is visible to this account and its contents are not.
