// /app/src/lib/buyerDraftRequestBody.ts
//
// Pure body-coercion helpers for the buyer-drafts API endpoints. Extracted
// from `pages/api/admin/buyer-drafts/items/{index,[id]}.ts` and `pos/{index,[id]}.ts`
// per CLAUDE.md rule 14 — the testable surface is the validation + Prisma-payload
// shaping, not the HTTP wrapper around it.
//
// Every function in this file is pure (no I/O, no Prisma calls, no Date.now)
// and every branch is pinned by A-grade tests in
// `__tests__/buyerDraftRequestBody.test.ts`. Handlers import from here and
// stay thin: parse → coerce here → call Prisma → handle error → respond.

import {
  Prisma,
  BuyerDraftItemStatus,
  BuyerDraftSource,
  BuyerDraftPoStatus,
  BuyerDraftItemType,
  BuyerDraftBuyStatus,
} from "@prisma/client";

// ─── Whitelisted enum values ──────────────────────────────────────────

export const VALID_ITEM_STATUSES: readonly BuyerDraftItemStatus[] = [
  "DRAFT",
  "READY",
  "EXPORTED",
  "FULFILLED",
  "CANCELLED",
];

export const VALID_PO_STATUSES: readonly BuyerDraftPoStatus[] = [
  "DRAFT",
  "READY",
  "EXPORTED",
  "FULFILLED",
  "CANCELLED",
];

export const VALID_SOURCES: readonly BuyerDraftSource[] = [
  "MANUAL",
  "HD_PROPOSAL",
  "APPAREL_SCAN",
  "CONFIGURATOR",
];

export const VALID_ITEM_TYPES: readonly BuyerDraftItemType[] = [
  "UPHOLSTERY",
  "CASE_GOODS",
  "OTHER",
];

export const VALID_BUY_STATUSES: readonly BuyerDraftBuyStatus[] = [
  "PLANNING",
  "OPEN",
  "EXPORTED",
  "CLOSED",
];

// ─── Primitive coercers ────────────────────────────────────────────────
//
// Each one has a deliberate behavior on bad input — never throw silently;
// either coerce-with-default or throw a `TypeError` so the handler can
// translate to a 400.

