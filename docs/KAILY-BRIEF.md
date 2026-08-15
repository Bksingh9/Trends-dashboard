# S-6 · Kaily connector — task prompt

Status: open. Written 15 Aug 2026.
Supersedes the S-6 stub in `CONNECTOR-BRIEF.md`.

**Reference surface:**
`https://console.fynd.com/kaily/asia-south1/accounts/048572c4-12d3-47e2-a0eb-1260a2b44472/insights`

---

## What is known, and how

`console.fynd.com` is **egress-blocked** from the build container — every Fynd
host returns no connection at all, not a 403. So nothing below about the API is
verified; it is read off the URL's own structure and off Slack. Treat all of it
as a hypothesis to check in step 1.

| Signal | Read from | Confidence |
|---|---|---|
| `/kaily/` is a product namespace on the shared Fynd console | URL | High |
| `asia-south1` — runs in GCP Mumbai | URL | High. Same region as the rest of the estate; a BigQuery dataset or Cloud SQL instance is likely reachable with a service account rather than a console session. |
| `048572c4-…` is the **account/tenant id**, UUID-shaped | URL | High. This is the scope key every API call will need. |
| `/insights` — Kaily **already computes aggregates** | URL | High, and it changes the design. See "Read, don't recompute". |
| Agents, threads, tool calls, an email surface on `inbox.kaily.fyndmail.com`, Resend → "Neo's inbound email webhook" | Slack `#kube-infra`, DOPS-24697 / DOPS-25873 | High |
| `@kaily-ai/chat-sdk` is public on npm — real-time messaging, thread and conversation management, tool integration, user/context handling | Slack `#general`, 26 Mar 2026 release note | High. **Read its README first** — it is the cheapest available description of the domain model. |
| Product line is **CoPilot**, not Companion | Slack | High, and it is the reason step 0 exists |

---

## Step 0 — Establish relevance before writing any code

**Do not skip this.** Four sources in this build were wired against assumptions
and three were wrong; Kaily is the only one where the *entire premise* is
unverified. §0 scopes this dashboard to Companion/Trends. Kaily is a CoPilot
product. Those may not intersect at all.

Answer, in writing:

1. **Does the AJIO Companion journey embed a Kaily assistant?** If a shopper
   inside Companion can talk to it, its conversations are a genuine §4.3
   journey surface and everything below applies. If not, stop.
2. **Is account `048572c4-…` the Trends/Companion tenant**, or a different
   business unit that merely shares a console?
3. **Who owns the number if it goes wrong?** A metric with no owner does not
   belong on a NOC board.

**If the answer to (1) is no:** write `docs/decisions/ADR-004-kaily-scope.md`
recording that Kaily is out of scope and what would bring it in, and stop. That
is a complete, successful outcome. Shipping an unrelated module because a link
was pasted is how a focused dashboard becomes a portal nobody trusts.

---

## Step 1 — Discovery, in this order

Cheapest and most revealing first.

1. **`npm install @kaily-ai/chat-sdk` and read its types.** Free, offline, and
   it gives you the real domain model — thread, message, agent, tool call —
   without a single credential.
2. **Open the `/insights` page with devtools on the network tab.** The console
   is a client app; the XHR it fires *is* the API. Capture:
   - base host and path shape
   - auth header (session cookie vs bearer token vs API key)
   - the account id's position in the path or query
   - the exact response body of the insights call — **save it verbatim**
3. **Look for a warehouse before committing to the API.** Check
   `asia-south1` BigQuery datasets in the Fynd projects for anything
   `kaily_*` / `copilot_*` / `neo_*`. A nightly BigQuery read is cheaper,
   more stable and more auditable than polling a product API, and
   `npm run discover` already does this:
   ```bash
   BQ_DISCOVER_PROJECT=<project> npm run discover
   ```
4. **Ask the owning team** for read access rather than reverse-engineering
   auth. Shreyash Shetty (`U045VMDQ4QL`) and Neeraj (`U09AZLW05MM`) appear on
   the Kaily infra tickets; `#general` has the release thread.

---

## Step 2 — Read, don't recompute

`/insights` existing is the most important thing the URL tells you. Kaily
already has metric definitions. Two consequences:

- **Prefer its aggregates over raw conversations.** Recomputing "containment
  rate" from message logs guarantees a number that disagrees with the one the
  Kaily team quotes, and then two teams argue about arithmetic instead of about
  the product. If both exist, load the aggregate and record the raw as a
  cross-check (§6.3 `crossCheck`), never the other way round.
- **Their definition still has to enter §5.** If a metric is not in
  `lib/metrics/registry.ts` it does not exist in this dashboard. Copy their
  formula verbatim into the `formula` field and cite it. Where their definition
  is ambiguous, mark it `ambiguous: true` — the loyalty metrics are the
  precedent.

---

## Step 3 — Capture fixtures before parsing

