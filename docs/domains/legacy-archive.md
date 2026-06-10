# Legacy Archive

Read-only lookup of sales history imported from a client's PREVIOUS system —
loaded once at onboarding so staff can answer "what did this customer buy
before the cutover?" Feature flag `legacyArchive` (default off; flip in
Settings → Modules).

## Design decisions (deliberate isolation)

- **No FK to live tables.** Contact fields are per-order snapshots; the
  archive never references `Customer`, `Product`, or anything live. A
  customer merge or product rename cannot corrupt history.
- **Never written by imports, never read by reports.** The only writer is
  the one-time loader; the only reader is the lookup page. Nothing in
  reporting/leveling/AR touches these tables.
- **No quantity column.** Source systems rarely export clean per-line
  quantities; the viewer shows `lineTotal` only. `misc1`–`misc5` are
  free-form passthrough columns for source fields with no generic home.
- **Search**: `buildLegacyArchiveWhere` in `lib/legacyArchive.ts` reuses the
  canonical `buildSearchFilter` (AND-of-ORs across tokens) over name /
  company / phone / phone2 / address / city / zip / customerCode /
  orderNumber. Trigram GIN indexes (migration `20260610b_legacy_archive`,
  `pg_trgm`) keep ILIKE fast at archive scale (hundreds of thousands of
  rows).

## Surfaces

- Page: `/app/tools/legacy-archive` — `requirePage()` (any signed-in staff)
  + feature gate `notFound()`. Tools hub card carries
  `feature: "legacyArchive"`.
- tRPC: `legacyArchive.search` — `protectedProcedure` + feature gate
  (NOT_FOUND when off). Empty search returns only meta (order count + date
  range); no full-table scan. 25 rows/page with nested lines.

## Loading an archive (per deployment, not per fork)

`node scripts/import-legacy-archive.mjs <mapping.json> <orders-file> <lines-file>`

The mapping config is the ONLY source-specific artifact — it names which
delimited-file column fills which field. Files may be `.gz`. Idempotent:
orders upsert on `orderNumber`, lines are replaced per order, 500-order
transactions. Every run writes a `LegacyImportLog` row.

Example mapping (a POSIM-style export):

```json
{
  "delimiter": "\t",
  "dateFormat": "iso",
  "order": {
    "invoiceId": "orderNumber",
    "saleDate": "saleDate",
    "customerId": "customerCode",
    "billName": "customerName",
    "company": "companyName",
    "phone1": "phone",
    "addr1": "address",
    "city": "city",
    "state": "state",
    "postal": "zip",
    "grandTotal": "grandTotal",
    "taxTotal": "taxTotal"
  },
  "line": {
    "invoiceId": "orderNumber",
    "sku": "sku",
    "description": "description",
    "extPrice": "lineTotal",
    "vendor": "vendor",
    "vendorSku": "vendorSku"
  }
}
```

Editions note (docs/DEPLOYMENTS.md): the mapping config + source dump live
in the deployment layer, never in this repo. The Saybrook deployment's
POSIM config is edition material.

## Tests

`__tests__/legacyArchive.test.ts` — search-builder contract (AND-of-ORs,
field list, case-insensitivity, page size).
