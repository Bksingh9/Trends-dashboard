# ADR-001 — Wiring Reliance One Loyalty, against §0

**Status:** accepted · **Date:** 2026-08-14 · **Decided by:** Brijkishor Singh (PM)

## Context

§0 of the master spec is explicit:

> **Out of scope for v1 — Reliance One 2.0 loyalty.** Explicitly excluded per PM
> direction. The loyalty GA4 property (`p542441622`, project
> `fynd-jio-impetus-prod`) and `#sng-loyalty` are *not* wired in v1. Leave a
> `loyalty` module stub with a feature flag `MODULE_LOYALTY=false` so it can be
> switched on later without refactoring.

During the build the PM asked for the "impetus prod db" to be wired end to end.
That phrase maps to `fynd-jio-impetus-prod`, which is the Loyalty project. The
conflict with §0 was raised explicitly, with the three candidate readings laid
out (Companion prod only / also Loyalty / a self-hosted Postgres). The PM chose
**"Also wire fynd-jio-impetus-prod / Loyalty"**.

This ADR records that as a deliberate scope decision rather than letting it
happen quietly in a commit message — which is precisely the failure mode the
open-assumptions register exists to prevent.

## Decision

Wire Loyalty as a full module, behind `MODULE_LOYALTY`, which now defaults to
**off** and is switched on by configuration.

Specifically:

- `bq-loyalty` connector reading the Loyalty GA4 export in
  `fynd-jio-impetus-prod`, configured by `BQ_LOYALTY_PROJECT` /
  `BQ_LOYALTY_DATASET`.
- Loyalty metrics added to the §5 registry, so they carry a formula, source and
  grain like every other metric and cannot be computed ad hoc in a component.
- A `/loyalty` route, hidden from the module rail when the flag is off.
- A doctor check that reports whether the Companion service account can even
  read the Loyalty project.

## Consequences, stated plainly

**This is a genuine departure from the spec, not a detail.** Three things follow
that are worth knowing before anyone relies on the numbers:

1. **It is a different GCP project.** The Companion service account is scoped to
   `sng-prod`. It very likely has no access to `fynd-jio-impetus-prod` and will
   need a separate IAM grant. The doctor check reports this precisely rather
   than failing vaguely.

2. **The Loyalty event taxonomy is unverified.** The spec documents the Loyalty
   *property id* and nothing about its events. Every Loyalty metric defined here
   is therefore a **proposal**, marked `ambiguous` in the registry and rendered
   with the caveat visible, exactly as the unconfirmed Companion metrics are.
   They must be reconciled against the real export before anyone quotes them.
   The §16.1 inventory query is the way to do that.

3. **Loyalty and Companion are different populations.** A loyalty member is not
   a Companion user, and the two properties count sessions differently. Joining
   them on customer id requires the same hashing discipline as §27.4, and any
   cross-property rate (for example "loyalty attach rate on Companion orders")
   is only meaningful once that join is verified. Until then the Loyalty module
   reports Loyalty-side figures and does not blend them into Companion KPIs.

**What has not changed:** Loyalty is excluded from the App Health Score, the six
hub health lights, and the AI daily brief's Companion context. Adding it there
would change the meaning of numbers leadership already reads, which is a
separate decision from "make Loyalty visible".

## Revisiting

If the intent was actually a self-hosted Postgres for the serving marts rather
than the Loyalty BigQuery project, this ADR should be superseded — that is
`DATABASE_URL` and the §7 schema, and needs none of the above.

---

## Addendum — what the credential actually opened (2026-08-15)

A service account for `fynd-jio-impetus-prod` arrived, and it disproves two of
this ADR's premises.

**It is not a Loyalty analytics project.** Sixteen datasets, none of them
`analytics_*`. What it holds is catalogue: `rbl_catalog_structured_v5/v6/v7`,
`multi_brand_catalog`, `reliance_brands_data_3year`. The connection doctor
reports this accurately — "readable but no `analytics_* dataset found" — rather
than claiming success. `MODULE_LOYALTY` therefore stays off: the feed it was
written against does not exist here.

**`sng-prod` is not readable with this key.** Confirmed by a 403 on
`INFORMATION_SCHEMA`. Companion's own orders and GA4 export live there and need
a separate grant, which is the warning this ADR opened with, now demonstrated.

### The catalogue lead, and why it does not work either

`rbl_catalog_structured_v7` looked like the §20.2 product master it has been
missing: 1,81,022 products, 1,77,741 variants, with `gtin_value` and `sku`
columns that read exactly like EAN and item code.

Running it live settled it. **49,955 of the first 50,000 variant rows carry
`gtin_type = 'ALU'`** — Reliance's internal Article Level Unit code, not a
barcode. Only 45 rows carry a scannable identifier type, collapsing to 9 unique
`(ean, item_code)` pairs.

This matters far more than "the table was the wrong one". Had the `gtin_type`
filter not been added, all 1.8 lakh ALUs would have been written into
`dim_product.ean`, where **no scan could ever match one** — and §20.3 classifies
any scanned EAN absent from the master as `absent_from_master`. The dashboard
would have reported the entire catalogue as missing from the master: the most
alarming reason in the taxonomy, stated with complete confidence, and a pure
artefact of a column-name coincidence.

Three defences came out of it:

- `BARCODE_GTIN_TYPES` — only EAN/UPC/GTIN-family types reach the EAN column.
  Everything else is counted by type and reported, not silently dropped.
- The `cardinality` assertion on `ean` is now **fail**, not warn. A collapsed
  product dimension is worse than a stale one, and §6.3 hard-fail keeps the
  mart on its last good snapshot rather than overwriting it with nine rows.
- `stripFloatArtefact` — `gtin_value` arrives as `410219992001.0`, having
  passed through a FLOAT64 upstream. That trailing `.0` is why every value
  failed check-digit validation, and it is §19.3's hazard exactly. Stripping it
  is safe; `Number()` would not be, because it discards leading zeros.

### Two other bugs only production could find

- BigQuery rejects a job label containing a colon. `${this.id}:${source}` was
  invalid and no amount of local review would have caught it.
- The real catalogue contains duplicate `(ean, item_code)` pairs, so an
  `ON CONFLICT DO UPDATE` batch touching one row twice failed the entire load.
  Those duplicates *are* the §20.3 `ean_assigned_to_multiple_item_codes`
  defect — the largest error class in the Tatsu sync report, at 2,742 of 2,935
  outbound failures in a single hour. The loader now collapses them and
  publishes the count as a catalogue finding.

### Still open

Where the real EAN master lives. `multi_brand_catalog` and the `rbl_catalog_raw_*`
datasets are unexplored, and the Orbis item table named in §20.2 sits in
`sng-prod`, which this key cannot reach.
