/**
 * Verbatim "Daily Catalog Sync Report" messages from `#sng-catalogue-lack`
 * (C0AV6FU1YUU), captured 14 Aug 2026.
 *
 * §18.6 assumed this report carried scan counts — `totalScans`, `totalFailed`,
 * `uniqueScans`, `uniqueFailed` — and `slack-catalogue-report` was written to
 * parse exactly those fields. **None of them exist.** The real report is a
 * *sync* report: how many products moved between Catalog Cloud and the
 * platform, and which validation errors stopped the rest. Scan coverage comes
 * from GA4 (`bq-ga4-scans`); this is a different measurement entirely, and
 * blending them would be a §16.5.2 violation.
 *
 * Three other things the real messages settle, which were open assumptions:
 *
 *  1. **It is hourly, not daily**, despite the title. Every message covers a
 *     one-hour window. The 36-hour freshness SLA and the "expected by 09:00
 *     IST" check in §18.6 were both wrong by more than an order of magnitude.
 *  2. **Inbound and outbound are explicit in the source.** §20.3 inferred that
 *     split; the report states it, and the two carry different error
 *     taxonomies.
 *  3. **The SAP pipeline really is 0/0/0.** §13.9 recorded SAP as "not wired"
 *     as an assumption. The source itself confirms it, every hour.
 *
 * `EAN already assigned to item code` dominates outbound failures — 2,742 of
 * 2,935 in the 18:00 window — which is the same failure `bq-catalogue-master`
 * detects structurally as `ean_assigned_to_multiple_item_codes`. Two
 * independent sources agreeing on the top catalogue defect is worth a great
 * deal more than either alone.
 */

export interface CatalogueReportSample {
  ts: string;
  username: string;
  text: string;
}

export const CATALOGUE_REPORT_SAMPLES: CatalogueReportSample[] = [
  {
    ts: '1786696351.000100',
    username: 'Tatsu Bot',
    text: `Daily Catalog Sync Report (Catalog Cloud <> Platform)
*Report Date:* 2026-08-14  |  *Window:* 2026-08-14 17:00:08 - 2026-08-14 18:00:09 IST
*AJIO Pipeline*
    Synced: 1982
    Inbound Failed: 147
    Outbound Failed: 2935
*Inbound Failure Report:*
\`\`\`
Error Type                                  | Total
--------------------------------------------|-------
Category Mapping Not Found                  |    142
Product Master Sync API Failure             |      5
--------------------------------------------|-------
TOTAL                                       |    147
\`\`\`
*Outbound Failure Report:*
\`\`\`
Error Type                                  | Total
--------------------------------------------|-------
EAN already assigned to item code           |   2742
Duplicate GTIN                              |     87
Country of origin invalid                   |     46
Brand not found                             |     32
Category invalid                            |     16
Updation of primary identifier              |     12
--------------------------------------------|-------
TOTAL                                       |   2935
\`\`\`
*SAP Pipeline*
    Synced: 0
    Inbound Failed: 0
    Outbound Failed: 0
*Inbound Failure Report:*
_No failures detected_
*Outbound Failure Report:*
_No failures detected_
*Reconcile Report (Stage-wise)*
\`\`\`
Overall Summary
--------------------------------------------
Total Passed (Success)    : 0
Total Failed              : 26
--------------------------------------------

Stage          | Total    | Success  | Failed
---------------|----------|----------|--------
resolve        |     2806 |        0 |        0
resync         |       73 |        0 |       26
\`\`\`
_Source: cc_integration_tracking + cc_inbound_tracking | XLSX reports attached in thread_`,
  },
  {
    // The widest error taxonomy in the sample — nine distinct outbound types.
    ts: '1786692674.000200',
    username: 'Tatsu Bot',
    text: `Daily Catalog Sync Report (Catalog Cloud <> Platform)
*Report Date:* 2026-08-14  |  *Window:* 2026-08-14 16:00:09 - 2026-08-14 17:00:08 IST
*AJIO Pipeline*
    Synced: 304
    Inbound Failed: 70
    Outbound Failed: 3822
*Inbound Failure Report:*
\`\`\`
Error Type                                  | Total
--------------------------------------------|-------
Category Mapping Not Found                  |     70
--------------------------------------------|-------
TOTAL                                       |     70
\`\`\`
*Outbound Failure Report:*
\`\`\`
Error Type                                  | Total
--------------------------------------------|-------
EAN already assigned to item code           |   2560
Category invalid                            |    633
Duplicate GTIN                              |    500
Updation of primary identifier              |     53
Country of origin invalid                   |     35
Dimension invalid                           |     27
Cannot enable/disable multi-size option     |     10
HSN code invalid                            |      3
Brand not found                             |      1
--------------------------------------------|-------
TOTAL                                       |   3822
\`\`\`
*SAP Pipeline*
    Synced: 0
    Inbound Failed: 0
    Outbound Failed: 0
*Inbound Failure Report:*
_No failures detected_
*Outbound Failure Report:*
_No failures detected_
*Reconcile Report (Stage-wise)*
\`\`\`
Overall Summary
--------------------------------------------
Total Passed (Success)    : 0
Total Failed              : 492
--------------------------------------------

Stage          | Total    | Success  | Failed
---------------|----------|----------|--------
resolve        |     2883 |        0 |        1
resync         |      820 |        0 |      491
\`\`\`
_Source: cc_integration_tracking + cc_inbound_tracking | XLSX reports attached in thread_`,
  },
  {
    ts: '1786689032.000300',
    username: 'Tatsu Bot',
    text: `Daily Catalog Sync Report (Catalog Cloud <> Platform)
*Report Date:* 2026-08-14  |  *Window:* 2026-08-14 14:00:07 - 2026-08-14 15:00:07 IST
*AJIO Pipeline*
    Synced: 71
    Inbound Failed: 6
    Outbound Failed: 144
*Inbound Failure Report:*
\`\`\`
Error Type                                  | Total
--------------------------------------------|-------
Category Mapping Not Found                  |      6
--------------------------------------------|-------
TOTAL                                       |      6
\`\`\`
*Outbound Failure Report:*
\`\`\`
Error Type                                  | Total
--------------------------------------------|-------
EAN already assigned to item code           |    140
Category invalid                            |      4
--------------------------------------------|-------
TOTAL                                       |    144
\`\`\`
*SAP Pipeline*
    Synced: 0
    Inbound Failed: 0
    Outbound Failed: 0
*Inbound Failure Report:*
_No failures detected_
*Outbound Failure Report:*
_No failures detected_
*Reconcile Report (Stage-wise)*
\`\`\`
Overall Summary
--------------------------------------------
Total Passed (Success)    : 0
Total Failed              : 1
--------------------------------------------

Stage          | Total    | Success  | Failed
---------------|----------|----------|--------
resolve        |      140 |        0 |        0
resync         |        4 |        0 |        1
\`\`\`
_Source: cc_integration_tracking + cc_inbound_tracking | XLSX reports attached in thread_`,
  },
];

