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
  shipToLocationId: number;
  /** YYYY-MM-DD, or null when the vendor hasn't given one. */
  expectedDelivery: string | null;
  notes: string | null;
  lines: PoLineInput[];
}

export interface NewPoInput extends PoDraftInput {
  vendorId: number;
}

export const MAX_PO_NOTES = 2000;

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
  if (!isId(b.shipToLocationId)) {
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
      shipToLocationId: b.shipToLocationId,
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
  return { ok: true, value: { ...draft.value, vendorId } };
}

/** A line's cost: quantity times unit cost, to the cent. */
export function poLineTotal(quantity: number, unitCost: number): number {
  return Math.round(quantity * unitCost * 100) / 100;
}
