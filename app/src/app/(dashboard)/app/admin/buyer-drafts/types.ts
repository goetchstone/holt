// /app/src/app/(dashboard)/app/admin/buyer-drafts/types.ts
//
// Shared client-side types + small presentation constants for the buyer-drafts
// workbench (App Router port). The shapes mirror the /api/admin/buyer-drafts/*
// REST responses one-to-one; they are intentionally local to the view since the
// page consumes the JSON, not the Prisma models.

export interface DraftItem {
  id: number;
  vendorId: number | null;
  vendorName: string;
  partNumber: string;
  productName: string;
  cost: string;
  retail: string;
  msrp: string | null;
  description: string | null;
  productWidth: string | null;
  productLength: string | null;
  productHeight: string | null;
  stockProgram: boolean;
  stockFamily: string | null;
  vignette: string | null;
  qty: number;
  draftPoId: number | null;
  stockLocationId: number | null;
  barcode: string | null;
  // Configurator-style fields (slice 4a + 4-lite-v2)
  itemType: "UPHOLSTERY" | "CASE_GOODS" | "OTHER";
  grade: string | null;
  fabric: string | null;
  finish: string | null;
  cushions: string | null;
  cleaningCode: string | null;
  tossPillows: string | null;
  hardware: string | null;
  hardwareFinish: string | null;
  options: string | null;
  status: "DRAFT" | "READY" | "EXPORTED" | "FULFILLED" | "CANCELLED";
  source: "MANUAL" | "HD_PROPOSAL" | "APPAREL_SCAN" | "CONFIGURATOR";
  notes: string | null;
  vendor?: { id: number; name: string; code: string | null } | null;
  department?: { id: number; name: string } | null;
  category?: { id: number; name: string } | null;
  type?: { id: number; name: string } | null;
  stockLocation?: { id: number; code: string; name: string } | null;
  draftPo?: { id: number; referenceNumber: string | null } | null;
  // Slice 6.1: when fulfilledProductId is set, the items API returns
  // the linked Product so the card can render catalog fallbacks.
  fulfilledProductId?: number | null;
  fulfilledProduct?: {
    id: number;
    productNumber: string;
    name: string;
    description: string | null;
    baseCost: string | null;
    baseRetail: string | null;
    mapPrice: string | null;
    width: number | null;
    depth: number | null;
    height: number | null;
  } | null;
}

export interface DraftPo {
  id: number;
  vendorId: number | null;
  vendorName: string;
  referenceNumber: string | null;
  expectedShipMonth: string | null;
  storeLocationId: number | null;
  buyId: number | null;
  status: "DRAFT" | "READY" | "EXPORTED" | "FULFILLED" | "CANCELLED";
  vendor?: { id: number; name: string; code: string | null } | null;
  storeLocation?: { id: number; name: string; code: string } | null;
  _count?: { items: number };
}

export interface DraftBuy {
  id: number;
  name: string;
  season: string | null;
  year: number | null;
  budget: string | null;
  status: "PLANNING" | "OPEN" | "EXPORTED" | "CLOSED";
}

// Filter values used by both PO filter and Buy filter.
export type IdOrAllOrUnassigned = number | "ALL" | "UNASSIGNED";

export interface Vendor {
  id: number;
  name: string;
  code: string | null;
}
export interface Department {
  id: number;
  name: string;
}
export interface Category {
  id: number;
  name: string;
  departmentId: number;
}
export interface Type {
  id: number;
  name: string;
  categoryId: number;
}
export interface StockLocation {
  id: number;
  code: string;
  name: string;
}
export interface StoreLocation {
  id: number;
  code: string;
  name: string;
}

export const STATUSES = ["DRAFT", "READY", "EXPORTED", "FULFILLED", "CANCELLED"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_BADGE: Record<Status, string> = {
  DRAFT: "bg-sh-stripe text-sh-gray",
  READY: "bg-sh-gold/20 text-sh-gold",
  EXPORTED: "bg-sh-blue/15 text-sh-blue",
  FULFILLED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-red-100 text-red-700",
};

export const BUY_STATUS_BADGE: Record<DraftBuy["status"], string> = {
  PLANNING: "bg-sh-stripe text-sh-gray",
  OPEN: "bg-sh-gold/20 text-sh-gold",
  EXPORTED: "bg-sh-blue/15 text-sh-blue",
  CLOSED: "bg-emerald-100 text-emerald-700",
};

export function formatBuyOptionLabel(b: DraftBuy): string {
  const yearSuffix = b.year ? ` (${b.year})` : "";
  return `${b.name}${yearSuffix} — ${b.status}`;
}
