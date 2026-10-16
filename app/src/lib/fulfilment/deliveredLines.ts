// /app/src/lib/fulfilment/deliveredLines.ts
//
// The driver's delivered counts (ledger plan phase 20), pure so the driver
// screen and its test share them. A stop's goods are the order's open product
// lines: active, with a product, and not yet all delivered. What the driver
// sends is one count per open line; anything less than open is a part
// delivery (lib/fulfilment/handover.ts recordDelivery).

export interface StopLine {
  id: number;
  productId: number | null;
  productName: string | null;
  orderedQuantity: number | string;
  fulfilledQty?: number | string | null;
  lineItemStatus?: string | null;
}

export interface OpenLine {
  id: number;
  name: string;
  open: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function openStopLines(lines: StopLine[]): OpenLine[] {
  return lines
    .filter((l) => l.productId != null && (l.lineItemStatus ?? "ACTIVE") === "ACTIVE")
    .map((l) => ({
      id: l.id,
      name: l.productName || "Unnamed item",
      open: round(Number(l.orderedQuantity) - Number(l.fulfilledQty ?? 0)),
    }))
    .filter((l) => l.open > 0);
}

/** One count per open line, each held to 0..open; a missing count is all of it. */
export function deliveredPayload(
  open: OpenLine[],
  counts: Record<number, number>,
): { orderLineItemId: number; quantity: number }[] {
  return open.map((l) => {
    const c = counts[l.id];
    const q = c === undefined || !Number.isFinite(c) ? l.open : Math.min(l.open, Math.max(0, c));
    return { orderLineItemId: l.id, quantity: round(q) };
  });
}

export function isPartDelivery(open: OpenLine[], counts: Record<number, number>): boolean {
  return deliveredPayload(open, counts).some((d, i) => d.quantity < open[i].open);
}
