// /app/src/lib/pricing/wendoverOrderParser.ts
//
// Server-only parser for Wendover Art Group order-confirmation emails,
// saved to PDF by the buyer (the vendor sends no attachment, so the
// document is Gmail's print-to-PDF of the confirmation).
//
// One PDF = ONE order. Each item is a labelled block:
//
//   Before the Rain  Customized        <- product name (may carry a suffix)
//   SKU: WLD3511                       <- vendor SKU
//   Medium
//   Canvas
//   Treatment
//   Gallery Wrapped, Artist Enhanced
//   Size
//   35.01"w x 41.01"h
//   Frame
//   M1123, Antique Silver, 0.38"w x 2.13"d
//   3$1,057.62                         <- qty + LINE TOTAL (not unit price)
//
// Two traps this parser exists to handle, both verified against the real
// 18-item order (#1000292821, 2026-07-13):
//
// 1. The "Price" column is the LINE TOTAL, not the unit price. Summing the
//    printed prices reproduces the printed Subtotal ($10,976.49) to the
//    penny, whereas qty x price would total $32,108.67. The catalog agrees
//    independently: Wendover's costs top out at $650, so the $1,188.57 and
//    $1,057.62 figures are impossible as unit costs, while every derived
//    unit price lands inside the vendor's real range. Ordorite's PO import
//    wants a UNIT cost, so unitPrice = lineTotal / qty is derived here.
//
// 2. A page break can emit an item's qty+price BEFORE its own "SKU:" line,
//    trailing the item's name ("Patterned Dignity 4 3$745.20"). Pairing is
//    therefore positional with a one-slot carry, NOT "the next price after
//    a SKU". Note the subtotal check CANNOT catch a mis-pairing -- a sum is
//    order-independent -- so the pairing rule has to be structurally right
//    on its own, and every item is asserted to have received exactly one
//    price.

const pdfParse = require("pdf-parse");

export interface WendoverOrderItem {
  sku: string;
  name: string;
  /** Printed line total, verbatim. Kept so the preview can show what the
   *  document said next to the unit cost we derived from it. */
  lineTotal: number;
  /** lineTotal / qty -- what Ordorite's PO import calls Cost Price. */
  unitPrice: number;
  qty: number;
  medium: string;
  treatment: string;
  size: string;
  frame: string;
  /** Customer reference printed on made-to-order pieces ("SBOM41649/Erin
   *  Kelly") -- the item is already sold, not stock. */
  sideMark: string;
  extras: string[];
}

export interface WendoverOrder {
  vendorName: string;
  orderNumber: string;
  orderDate: string;
  printedSubtotal: number;
  items: WendoverOrderItem[];
  warnings: string[];
}

export const WENDOVER_VENDOR_NAME = "Wendover Art Group";

const ORDER_NUMBER = /^Your Order #(\S+)/;
const PLACED_ON = /^Placed on\s+(.+?)\s*$/;
const SUBTOTAL = /^Subtotal\s+\$([\d,]+\.\d{2})/;
const SKU_LINE = /^SKU:\s*(\S+)$/;

// Qty and price render concatenated ("3$1,057.62"), optionally trailing the
// next item's name. The qty must be whitespace-separated from any lead text
// so a name ending in digits can never be split into a quantity: refusing to
// parse is correct there, and the missing-price check below reports it.
const TRAILING_QTY_PRICE = /^(?:(.*?)\s+)?(\d{1,3})\$([\d,]+\.\d{2})$/;

// Gmail's print-to-PDF furniture, repeated on every page. Dropped before
// parsing so it can never be read as a label's value.
const PAGE_FURNITURE = [
  /^\d{1,2}\/\d{1,2}\/\d{2},\s*\d{1,2}:\d{2}\s*[AP]M/,
  /^Page \d+ of \d+/,
  /^https?:\/\//,
];

// Explicit whitelist, NOT a title-case heuristic: several VALUES are short
// title-case lines that look exactly like labels ("Canvas", "Matte Paper",
// "Raw Canvas"), so a heuristic would read them as labels and swallow the
// following line. Every label here is verified in the real order except
// "Liner", which is verified in the catalog's own Wendover descriptions.
const LABELS: Readonly<Record<string, keyof WendoverOrderItem | "extra">> = {
  Medium: "medium",
  Treatment: "treatment",
  Size: "size",
  Frame: "frame",
  "Side Mark": "sideMark",
  "Bottom Mat": "extra",
  Liner: "extra",
};

