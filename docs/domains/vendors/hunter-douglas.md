# Hunter Douglas

Window treatments (blinds, shades). Not a furniture price list -- this is a proposal/quote PDF parser.

**Pricing model**: Line-item (not graded)
**the POS name**: "Hunter Douglas Fabrication"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/hdProposalParser.ts` | Direct Connect Client Proposal PDF parser | Yes (uses pdf-parse) |

## Import Endpoint

`api/sales/import-hd-proposal.ts` -- creates a SalesOrder from a HD proposal PDF.

## What It Does

Parses Hunter Douglas Direct Connect Client Proposal PDFs. Extracts:

- Quote number and customer info
- Line items with MSRP pricing
- Per-line freight and installation costs

Creates or overwrites a SalesOrder with order number `HD-{quoteNumber}`. Freight costs summed into an `HD-FREIGHT` line item; installation costs summed into a `LABOR-HD` line item. Supports re-import for customer revisions.

## Import Page

`pages/sales/import-hd.tsx` with nav card on the Sales hub page. Manager-only.

## Key Files

- `lib/pricing/hdProposalParser.ts` -- PDF parser (server-only)
- `pages/api/sales/import-hd-proposal.ts` -- import endpoint
- `pages/sales/import-hd.tsx` -- UI page

---
Last verified: 2026-04-07
