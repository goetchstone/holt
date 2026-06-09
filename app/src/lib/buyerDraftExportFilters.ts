// /app/src/lib/buyerDraftExportFilters.ts
//
// Pure helpers that build Prisma WHERE inputs for the buyer-drafts
// export endpoints (items / pos / workbook). Extracted here per
// CLAUDE.md rule 14 so the branching logic is A-grade unit-testable
// while the handlers themselves stay as thin Prisma + HTTP wrappers.
//
// Background — user-reported bug 2026-05-14: clicking Items CSV / POs
// CSV against a CLOSED Buy returned an empty file. Two reasons:
//
//   1. UI didn't pass the active page filters (buyId, status, vendor)
//      to the export URL, so the endpoint saw bare GETs with no
//      filters.
//   2. With no filters, the endpoint hard-coded a `status = READY`
//      default. The buyer's 80 items + 13 POs were all DRAFT, so
//      the filter matched zero rows.
//
// The fix preserves the legacy "READY default for production handoff"
// semantics but DROPS that default whenever the caller is being
// specific — passing `ids` or `buyId` is the caller saying "give me
// exactly this set," not "give me whatever is READY to ship."
//
// Status semantics:
//   - ids passed       → return exactly those ids; no status filter
//   - buyId passed     → return everything in that buy; no status filter
//                        UNLESS the caller also passed an explicit status
//   - explicit status  → use it (even with ids/buyId)
//   - none of above    → default to READY (legacy production-export flow:
//                        "I marked these items READY, now export them
//                        as a batch and stamp EXPORTED")

import type { Prisma, BuyerDraftItemStatus, BuyerDraftPoStatus } from "@prisma/client";

const VALID_ITEM_STATUSES = [
  "DRAFT",
  "READY",
  "EXPORTED",
  "FULFILLED",
  "CANCELLED",
] as const satisfies readonly BuyerDraftItemStatus[];

const VALID_PO_STATUSES = [
  "DRAFT",
  "READY",
  "EXPORTED",
  "FULFILLED",
  "CANCELLED",
] as const satisfies readonly BuyerDraftPoStatus[];

export type BuyIdFilter = number | "unassigned";

export interface ExportQuery {
  ids?: string;
  status?: string;
  vendorId?: string;
  buyId?: string;
}

interface ParsedQuery {
  ids: number[] | null;
  itemStatus: BuyerDraftItemStatus | null;
  poStatus: BuyerDraftPoStatus | null;
  vendorId: number | null;
  buyId: BuyIdFilter | null;
}

function parseIdList(raw: string | undefined): number[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const ids = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

function parseBuyId(raw: string | undefined): BuyIdFilter | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  // The UI passes the literal `unassigned` token when the page's buy
  // filter is set to "Unassigned" — that means "items / POs not yet
  // bucketed into any Buy." Distinct from null/missing which means
  // "no buy filter at all."
  if (trimmed.toLowerCase() === "unassigned") return "unassigned";
  const n = Number.parseInt(trimmed, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseVendorId(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseItemStatus(raw: string | undefined): BuyerDraftItemStatus | null {
  if (typeof raw !== "string") return null;
  return (VALID_ITEM_STATUSES as readonly string[]).includes(raw)
    ? (raw as BuyerDraftItemStatus)
    : null;
}

function parsePoStatus(raw: string | undefined): BuyerDraftPoStatus | null {
  if (typeof raw !== "string") return null;
  return (VALID_PO_STATUSES as readonly string[]).includes(raw)
    ? (raw as BuyerDraftPoStatus)
    : null;
}

export function parseExportQuery(q: ExportQuery): ParsedQuery {
  return {
    ids: parseIdList(q.ids),
    itemStatus: parseItemStatus(q.status),
    poStatus: parsePoStatus(q.status),
    vendorId: parseVendorId(q.vendorId),
    buyId: parseBuyId(q.buyId),
  };
}

/**
 * Build the items WHERE clause. See module header for semantics. The
 * READY default fires ONLY when no ids, no buyId, and no explicit
 * status are passed — keeps the production handoff behavior (export
 * the READY batch, stamp it EXPORTED) intact while letting buy /
 * id-scoped exports return everything in scope.
 */
export function buildItemsWhere(q: ExportQuery): Prisma.BuyerDraftItemWhereInput {
  const parsed = parseExportQuery(q);
  const where: Prisma.BuyerDraftItemWhereInput = {};
  if (parsed.ids) where.id = { in: parsed.ids };
  if (parsed.vendorId !== null) where.vendorId = parsed.vendorId;
  if (parsed.buyId !== null) {
    where.draftPo = parsed.buyId === "unassigned" ? { buyId: null } : { buyId: parsed.buyId };
  }
  if (parsed.itemStatus) {
    where.status = parsed.itemStatus;
  } else if (!parsed.ids && parsed.buyId === null) {
    // Legacy production-handoff default — caller hit `/export/items`
    // with no scoping, so the implied intent is "export the READY
    // batch and stamp it EXPORTED."
    where.status = "READY";
  }
  return where;
}

/** Same shape for POs. */
export function buildPosWhere(q: ExportQuery): Prisma.BuyerDraftPurchaseOrderWhereInput {
  const parsed = parseExportQuery(q);
  const where: Prisma.BuyerDraftPurchaseOrderWhereInput = {};
  if (parsed.ids) where.id = { in: parsed.ids };
  if (parsed.vendorId !== null) where.vendorId = parsed.vendorId;
  if (parsed.buyId !== null) {
    where.buyId = parsed.buyId === "unassigned" ? null : parsed.buyId;
  }
  if (parsed.poStatus) {
    where.status = parsed.poStatus;
  } else if (!parsed.ids && parsed.buyId === null) {
    where.status = "READY";
  }
  return where;
}

/**
 * Workbook WHERE clause — same scoping options as items, but NO
 * READY default ever. The workbook is a buyer-side review artifact
 * (per `export/workbook.ts` header) and the buyer wants the whole
 * picture by default, not just the READY batch.
 */
export function buildWorkbookItemsWhere(q: ExportQuery): Prisma.BuyerDraftItemWhereInput {
  const parsed = parseExportQuery(q);
  const where: Prisma.BuyerDraftItemWhereInput = {};
  if (parsed.ids) where.id = { in: parsed.ids };
  if (parsed.vendorId !== null) where.vendorId = parsed.vendorId;
  if (parsed.buyId !== null) {
    where.draftPo = parsed.buyId === "unassigned" ? { buyId: null } : { buyId: parsed.buyId };
  }
  if (parsed.itemStatus) where.status = parsed.itemStatus;
  return where;
}