/**
 * §20.3 — the real error taxonomy, read off the source rather than invented.
 *
 * The direction is not inferred here: the report itself files each error under
 * an Inbound or an Outbound heading, and that is the split §20.3 needed. Every
 * type below appears in the captured samples.
 *
 * `EAN already assigned to item code` is the same defect `bq-catalogue-master`
 * finds structurally by counting item codes per EAN. Two independent sources
 * naming the same top defect is the strongest evidence in the whole build.
 */
export const CATALOGUE_SYNC_ERRORS: Record<string, { direction: 'inbound' | 'outbound'; maps_to?: string }> = {
  'Category Mapping Not Found': { direction: 'inbound', maps_to: 'category_not_mapped' },
  'Product Master Sync API Failure': { direction: 'inbound', maps_to: 'absent_from_master' },
  'EAN already assigned to item code': {
    direction: 'outbound',
    maps_to: 'ean_assigned_to_multiple_item_codes',
  },
  'Duplicate GTIN': { direction: 'outbound', maps_to: 'ean_assigned_to_multiple_item_codes' },
  'Country of origin invalid': { direction: 'outbound' },
  'Brand not found': { direction: 'outbound' },
  'Category invalid': { direction: 'outbound' },
  'Updation of primary identifier': { direction: 'outbound' },
  'Dimension invalid': { direction: 'outbound' },
  'HSN code invalid': { direction: 'outbound' },
  'Cannot enable/disable multi-size option': { direction: 'outbound' },
};

/**
 * What the real messages settle about cadence. §18.6 said "expected daily by
 * 09:00 IST" and the connector declared a 36-hour SLA; the report is hourly,
 * so a genuine two-hour outage would have gone unremarked for a day and a half.
 */
export const CATALOGUE_REPORT_CADENCE = {
  everyMinutes: 60,
  postedBy: 'Tatsu Bot',
  channelId: 'C0AV6FU1YUU',
  channelName: 'sng-catalogue-lack',
  /** Both pipelines are always reported; SAP has been 0/0/0 in every sample. */
  pipelines: ['AJIO', 'SAP'],
} as const;