/** Trim a string; return "" if not a string. */
export function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Trim a string; return null if not a string OR if trimmed is empty. */
export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Coerce to integer; return null on null/undefined/""/non-integer. */
export function optionalInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/** Coerce to finite number; return 0 on null/undefined/""/NaN/Infinity. */
export function numberOrZero(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Coerce to Decimal; return null on null/undefined/""/NaN/Infinity. */
export function optionalDecimal(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? new Prisma.Decimal(n) : null;
}

/**
 * Required Decimal — throws TypeError if missing or NaN/Infinity. Caller
 * (the handler's update path) maps the throw to a 400 response.
 */
export function decimalOrThrow(value: unknown, field: string): Prisma.Decimal {
  if (value === null || value === undefined || value === "") {
    throw new TypeError(`${field} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${field} must be a finite number`);
  return new Prisma.Decimal(n);
}

/** Pass through a JSON-shaped value; return undefined to mean "don't touch". */
export function optionalJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}

/**
 * Coerce a Date-ish input. Accepts ISO strings, Date objects, null, "".
 * Returns null on anything that fails Date parsing — never throws.
 */
export function optionalDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Coerce a "ship month" input to a first-of-month UTC Date. Accepts:
 *  - YYYY-MM string (canonical, what `<input type="month">` emits)
 *  - MM-YYYY string (legacy iPad-Safari shape, see 2026-05-13 failure log)
 *  - Date object (already-Date, pass through after validation)
 *  - ISO datetime string (e.g. "2026-03-01T00:00:00.000Z" from a
 *    round-trip through the API)
 *  - null / "" / undefined → null
 *
 * This is the WRITE-boundary coercion for `BuyerDraftPurchaseOrder.
 * expectedShipMonth`. The column is `DateTime?` since 2026-05-13;
 * normalizing all input shapes here keeps the storage canonical
 * regardless of which client surface produced it.
 */
export function coerceShipMonthInput(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // YYYY-MM (the most common shape — input type=month emits this)
  const yyyyMm = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(trimmed);
  if (yyyyMm) {
    return new Date(Date.UTC(Number(yyyyMm[1]), Number(yyyyMm[2]) - 1, 1));
  }
  // MM-YYYY (legacy / iPad-Safari quirk; see 2026-05-13 failure log)
  const mmYyyy = /^(0[1-9]|1[0-2])-(\d{4})$/.exec(trimmed);
  if (mmYyyy) {
    return new Date(Date.UTC(Number(mmYyyy[2]), Number(mmYyyy[1]) - 1, 1));
  }
  // Fall back to native Date parsing (handles full ISO strings).
  // Failing that, return null rather than feeding garbage to the DB.
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pick a value from a whitelist or fall back. */
export function pickEnum<T extends string>(value: unknown, valid: readonly T[], fallback: T): T {
  if (typeof value === "string" && (valid as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

/**
 * Build a Prisma `connect` / `disconnect` object from a value:
 *   - null / undefined / "" / non-integer → disconnect
 *   - integer → connect to that id
 *
 * Used for FK fields where the API allows the client to clear the link
 * by sending null or empty.
 */
export function connectOrDisconnect(
  value: unknown,
): { connect: { id: number } } | { disconnect: true } {
  if (value === null || value === undefined || value === "") {
    return { disconnect: true };
  }
  const n = Number(value);
  if (!Number.isInteger(n)) return { disconnect: true };
  return { connect: { id: n } };
}

/** Validate qty: must be a non-negative integer, throws TypeError otherwise. */
export function validatedQty(value: unknown): number {
  const q = Number(value);
  if (!Number.isInteger(q) || q < 0) {
    throw new TypeError("qty must be a non-negative integer");
  }
  return q;
}

// ─── BuyerDraftItem create payload ────────────────────────────────────

export interface BuyerDraftItemCreateBody {
  vendorId?: unknown;
  vendorName?: unknown;
  partNumber?: unknown;
  productName?: unknown;
  cost?: unknown;
  retail?: unknown;
  msrp?: unknown;
  description?: unknown;
  vendorStyleId?: unknown;
  configuration?: unknown;
  departmentId?: unknown;
  categoryId?: unknown;
  typeId?: unknown;
  productWidth?: unknown;
  productLength?: unknown;
  productHeight?: unknown;
  stockProgram?: unknown;
  stockFamily?: unknown;
  draftPoId?: unknown;
  qty?: unknown;
  stockLocationId?: unknown;
  barcode?: unknown;
  source?: unknown;
  notes?: unknown;
  // Configurator-style structured fields (slice 4a, 2026-05-09)
  grade?: unknown;
  fabric?: unknown;
  finish?: unknown;
  cleaningCode?: unknown;
  options?: unknown;
  vignette?: unknown;
  // Upholstery vs Case Goods template selector + the additional fields
  // each template surfaces (slice 4-lite-v2, 2026-05-09).
  itemType?: unknown;
  cushions?: unknown;
  tossPillows?: unknown;
  hardware?: unknown;
  hardwareFinish?: unknown;
  // Slice 6.1 (2026-05-12) — barcode-lookup creates a draft FROM an
  // existing Product; link both records at create time so reports and
  // the display fallback can see the connection immediately.
  fulfilledProductId?: unknown;
  fulfilledAt?: unknown;
}

// ─── Cleaning-code preset list ────────────────────────────────────────
//
// Industry-standard upholstery cleaning codes. The wizard surfaces these
// as a dropdown but allows free text override (some vendors use vendor-
// specific codes like "ALW" or "K"). Per buyer feedback 2026-05-09:
// "I just don't know them — can we populate a dropdown based on the
// common codes?"
export const CLEANING_CODE_PRESETS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "W", label: "W — Water-based cleaner" },
  { code: "S", label: "S — Solvent-based cleaner only" },
  { code: "WS", label: "WS — Water OR solvent (most forgiving)" },
  { code: "SW", label: "SW — Solvent then water (alt notation)" },
  { code: "X", label: "X — Vacuum / brush only (no liquid)" },
  { code: "DS", label: "DS — Dry solvent (professional only)" },
];

/**
 * Assemble the structured fields into a description string in the format
 * the buyer's existing OTB workbook uses (e.g. "Fabric: Stetson Chestnut,
 * Grade: 13, Cushion: Mayfair, Cleaning Code: S, Dimensions: 30W x 39.5D
 * x 34H"). Used by the wizard on save when the buyer hasn't typed a
 * free-text override; also re-callable on edit.
 *
 * Fields with empty string / null values are skipped (no "Grade: " with
 * blank value). Dimensions are only included when at least one of W/L/H
 * is present.
 *
 * Pure — caller passes already-trimmed values.
 */
export interface AssembleDescriptionInput {
  /**
   * Selects the description template (UPHOLSTERY / CASE_GOODS / OTHER).
   * OTHER and undefined fall through to the legacy comma-joined order
   * (Fabric / Grade / Finish / Cleaning Code / Options + Dimensions) for
   * backwards-compat with drafts created before slice 4-lite-v2.
   */
  itemType?: BuyerDraftItemType | null;
  // Upholstery-specific
  fabric?: string | null;
  cushions?: string | null;
  cleaningCode?: string | null;
  tossPillows?: string | null;
  // Case-goods-specific
  hardware?: string | null;
  hardwareFinish?: string | null;
  // Shared
  grade?: string | null; // upholstery: Grade label; case goods: Wood Species label
  finish?: string | null;
  options?: string | null;
  productWidth?: DimensionValue;
  productLength?: DimensionValue;
  productHeight?: DimensionValue;
}

/** A single dimension input — accepts the multiple shapes Prisma + form data produce. */
type DimensionValue = number | string | null;

export function assembleDescription(parts: AssembleDescriptionInput): string {
  return assembleDescriptionSegments(parts).join(", ");
}

/**
 * Same content as `assembleDescription` but joined with newlines so each
 * field appears on its own line in the POS's product-card display. Used
 * by the items CSV export per buyer feedback 2026-05-09: *"we need the
 * descriptions to output the same and have the carriage returns in the
 * exports for imports."* The DB-stored description stays comma-joined to
 * mirror the existing configurator's output convention; only the export
 * substitutes newlines.
 */
export function assembleDescriptionForExport(parts: AssembleDescriptionInput): string {
  return assembleDescriptionSegments(parts).join("\n");
}

function assembleDescriptionSegments(parts: AssembleDescriptionInput): string[] {
  switch (parts.itemType) {
    case "UPHOLSTERY":
      return upholsterySegments(parts);
    case "CASE_GOODS":
      return caseGoodsSegments(parts);
    default:
      return otherSegments(parts);
  }
}

const trimStr = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");

/**
 * Buyer's spec 2026-05-09:
 *   Upholstery:
 *   Fabric: …
 *   Grade: …
 *   Finish: …
 *   Cushions: …
 *   Cleaning Code: …
 *   Dimensions: …
 *   Toss Pillows …
 *   Options: …
 */
function upholsterySegments(parts: AssembleDescriptionInput): string[] {
  const out: string[] = [];
  const push = (label: string, value: string | null | undefined) => {
    const v = trimStr(value);
    if (v) out.push(`${label}: ${v}`);
  };
  // Per buyer feedback 2026-05-09: don't emit the "Upholstery" header —
  // the field labels alone are enough; the header is redundant in
  // the POS's product card.
  push("Fabric", parts.fabric);
  push("Grade", parts.grade);
  push("Finish", parts.finish);
  push("Cushions", parts.cushions);
  push("Cleaning Code", parts.cleaningCode);
  const dim = formatDimensions(parts.productWidth, parts.productLength, parts.productHeight);
  if (dim) out.push(dim);
  push("Toss Pillows", parts.tossPillows);
  push("Options", parts.options);
  return out;
}

/**
 * Buyer's spec 2026-05-09:
 *   Case Goods:
 *   Wood Species: …
 *   Finish: …
 *   Hardware: …
 *   Hardware Finish: …
 *   Dimensions: …
 */
function caseGoodsSegments(parts: AssembleDescriptionInput): string[] {
  const out: string[] = [];
  const push = (label: string, value: string | null | undefined) => {
    const v = trimStr(value);
    if (v) out.push(`${label}: ${v}`);
  };
  // Per buyer feedback 2026-05-09: don't emit the "Case Goods" header —
  // the field labels alone are enough.
  push("Wood Species", parts.grade); // grade column carries the species value for case goods
  push("Finish", parts.finish);
  push("Hardware", parts.hardware);
  push("Hardware Finish", parts.hardwareFinish);
  const dim = formatDimensions(parts.productWidth, parts.productLength, parts.productHeight);
  if (dim) out.push(dim);
  push("Options", parts.options);
  return out;
}

/**
 * Legacy / OTHER: emit the same fields as before slice 4-lite-v2 so
 * existing drafts (where itemType=OTHER by default) render unchanged.
 */
function otherSegments(parts: AssembleDescriptionInput): string[] {
  const out: string[] = [];
  const push = (label: string, value: string | null | undefined) => {
    const v = trimStr(value);
    if (v) out.push(`${label}: ${v}`);
  };
  push("Fabric", parts.fabric);
  push("Grade", parts.grade);
  push("Finish", parts.finish);
  push("Cleaning Code", parts.cleaningCode);
  push("Options", parts.options);
  const dim = formatDimensions(parts.productWidth, parts.productLength, parts.productHeight);
  if (dim) out.push(dim);
  return out;
}

type DimensionInput = DimensionValue | undefined;

function formatDimensions(w: DimensionInput, l: DimensionInput, h: DimensionInput): string | null {
  const fmt = (v: DimensionInput): string | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    // Trim trailing zeros so 30.00 → "30", 39.5 → "39.5"
    return String(Number.parseFloat(n.toFixed(2)));
  };
  const wStr = fmt(w);
  const lStr = fmt(l);
  const hStr = fmt(h);
  if (!wStr && !lStr && !hStr) return null;
  // Mirror the buyer's existing convention: "30W x 39.5D x 34H"
  const tokens: string[] = [];
  if (wStr) tokens.push(`${wStr}W`);
  if (lStr) tokens.push(`${lStr}D`);
  if (hStr) tokens.push(`${hStr}H`);
  return `Dimensions: ${tokens.join(" x ")}`;
}

/**
 * Validate + coerce a POST body for `BuyerDraftItem.create`. Throws TypeError
 * with a human-readable message on any required-field violation; the handler
 * maps the throw to a 400 response.
 */
export function buildItemCreateData(
  body: BuyerDraftItemCreateBody,
  createdBy: string | null,
): Prisma.BuyerDraftItemUncheckedCreateInput {
  const vendorName = stringOrEmpty(body.vendorName);
  const partNumber = stringOrEmpty(body.partNumber);
  const productName = stringOrEmpty(body.productName);

  if (!vendorName) throw new TypeError("vendorName is required");
  if (!partNumber) throw new TypeError("partNumber is required");
  if (!productName) throw new TypeError("productName is required");

  return {
    vendorId: optionalInt(body.vendorId),
    vendorName,
    partNumber,
    productName,
    cost: new Prisma.Decimal(numberOrZero(body.cost)),
    retail: new Prisma.Decimal(numberOrZero(body.retail)),
    msrp: optionalDecimal(body.msrp),
    description: optionalString(body.description),
    vendorStyleId: optionalInt(body.vendorStyleId),
    configuration: optionalJson(body.configuration),
    departmentId: optionalInt(body.departmentId),
    categoryId: optionalInt(body.categoryId),
    typeId: optionalInt(body.typeId),
    productWidth: optionalDecimal(body.productWidth),
    productLength: optionalDecimal(body.productLength),
    productHeight: optionalDecimal(body.productHeight),
    stockProgram: Boolean(body.stockProgram),
    stockFamily: optionalString(body.stockFamily),
    draftPoId: optionalInt(body.draftPoId),
    qty: optionalInt(body.qty) ?? 1,
    stockLocationId: optionalInt(body.stockLocationId),
    barcode: optionalString(body.barcode),
    source: pickEnum(body.source, VALID_SOURCES, "MANUAL"),
    notes: optionalString(body.notes),
    grade: optionalString(body.grade),
    fabric: optionalString(body.fabric),
    finish: optionalString(body.finish),
    cleaningCode: optionalString(body.cleaningCode),
    options: optionalString(body.options),
    vignette: optionalString(body.vignette),
    itemType: pickEnum(body.itemType, VALID_ITEM_TYPES, "OTHER"),
    cushions: optionalString(body.cushions),
    tossPillows: optionalString(body.tossPillows),
    hardware: optionalString(body.hardware),
    hardwareFinish: optionalString(body.hardwareFinish),
    // Slice 6.1 — set the catalog link at create time when present
    // (barcode-lookup flow). Both fields go together: a link without a
    // timestamp is unfindable; a timestamp without a link is meaningless.
    fulfilledProductId: optionalInt(body.fulfilledProductId),
    fulfilledAt: optionalDate(body.fulfilledAt),
    createdBy,
  };
}

// ─── BuyerDraftItem update payload ────────────────────────────────────
//
// PATCH bodies are sparse — only the fields the client included in the
// request should be touched. Each apply* helper guards on `key in body`
// so absence is preserved; presence with a coerce-able value is applied;
// presence with a non-coerce-able value clears the field (FK→disconnect,
// nullable scalar→null) per the API contract.

export type BuyerDraftItemUpdateBody = Partial<BuyerDraftItemCreateBody> & {
  status?: unknown;
};

/** Apply FK fields (vendor / vendorStyle / dept / cat / type / draftPo / stockLocation). */
export function applyItemFkPatches(
  body: BuyerDraftItemUpdateBody,
  data: Prisma.BuyerDraftItemUpdateInput,
): void {
  if ("vendorId" in body) data.vendor = connectOrDisconnect(body.vendorId);
  if ("vendorStyleId" in body) data.vendorStyle = connectOrDisconnect(body.vendorStyleId);
  if ("departmentId" in body) data.department = connectOrDisconnect(body.departmentId);
  if ("categoryId" in body) data.category = connectOrDisconnect(body.categoryId);
  if ("typeId" in body) data.type = connectOrDisconnect(body.typeId);
  if ("draftPoId" in body) data.draftPo = connectOrDisconnect(body.draftPoId);
  if ("stockLocationId" in body) data.stockLocation = connectOrDisconnect(body.stockLocationId);
}

/** Apply free-text scalars (vendorName, partNumber, productName, etc.). */
export function applyItemTextPatches(
  body: BuyerDraftItemUpdateBody,
  data: Prisma.BuyerDraftItemUpdateInput,
): void {
  applyItemCoreTextPatches(body, data);
  applyItemConfiguratorTextPatches(body, data);
}

/** Required-text + free-text fields shared across all draft items. */
function applyItemCoreTextPatches(
  body: BuyerDraftItemUpdateBody,
  data: Prisma.BuyerDraftItemUpdateInput,
): void {
  if ("vendorName" in body && typeof body.vendorName === "string")
    data.vendorName = body.vendorName.trim();
  if ("partNumber" in body && typeof body.partNumber === "string")
    data.partNumber = body.partNumber.trim();
  if ("productName" in body && typeof body.productName === "string")
    data.productName = body.productName.trim();
  if ("description" in body) data.description = optionalString(body.description);
  if ("stockFamily" in body) data.stockFamily = optionalString(body.stockFamily);
  if ("barcode" in body) data.barcode = optionalString(body.barcode);
  if ("notes" in body) data.notes = optionalString(body.notes);
}

/** Configurator-style structured fields (slice 4a + 4-lite-v2) + vignette. */
function applyItemConfiguratorTextPatches(
  body: BuyerDraftItemUpdateBody,
  data: Prisma.BuyerDraftItemUpdateInput,
): void {
  if ("grade" in body) data.grade = optionalString(body.grade);
  if ("fabric" in body) data.fabric = optionalString(body.fabric);
  if ("finish" in body) data.finish = optionalString(body.finish);
  if ("cleaningCode" in body) data.cleaningCode = optionalString(body.cleaningCode);
  if ("options" in body) data.options = optionalString(body.options);
  if ("vignette" in body) data.vignette = optionalString(body.vignette);
  // Slice 4-lite-v2: upholstery + case-goods template fields
  if ("cushions" in body) data.cushions = optionalString(body.cushions);
  if ("tossPillows" in body) data.tossPillows = optionalString(body.tossPillows);
  if ("hardware" in body) data.hardware = optionalString(body.hardware);
  if ("hardwareFinish" in body) data.hardwareFinish = optionalString(body.hardwareFinish);
}

/** Apply numeric scalars (cost, retail, msrp, dimensions, qty). */
export function applyItemNumericPatches(
  body: BuyerDraftItemUpdateBody,
  data: Prisma.BuyerDraftItemUpdateInput,
): void {
  if ("cost" in body) data.cost = decimalOrThrow(body.cost, "cost");
  if ("retail" in body) data.retail = decimalOrThrow(body.retail, "retail");
  if ("msrp" in body) data.msrp = optionalDecimal(body.msrp);
  if ("productWidth" in body) data.productWidth = optionalDecimal(body.productWidth);
  if ("productLength" in body) data.productLength = optionalDecimal(body.productLength);
  if ("productHeight" in body) data.productHeight = optionalDecimal(body.productHeight);
  if ("qty" in body) data.qty = validatedQty(body.qty);
}

/** Apply boolean flag + JSON config blob. */
export function applyItemFlagPatches(
  body: BuyerDraftItemUpdateBody,
  data: Prisma.BuyerDraftItemUpdateInput,
): void {
  if ("stockProgram" in body) data.stockProgram = Boolean(body.stockProgram);
  if ("configuration" in body) data.configuration = optionalJson(body.configuration);
}

/** Apply enum-typed fields (status, source) — throws TypeError on invalid value. */
export function applyItemEnumPatches(
  body: BuyerDraftItemUpdateBody,
  data: Prisma.BuyerDraftItemUpdateInput,
): void {
  if ("status" in body) {
    const s = body.status;
    if (typeof s !== "string" || !(VALID_ITEM_STATUSES as readonly string[]).includes(s)) {
      throw new TypeError("Invalid status");
    }
    data.status = s as BuyerDraftItemStatus;
  }
  if ("source" in body) {
    const s = body.source;
    if (typeof s !== "string" || !(VALID_SOURCES as readonly string[]).includes(s)) {
      throw new TypeError("Invalid source");
    }
    data.source = s as BuyerDraftSource;
  }
  if ("itemType" in body) {
    const t = body.itemType;
    if (typeof t !== "string" || !(VALID_ITEM_TYPES as readonly string[]).includes(t)) {
      throw new TypeError("Invalid itemType");
    }
    data.itemType = t as BuyerDraftItemType;
  }
}

/**
 * Aggregate every patch helper. Throws TypeError on any required-field or
 * enum-validation violation. Result is a Prisma update payload ready to
 * pass straight to `prisma.buyerDraftItem.update({ where, data })`.
 */
export function buildItemUpdateData(
  body: BuyerDraftItemUpdateBody,
  updatedBy: string | null,
): Prisma.BuyerDraftItemUpdateInput {
  const data: Prisma.BuyerDraftItemUpdateInput = {};
  applyItemFkPatches(body, data);
  applyItemTextPatches(body, data);
  applyItemNumericPatches(body, data);
  applyItemFlagPatches(body, data);
  applyItemEnumPatches(body, data);
  data.updatedBy = updatedBy;
  return data;
}

// ─── BuyerDraftPurchaseOrder create + update payloads ─────────────────

export interface BuyerDraftPoCreateBody {
  vendorId?: unknown;
  vendorName?: unknown;
  referenceNumber?: unknown;
  expectedShipMonth?: unknown;
  expectedDeliveryDate?: unknown;
  storeLocationId?: unknown;
  notes?: unknown;
  buyId?: unknown; // 2026-05-09: optional Buy parent
}

export type BuyerDraftPoUpdateBody = Partial<BuyerDraftPoCreateBody> & { status?: unknown };

export function buildPoCreateData(
  body: BuyerDraftPoCreateBody,
  createdBy: string | null,
): Prisma.BuyerDraftPurchaseOrderUncheckedCreateInput {
  const vendorName = stringOrEmpty(body.vendorName);
  if (!vendorName) throw new TypeError("vendorName is required");

  return {
    vendorId: optionalInt(body.vendorId),
    vendorName,
    referenceNumber: optionalString(body.referenceNumber),
    expectedShipMonth: coerceShipMonthInput(body.expectedShipMonth),
    expectedDeliveryDate: optionalDate(body.expectedDeliveryDate),
    storeLocationId: optionalInt(body.storeLocationId),
    notes: optionalString(body.notes),
    buyId: optionalInt(body.buyId),
    createdBy,
  };
}

export function buildPoUpdateData(
  body: BuyerDraftPoUpdateBody,
  updatedBy: string | null,
): Prisma.BuyerDraftPurchaseOrderUpdateInput {
  const data: Prisma.BuyerDraftPurchaseOrderUpdateInput = {};

  if ("vendorId" in body) data.vendor = connectOrDisconnect(body.vendorId);
  if ("storeLocationId" in body) data.storeLocation = connectOrDisconnect(body.storeLocationId);
  if ("buyId" in body) data.buy = connectOrDisconnect(body.buyId);

  if ("vendorName" in body && typeof body.vendorName === "string")
    data.vendorName = body.vendorName.trim();
  if ("referenceNumber" in body) data.referenceNumber = optionalString(body.referenceNumber);
  if ("expectedShipMonth" in body)
    data.expectedShipMonth = coerceShipMonthInput(body.expectedShipMonth);
  if ("expectedDeliveryDate" in body)
    data.expectedDeliveryDate = optionalDate(body.expectedDeliveryDate);
  if ("notes" in body) data.notes = optionalString(body.notes);

  if ("status" in body) {
    const s = body.status;
    if (typeof s !== "string" || !(VALID_PO_STATUSES as readonly string[]).includes(s)) {
      throw new TypeError("Invalid status");
    }
    data.status = s as BuyerDraftPoStatus;
  }

  data.updatedBy = updatedBy;
  return data;
}

// ─── BuyerDraftBuy CRUD payloads (slice 4-buys, 2026-05-09) ────────────

export interface BuyerDraftBuyCreateBody {
  name?: unknown;
  season?: unknown;
  year?: unknown;
  budget?: unknown;
  status?: unknown;
  kickoff?: unknown;
  closedAt?: unknown;
  notes?: unknown;
}

export type BuyerDraftBuyUpdateBody = Partial<BuyerDraftBuyCreateBody>;

/**
 * Validate + coerce a POST body for `BuyerDraftBuy.create`. Throws
 * TypeError on missing required fields (name) or invalid status; the
 * handler maps the throw to a 400.
 */
export function buildBuyCreateData(
  body: BuyerDraftBuyCreateBody,
  createdBy: string | null,
): Prisma.BuyerDraftBuyUncheckedCreateInput {
  const name = stringOrEmpty(body.name);
  if (!name) throw new TypeError("name is required");

  return {
    name,
    season: optionalString(body.season),
    year: optionalInt(body.year),
    budget: optionalDecimal(body.budget),
    status: pickEnum(body.status, VALID_BUY_STATUSES, "PLANNING"),
    kickoff: optionalDate(body.kickoff),
    closedAt: optionalDate(body.closedAt),
    notes: optionalString(body.notes),
    createdBy,
  };
}

/** Sparse-patch update — only keys present in body are touched. */
export function buildBuyUpdateData(
  body: BuyerDraftBuyUpdateBody,
  updatedBy: string | null,
): Prisma.BuyerDraftBuyUpdateInput {
  const data: Prisma.BuyerDraftBuyUpdateInput = {};

  if ("name" in body && typeof body.name === "string") data.name = body.name.trim();
  if ("season" in body) data.season = optionalString(body.season);
  if ("year" in body) data.year = optionalInt(body.year);
  if ("budget" in body) data.budget = optionalDecimal(body.budget);
  if ("kickoff" in body) data.kickoff = optionalDate(body.kickoff);
  if ("closedAt" in body) data.closedAt = optionalDate(body.closedAt);
  if ("notes" in body) data.notes = optionalString(body.notes);

  if ("status" in body) {
    const s = body.status;
    if (typeof s !== "string" || !(VALID_BUY_STATUSES as readonly string[]).includes(s)) {
      throw new TypeError("Invalid status");
    }
    data.status = s as BuyerDraftBuyStatus;
  }

  data.updatedBy = updatedBy;
  return data;
}
