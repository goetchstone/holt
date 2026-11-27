// /app/src/lib/purchasing/purchaseOrderShared.ts
//
// GAP-01: a purchase order a buyer writes by hand -- what the editor sends,
// how it is checked, and when a PO can still be changed. Shared by the PO
// editor and the server (lib/purchasing/stockPurchaseOrder.ts), so both read
// one set of rules. Client-safe: no Prisma here.

/** A PO can be changed in these statuses, until anything is received on it. */
export const EDITABLE_PO_STATUSES: readonly string[] = ["DRAFT", "SUBMITTED", "CONFIRMED"];

/** A line as the editor sends it. `id` is set on a line the PO already has. */
export interface PoLineInput {
  id?: number;
  productId: number;
  quantity: number;
  /** Omitted (or null) keeps the line's cost, or takes the product's for a new line. */
  unitCost?: number | null;
}

/** What the editor saves: everything about a PO but its vendor. */
export interface PoDraftInput {
  /** The store or warehouse the vendor delivers to; null when it goes to the customer. */
  shipToLocationId: number | null;
  /** Ship straight to the customer (GAP-20). The server works out the address. */
  dropShip: boolean;
  /** YYYY-MM-DD, or null when the vendor hasn't given one. */
  expectedDelivery: string | null;
  notes: string | null;
  lines: PoLineInput[];
}

export interface NewPoInput extends Omit<PoDraftInput, "shipToLocationId" | "dropShip"> {
  vendorId: number;
  shipToLocationId: number;
}

export const MAX_PO_NOTES = 2000;

/**
 * A product the editor's picker offers for a PO's vendor (GET
 * /api/purchasing/vendor-products): one of that vendor's own, or one it sells
 * us besides (GAP-22, buyingTerms in productSourcesShared.ts).
 */
export interface VendorProductHit {
  id: number;
  name: string;
  /** The item's own number, as the catalog knows it. */
  productNumber: string;
  /** The number this vendor knows it by, which the PO line prints. */
  partNo: string;
  /** What it costs from this vendor, for a holder of "View cost". */
  cost?: number | null;
}

export interface VendorProductsResponse {
  costVisible: boolean;
  products: VendorProductHit[];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

/**
 * Why a PO can't be changed, or null when it can. Once anything has arrived the
 * lines are what was received against; a vendor return is written by the
 * returns flow, not here.
 */
export function poEditProblem(po: {
  status: string;
  isReturn: boolean;
  receivedCount: number;
}): string | null {
  if (po.isReturn) return "A vendor return can't be changed here.";
  if (po.receivedCount > 0) {
    return "This PO can't be changed: goods have been received against it.";
  }
  if (!EDITABLE_PO_STATUSES.includes(po.status)) {
    return "This PO is closed and can't be changed.";
  }
  return null;
}

/**
 * Why importing a vendor's document again can't replace this PO's lines, or
 * null when it can. Replaceable means a PO such an import could have written
 * and nothing has been built on: the document's own vendor, still changeable
 * (poEditProblem), and not raised for a customer's sale or a consignment
 * payment, whose lines come from there and not from a document. It lists what
 * is allowed, so a PO in a state nobody thought of is refused, not replaced.
 */
export function poReplaceProblem(
  po: {
    poNumber: string;
    vendorId: number;
    vendorName: string;
    status: string;
    isReturn: boolean;
    receivedCount: number;
    /** The PO's own sale, a drop-ship address, or any line ordered for a sale's line. */
    forSale: boolean;
    forConsignmentPayment: boolean;
  },
  importVendor: { id: number; name: string },
): string | null {
  const refused = `PO ${po.poNumber} was not replaced, and nothing was changed`;
  if (po.vendorId !== importVendor.id) {
    return `${refused}: that number belongs to a ${po.vendorName} PO, and this document is from ${importVendor.name}.`;
  }
  const edit = poEditProblem(po);
  if (edit) return `${refused}. ${edit}`;
  if (po.forSale) {
    return `${refused}: it was raised for a customer's sale, and importing over it would unlink that sale. Change it on the PO itself.`;
  }
  if (po.forConsignmentPayment) {
    return `${refused}: it belongs to a consignment payment.`;
  }
  return null;
}

const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

function parseLine(raw: unknown, n: number): Parsed<PoLineInput> {
  const line = (raw ?? {}) as Record<string, unknown>;
  if (line.id !== undefined && !isId(line.id)) {
    return { ok: false, problem: `Line ${n}: not a line on this PO.` };
  }
  if (!isId(line.productId)) return { ok: false, problem: `Line ${n}: choose a product.` };
  const { quantity, unitCost } = line;
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, problem: `Line ${n}: the quantity must be more than 0.` };
  }
  if (
    unitCost !== undefined &&
    unitCost !== null &&
    (typeof unitCost !== "number" || !Number.isFinite(unitCost) || unitCost < 0)
  ) {
    return { ok: false, problem: `Line ${n}: the unit cost can't be negative.` };
  }
  return {
    ok: true,
    value: {
      ...(line.id === undefined ? {} : { id: line.id as number }),
      productId: line.productId,
      quantity,
      unitCost: (unitCost as number | null | undefined) ?? null,
    },
  };
}

