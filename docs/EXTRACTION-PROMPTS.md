# Extraction prompts (Appendix A)

Claude Code runs in a container with no Google, Quip or GA4 session, and
`analytics.google.com` is blocked at the network egress proxy besides. It cannot
read any of these sources directly.

These prompts run in **your** browser via the Claude Chrome extension, with the
relevant tab open and signed in. Save each output into `/docs/source/`, and the
connectors pick the local files up automatically — `sheets-store-master` already
reads `docs/source/store_master.csv` when the Sheets API isn't configured.

> **Before running A.3:** the GA4 event sheet is a *document*, not the source of
> truth. The authoritative answer is the BigQuery inventory query in §16.1, and
> the second-best is the `hashira-theme` GTM constants. Use the sheet to
> cross-check, not to decide. `/journey/events` shows the reconciliation.

---

## A.1 — Any Google Doc → markdown

> With this Google Doc open, read the entire document from top to bottom, scrolling as needed until you reach the end. Reproduce the complete content as clean markdown: preserve the heading hierarchy, all tables as markdown tables, all lists, and every URL as a link. Do not summarise, do not skip sections, and do not editorialise. If a section contains an image or diagram, insert `[IMAGE: <one-line description of what it shows>]` in place of it. At the top, add a metadata block with the document title, the doc URL, and today's date. Output the markdown in a single code block so I can copy it in one action.

**Save to:** `docs/source/<doc-name>.md`

## A.2 — Store master sheet → CSV · **highest priority**

Nothing store-level works without this. It populates `dim_store`, which every
store and state rollup, the deep-link builder, and the dark-store worklist
depend on.

> With this Google Sheet open, go to the tab containing the Store Code and Store ID mapping. Read every row from the header to the last populated row, scrolling as needed. Output the full contents as CSV in a single code block, with the header row first. Preserve store codes exactly as written including any leading zeros — treat every value as text, never as a number. If there are multiple relevant tabs, output each as a separate CSV block labelled with the tab name. Tell me the total row count per tab so I can verify nothing was truncated.

**Save to:** `docs/source/store_master.csv`
**Sheet:** `11eqPcFZnGm4mAG0SS5DvS_4o8IwcpJSMsXE_HorQreE`

The connector's header alias table handles reasonable naming drift and hard-fails
with the headers it actually found if a required column is missing. Leading
zeros are the thing to watch: `00421` becoming `421` silently drops every join.

## A.3 — GA4 event sheet → event dictionary

> With this Google Sheet open, extract the complete GA4 event documentation for the Companion App. For every event listed, capture: event name, every parameter name, parameter type, which screen or component fires it, the trigger condition, and whether it is marked as live, planned, or deprecated. Output as a markdown table, one row per event-parameter pair so nothing is collapsed. Check every tab in the workbook and label which tab each block came from. At the end, list any event that appears in the sheet without a parameter list, and any note or comment cell that qualifies an event's status.

**Save to:** `docs/source/EVENT_DICTIONARY_SHEET.md`
**Sheet:** `1vbYPH919bSLRcYPz273X3Tz2QPOprXmhU4Mb8ehJwNY`

## A.4 — Quip RPOS APIs → markdown

This is what replaces the **placeholder latency SLOs** (A10). Until it's
extracted, `slo_confirmed` stays false and latency breaches do not alert.

> With this Quip document open, read the entire document including any nested or collapsed sections and reproduce it as markdown. I specifically need, for every API described: the endpoint path, HTTP method, request payload fields, response payload fields, error codes and their meanings, any stated latency or timeout expectation, and any stated rate limit. Keep all code blocks and sample payloads verbatim. Preserve tables as markdown tables. Output in a single code block. If any section is empty or marked as TODO in the source, say so explicitly rather than omitting it.

**Save to:** `docs/source/RPOS_APIS.md`
**Doc:** `gofynd.quip.com/83RgAh9CLjcK/RPOS-APIs`

## A.5 — Reference dashboard structure

A12 — the reference dashboard's information architecture was never observed;
§3.2 was derived from page metadata alone. Run this before design lock and
reconcile anything that contradicts it. The capture wins.

> I'm signed into this dashboard. Map its complete structure for me. Walk through every navigation item in the sidebar and every tab within each page, and for each one record: the page name and URL path, every KPI shown in the header strip with its exact label and how it's formatted, every chart with its type, what's on each axis, and its title, every table with its column headers, and every filter or date control available. Also note the layout pattern — where KPIs sit relative to charts, how dense the grid is, and how many items appear above the fold. Then describe the visual system: background and surface colours as hex if you can read them, the fonts used for headings, body, and numbers, the accent colours and what states they encode, corner radius, and border treatment. Finally, tell me which single element on each page draws the eye first. Output as structured markdown, one section per page. Do not skip pages that look similar to others — I need the actual inventory, not a summary.

**Save to:** `docs/source/REFERENCE_DASHBOARD_IA.md`

## A.6 — Geckoboard widget inventory

The dashboard this one supersedes. Mine it for widget definitions before
switching it off, so nothing anyone relies on is silently dropped.

> With this Geckoboard dashboard open, list every widget on it. For each: the widget title, the metric it displays, its visualisation type, the time window it covers, the data source named on or under it if visible, and the current value shown. Note which widgets appear stale, broken, or showing no data. Output as a markdown table. At the end, tell me which widgets appear to duplicate each other.

**Save to:** `docs/source/GECKOBOARD_WIDGETS.md`

---

## A.7 — GA4 UI, for the parts BigQuery can't answer

Most GA4 questions are better answered from the export than the UI — it is
event-level, every parameter is available immediately, and it is joinable to
everything else. Use the UI only for the property settings the export cannot
tell you, which are exactly the open assumptions:

> I'm signed into Google Analytics for the Companion App property (account 384216496, property 524294430). Find and report, exactly as shown:
>
> 1. **Admin → Property Settings → Reporting time zone.** Report the exact timezone string. (This settles A7. If it is not IST, the funnel and revenue will never tie, because orders are aggregated on IST days.)
> 2. **Admin → Product links → BigQuery links.** Report the linked GCP project id, the dataset name, the export type (daily and/or streaming), and whether the export is currently active. (This settles A4 and A14 — the single highest-leverage unblock in the build.)
> 3. **Admin → Custom definitions → Custom dimensions.** List every registered dimension with its parameter name, scope, and display name. I specifically need to know whether `store_id`, `ean`, `result` and `sales_channel` are registered. (This settles A8.)
> 4. **Admin → Data streams.** List each stream, its platform, and its measurement id.
> 5. **Reports → Engagement → Events.** List every event name with its event count for the last 28 days, sorted by count. Include events with low volume — do not truncate.
>
> Output as structured markdown, one section per item. If a section is empty or you lack permission to view it, say so explicitly rather than omitting it.

**Save to:** `docs/source/GA4_PROPERTY_SETTINGS.md`

Item 2 is the one to run first. It closes A4, which gates the funnel, the Scan
Strip, scan-level catalogue analysis, and the eventual replacement of the Slack
bot as the catalogue source. Once you have the project and dataset, set
`BQ_GA4_PROJECT` and `BQ_GA4_DATASET` and the whole journey module goes live.

Item 5 is a useful cross-check but is **not** authoritative: the GA4 UI applies
sampling and cardinality thresholds silently (§17.5). Where the UI and BigQuery
disagree, BigQuery is right.
