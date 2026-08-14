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