function parseDate(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, problem: "The expected date must be a date." };
  }
  if (Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime())) {
    return { ok: false, problem: "The expected date must be a date." };
  }
  return { ok: true, value: raw };
}

/** Read the editor's body: ship-to, expected date, notes and at least one line. */
export function parsePoDraft(body: unknown): Parsed<PoDraftInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const dropShip = b.dropShip === true;
  const shipToLocationId = isId(b.shipToLocationId) ? b.shipToLocationId : null;
  if (!dropShip && shipToLocationId === null) {
    return { ok: false, problem: "Choose where the vendor delivers." };
  }
  const date = parseDate(b.expectedDelivery);
  if (!date.ok) return date;
  if (b.notes !== undefined && b.notes !== null && typeof b.notes !== "string") {
    return { ok: false, problem: "Notes must be text." };
  }
  const notes = typeof b.notes === "string" ? b.notes.trim() : "";
  if (notes.length > MAX_PO_NOTES) {
    return { ok: false, problem: `Notes can be at most ${MAX_PO_NOTES} characters.` };
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    return { ok: false, problem: "Add at least one line." };
  }
  const lines: PoLineInput[] = [];
  for (const [i, raw] of b.lines.entries()) {
    const line = parseLine(raw, i + 1);
    if (!line.ok) return line;
    lines.push(line.value);
  }
  return {
    ok: true,
    value: {
      shipToLocationId: dropShip ? null : shipToLocationId,
      dropShip,
      expectedDelivery: date.value,
      notes: notes || null,
      lines,
    },
  };
}

/** Read a new PO: the editor's body plus its vendor. */
export function parseNewPo(body: unknown): Parsed<NewPoInput> {
  const vendorId = ((body ?? {}) as Record<string, unknown>).vendorId;
  if (!isId(vendorId)) return { ok: false, problem: "Choose a vendor." };
  const draft = parsePoDraft(body);
  if (!draft.ok) return draft;
  const { dropShip, shipToLocationId, ...rest } = draft.value;
  if (dropShip || shipToLocationId === null) {
    return {
      ok: false,
      problem: "A new PO goes to a store. To ship to a customer, use the PO raised for their sale.",
    };
  }
  return { ok: true, value: { ...rest, vendorId, shipToLocationId } };
}

/** A line's cost: quantity times unit cost, to the cent. */
export function poLineTotal(quantity: number, unitCost: number): number {
  return Math.round(quantity * unitCost * 100) / 100;
}

// The handheld's scanned reorder (GAP-19, lib/purchasing/scannedOrder.ts).

export interface ScannedLine {
  productId: number;
  vendorId: number;
  quantity: number;
}

/** A draft a save filed lines on. */
export interface FiledPo {
  id: number;
  poNumber: string;
  vendor: string;
  /** Lines added or added to. */
  lines: number;
  created: boolean;
}

/** A scanned item and the vendors it can be ordered from, its own first. */
export interface OrderableItem {
  product: { id: number; name: string; productNumber: string };
  vendors: { id: number; name: string; partNo: string }[];
}
