# Hunter Douglas

Window treatments (blinds, shades). Not a furniture price list -- this is a proposal/quote PDF parser.

**Pricing model**: Line-item (not graded)
**the POS name**: "Hunter Douglas Fabrication"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/hdProposalParser.ts` | Direct Connect Client Proposal PDF parser; `parseHDProposalText` is its pure text seam | Yes (uses pdf-parse) |

## Import Endpoint

`api/sales/import-hd-proposal.ts` -- creates a SalesOrder from a HD proposal PDF.

## What It Does

Parses Hunter Douglas Direct Connect Client Proposal PDFs. Extracts:

- Quote number and customer info
- Line items with MSRP pricing
- Per-line freight and installation costs

Creates or overwrites a SalesOrder with order number `HD-{quoteNumber}`. Freight costs summed into an `HD-FREIGHT` line item; installation costs summed into a `LABOR-HD` line item. Supports re-import for customer revisions.

Lines and numbers are read through `lib/pricing/parseBoundary.ts` (2026-11-21): a line is cut at 1000 characters, an amount that overflows reads as 0, and either puts a warning on `proposal.warnings`, which the import returns with the quote it wrote (`docs/domains/sales-orders.md`, "HD proposal import: parser warnings").

## Import Page

`/app/sales/import-hd` (`app/(dashboard)/app/sales/import-hd/ImportHdView.tsx`) with nav card on the Sales hub page. The page needs `sales.read`; the import endpoint needs `admin.data`. It lists the parser's warnings at the top of the result.

## Key Files

- `lib/pricing/hdProposalParser.ts` -- PDF parser (server-only)
- `pages/api/sales/import-hd-proposal.ts` -- import endpoint
- `app/(dashboard)/app/sales/import-hd/ImportHdView.tsx` -- UI page

---
Last verified: 2026-04-07; parser, endpoint gate and import page 2026-11-21 against source.