function parseMoney(raw: string): number {
  return Number.parseFloat(raw.replaceAll(",", ""));
}

/**
 * Collapse the whitespace an HTML-to-PDF print leaves behind. This document
 * is a Gmail print of an HTML email, so it is full of non-breaking spaces —
 * the order number really renders as "Your Order\u00a0#1000292821", which no
 * pattern written with an ordinary space will ever match. Runs of spaces
 * (e.g. "Before the Rain  Customized") are rendering artifacts too, so they
 * collapse to one.
 */
function normalizeSpaces(line: string): string {
  return line
    .replaceAll(/[\u00a0\u2007\u202f\u2009\u200a]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function isFurniture(line: string): boolean {
  return PAGE_FURNITURE.some((re) => re.test(line));
}

function newItem(sku: string, name: string): WendoverOrderItem {
  return {
    sku,
    name,
    lineTotal: 0,
    unitPrice: 0,
    qty: 0,
    medium: "",
    treatment: "",
    size: "",
    frame: "",
    sideMark: "",
    extras: [],
  };
}

interface PendingPrice {
  qty: number;
  lineTotal: number;
}

/** Unit cost from the printed line total. Worked in whole cents; a total
 *  that does not divide evenly by the quantity is reported rather than
 *  silently rounded, because the rounded unit x qty would no longer equal
 *  what the vendor is charging. */
function unitFromLineTotal(
  lineTotal: number,
  qty: number,
  sku: string,
  warnings: string[],
): number {
  if (qty <= 0) return 0;
  const totalCents = Math.round(lineTotal * 100);
  const unitCents = Math.round(totalCents / qty);
  if (unitCents * qty !== totalCents) {
    warnings.push(
      `Item ${sku}: line total ${lineTotal.toFixed(2)} does not divide evenly by qty ${qty} — ` +
        `unit cost rounded to ${(unitCents / 100).toFixed(2)}, which re-multiplies to ` +
        `${((unitCents * qty) / 100).toFixed(2)}. Check the cost before importing.`,
    );
  }
  return unitCents / 100;
}

function applyPrice(item: WendoverOrderItem, price: PendingPrice, warnings: string[]): void {
  item.qty = price.qty;
  item.lineTotal = price.lineTotal;
  item.unitPrice = unitFromLineTotal(price.lineTotal, price.qty, item.sku, warnings);
}

function assignLabel(item: WendoverOrderItem, label: string, value: string): void {
  const field = LABELS[label];
  if (field === "extra") {
    item.extras.push(`${label}: ${value}`);
    return;
  }
  if (field) (item[field] as string) = value;
}

/** Refuse-to-guess reconciliation against the printed Subtotal. This
 *  verifies the AMOUNTS were read correctly; it says nothing about whether
 *  each price landed on the right item (a sum is order-independent), which
 *  is why pairing carries its own structural rule and per-item check. */
function reconcile(order: WendoverOrder): void {
  // Fail LOUD, not open. No subtotal means the totals block never appeared —
  // the likeliest cause is a truncated document (Gmail clips long messages,
  // and a clipped confirmation prints without its tail), which also means
  // items are missing. Returning quietly here would emit a short PO with a
  // full set of green checks: the one input class this guard exists for is
  // the one it would silently pass.
  if (order.printedSubtotal <= 0) {
    order.warnings.push(
      `Order ${order.orderNumber || "(unknown)"}: no printed subtotal was found, so the line ` +
        "totals could not be checked. The document may be cut short — confirm every item is " +
        "present before importing.",
    );
    return;
  }
  const calculated = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  if (Math.abs(calculated - order.printedSubtotal) > 0.01) {
    order.warnings.push(
      `Order ${order.orderNumber}: line totals sum to ${calculated.toFixed(2)}, which does not ` +
        `match the printed subtotal ${order.printedSubtotal.toFixed(2)}.`,
    );
  }
}

/** Mutable cursor state while scanning the item blocks. Mirrors the
 *  ScanState shape in kkOrderParser.ts -- one small handler per line kind,
 *  so the main loop stays a flat dispatch. */
interface ScanState {
  current: WendoverOrderItem | null;
  pendingPrice: PendingPrice | null;
  pendingLabel: string | null;
  /** The item name prints on the line BEFORE its "SKU:", so it is held here
   *  until the SKU tells us a new item has started. */
  lastText: string;
}

/** Order-level header fields. Returns true when the line was consumed. */
function consumeHeader(line: string, order: WendoverOrder): boolean {
  if (!order.orderNumber) {
    const m = ORDER_NUMBER.exec(line);
    if (m) {
      order.orderNumber = m[1].replace(/^#/, "");
      return true;
    }
  }
  if (!order.orderDate) {
    const m = PLACED_ON.exec(line);
    if (m) {
      order.orderDate = m[1];
      return true;
    }
  }
  return false;
}

function consumeSku(sku: string, scan: ScanState, order: WendoverOrder, warnings: string[]): void {
  const item = newItem(sku, scan.lastText);
  order.items.push(item);
  scan.current = item;
  // A price already seen belongs to THIS item: a page break printed it
  // ahead of the SKU line.
  if (scan.pendingPrice) {
    applyPrice(item, scan.pendingPrice, warnings);
    scan.pendingPrice = null;
  }
  scan.lastText = "";
  scan.pendingLabel = null;
}

function consumePrice(match: RegExpExecArray, scan: ScanState, warnings: string[]): void {
  const [, lead, qtyRaw, priceRaw] = match;
  // Lead text on a price line is the NEXT item's name -- a page break split
  // that item's block, putting its name and price ahead of its own SKU.
  if (lead?.trim()) scan.lastText = lead.trim();

  const price: PendingPrice = {
    qty: Number.parseInt(qtyRaw, 10),
    lineTotal: parseMoney(priceRaw),
  };
  if (scan.current?.qty === 0) {
    applyPrice(scan.current, price, warnings);
  } else if (scan.pendingPrice) {
    warnings.push(
      `A price (${price.qty} x ${price.lineTotal.toFixed(2)}) was found with no item to ` +
        "attach it to — skipped.",
    );
  } else {
    scan.pendingPrice = price;
  }
  scan.pendingLabel = null;
}

/** A label line arms the next line as its value; anything else is either
 *  that value or a name candidate for the next SKU. */
function consumeLabelOrText(line: string, scan: ScanState): void {
  if (LABELS[line] !== undefined) {
    scan.pendingLabel = line;
    return;
  }
  if (scan.pendingLabel && scan.current) {
    assignLabel(scan.current, scan.pendingLabel, line);
    scan.pendingLabel = null;
    return;
  }
  scan.lastText = line;
}

function checkItems(order: WendoverOrder, scan: ScanState, warnings: string[]): void {
  if (scan.pendingPrice) {
    warnings.push(
      `A price (${scan.pendingPrice.qty} x ${scan.pendingPrice.lineTotal.toFixed(2)}) was left ` +
        "over with no item to attach it to.",
    );
  }
  for (const item of order.items) {
    if (item.qty === 0) {
      warnings.push(`Item ${item.sku}: no quantity or price was found — check the PDF.`);
    }
    if (!item.name) {
      warnings.push(`Item ${item.sku}: no product name was found above its SKU.`);
    }
  }
}

export function parseWendoverOrderText(text: string): WendoverOrder {
  const warnings: string[] = [];
  const order: WendoverOrder = {
    vendorName: WENDOVER_VENDOR_NAME,
    orderNumber: "",
    orderDate: "",
    printedSubtotal: 0,
    items: [],
    warnings,
  };

  const lines = text
    .split("\n")
    .map(normalizeSpaces)
    .filter((l) => l !== "" && !isFurniture(l));

  const scan: ScanState = { current: null, pendingPrice: null, pendingLabel: null, lastText: "" };

  for (const line of lines) {
    if (consumeHeader(line, order)) continue;

    const subtotal = SUBTOTAL.exec(line);
    if (subtotal) {
      order.printedSubtotal = parseMoney(subtotal[1]);
      break; // Items end at the totals block.
    }

    const skuMatch = SKU_LINE.exec(line);
    if (skuMatch) {
      consumeSku(skuMatch[1], scan, order, warnings);
      continue;
    }

    const priceMatch = TRAILING_QTY_PRICE.exec(line);
    if (priceMatch) {
      consumePrice(priceMatch, scan, warnings);
      continue;
    }

    consumeLabelOrText(line, scan);
  }

  checkItems(order, scan, warnings);
  reconcile(order);
  return order;
}

export async function parseWendoverOrderPDF(buffer: Buffer): Promise<WendoverOrder> {
  const data = await pdfParse(buffer);
  return parseWendoverOrderText(data.text);
}