Non-negotiable, and the reason three parsers in this repo had to be rewritten.

Save the verbatim `/insights` response — and one raw conversation payload if
you get one — to `fixtures/kaily-samples.ts`, following
`fixtures/slack-samples.ts`:

- one sample per response shape you actually saw
- an `expected` field on each, so the test asserts the classification
- **redact before committing**: no message bodies, no customer emails, no
  bearer tokens. Structure and counts only. If a field's *shape* matters but
  its content is PII, keep the key and replace the value with a marker.

Every number asserted in `tests/kaily-*.test.ts` must be one you read off a
real payload.

---

## Step 4 — Build the connector

Standard lifecycle, `lib/connectors/kaily-insights.ts`:

```
id                    kaily-insights
priority              P2   (P1 only if step 0 finds it inside the Companion journey)
costTier              metered if it is an API; free if BigQuery
freshnessSlaMinutes   start at 24h. Tighten only when the real cadence is known —
                      the catalogue report taught this: a wrong SLA is worse than
                      a loose one, because it hides a real outage for a day and a half
powers                ['/assistant', 'fact_assistant_daily', …]
blockedBy             'KAILY_API_TOKEN — and §0 scope, see ADR-004'
```

- `WINDOW_DAYS` wider than the SLA (late-arriving rows are the norm).
- `isConfigured()` must be **honest**: token present *and* account id set.
- Register in `lib/connectors/registry.ts` and add to `WINDOW_DAYS`.
- **A fixture is mandatory** — `tests/connectors-live.test.ts` fails a
  connector with no fixture, because without one `load()` is never exercised
  until the first production run.

### Mart

New table `fact_assistant_daily`, grained `day × account × agent`:

```
date_key, account_id, agent_id,
sessions, messages, tool_calls, tool_failures,
handoffs_to_human, resolved_without_handoff,
p50_response_ms, p95_response_ms
```

Add it to `lib/db/schema.ts` **and** write a connector for it in the same
commit. The orphan-mart test fails a table that is read but never written —
that test exists because `fact_scan_daily` and `fact_catalogue_gap` shipped
with no writer at all.

### Assertions (§6.3)

- `freshness` on `date_key`
- `rowVolume`, `zeroIsFail: false` — a quiet day is real
- `nullRate` zero on `date_key`, `account_id`
- `valueSet` on `agent_id` against the known agents
- **a parse-rate assertion** if any of it is text-derived; see
  `slack-alerts`' `sentry_parse_rate`
- `crossCheck` against Kaily's own `/insights` totals if you loaded raw

---

## Step 5 — §27.4, and this is the hard part

**Conversation logs are the highest-PII source in the entire build.** Nothing
else here comes close: order rows carry a hashed customer id, but chat carries
whatever a person typed, and an email surface means inbound addresses too.

Rules, no exceptions:

- **No free-text message bodies in any mart.** Aggregates only, unless there is
  an explicit written decision in `docs/decisions/` that says otherwise and who
  approved it.
- **Hash customer identifiers at ingest**, with `CUSTOMER_ID_SALT`, exactly as
  `bq-orders` does. Never store a raw email.
- **No customer-level drilldown in the UI.** §27.4 already forbids it for
  orders; chat makes it worse, not better.
- **Redact fixtures before committing.** A test fixture is in git forever.
- If a metric can only be computed by reading message content, that is a
  finding to raise — not a licence to store the content.

---

## Step 6 — Surface

New route `/assistant`, or a section on `/journey` if step 0 finds the
assistant *inside* the Companion funnel — in which case it belongs in the
funnel, not beside it.

- Every card carries source, grain and last-refreshed (rule 2).
- A metric Kaily computes and we merely display must say so in `source`.
- If Kaily's number and ours disagree, **show both and name the difference**.
  §16.5.2 is the precedent: three coverage measurements that disagree, never
  blended, because the difference is itself the finding.

---

## Done when

- Either a working `/assistant` module backed by real aggregates, **or**
  `ADR-004-kaily-scope.md` recording that it is out of scope and what would
  change that. Both are success.
- `npm run etl:status` shows `kaily-insights` green within its SLA.
- No mart read but unwritten.
- Every asserted number in the tests read off a captured real payload.
- No PII in any fixture, mart or log.
- `npm run test` and `npm run e2e` green with and without `DATABASE_URL`.

## Landmines

- **Do not infer the domain model from the console's UI labels.** Read the SDK
  types. `gtin_value` looked exactly like an EAN and was an internal article
  code 99.9% of the time.
- **A UUID in a URL is a tenant scope, not a filter.** Getting it wrong returns
  a valid-looking empty result rather than an error.
- **`/insights` may paginate.** `runQuery` returned exactly 50,000 rows from
  BigQuery and it took a second look to notice that was a page, not a total.
- **Region matters.** `asia-south1` in the path suggests other regions exist;
  a connector hardcoding one will silently miss the rest.
