// /app/src/lib/pricing/simblistCsvOrderParser.ts
//
// Parser for Simblist Group order-export CSVs. Maison Zoe Ford writes orders
// through this rep group (owner 2026-07-17), and the CSV carries the actual
// manufacturer in a column, so one parser serves every brand Simblist reps.
//
// The file is two stacked tables: an order-header row + its value row, then an
// item-header row + one row per item. Columns are read by NAME (not position)
// so a reordered export still parses.
//
//   RepGroup,Manufacturer,PO #,Order Date,...,Order Total,...
//   Simblist Group,MAISON ZOE FORD,PON00001,2027-01-15,...,615.60,...
//   Sequence #,Item Number,Name,Description,Quantity,Unit Price,...,UPC,...,Total Price
//   3,SAMPLE03-C,Sample Gourmet Mix - case pack of 6,,2,48.00,...,00012345678905,...,$96.00
//
// Verified against a real order (PO number, item and prices invented):
//
// 1. qty x Unit Price == Total Price on every line (2 x 48.00 == 96.00).
// 2. The UPCs are real 14-digit manufacturer codes, so new items carry them.
// 3. The line Total Prices sum to $684.00 but the header Order Total is $615.60
//    (10% less) -- an order-level discount that is NOT in the unit prices. It is
//    surfaced as a warning, never applied (same doctrine as SuperCat).
//
// A cell it cannot read is never imported as $0 (2026-11-21). A Quantity that is
// not a whole number, or a Unit or Total Price that is not a finite number
// ("Infinity", "1e999", a 400-digit run), leaves its line out with a warning that
// names the item and the cell. Until then such a price read as 0, and 0 x qty = 0
// passed the line check, so the item was imported at $0 and nothing named it. A
// BLANK Unit or Total Price still reads as $0, as it always has; whether a blank
// should be left out too is the owner's open question. This parser reads cells,
// not lines, so it never calls parseBoundary's splitLines: Papa is linear, and a
// cell can spell an overflow as "1e999", which a digit-run check cannot see.

import Papa from "papaparse";
import { finiteOrNull } from "./parseBoundary";

export interface SimblistItem {
  itemNumber: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  upc: string;
  listPrice: number | null;
  notes: string;
}

export interface SimblistOrder {
  vendorName: string;
  repGroup: string;
  poNumber: string;
  orderDate: string;
  shipDate: string;
  printedTotal: number;
  items: SimblistItem[];
  warnings: string[];
}

/** A money cell: null when it is blank or is not a finite number. */
function readMoney(raw: string): number | null {
  if (!raw) return null;
  return finiteOrNull(raw.replaceAll(/[$,]/g, "").trim());
}

/** A Quantity cell: a whole number of up to nine digits, else null. */
function readQuantity(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

/** `raw` cut to 20 characters, so a 400-digit cell does not swamp its warning. */
function clip(raw: string): string {
  return raw.length > 20 ? `${raw.slice(0, 20)}…` : raw;
}

/** Column-name -> index map from a header row, lower-cased and trimmed. */
function headerIndex(row: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  row.forEach((h, i) => map.set(h.trim().toLowerCase(), i));
  return map;
}

function cell(row: readonly string[], idx: Map<string, number>, name: string): string {
  const i = idx.get(name.toLowerCase());
  return i === undefined ? "" : (row[i] ?? "").trim();
}

const ITEM_HEADER_KEY = "item number";

/** One item row, or null with a warning naming it when its line is left out. */
function readItem(
  row: readonly string[],
  idx: Map<string, number>,
  itemNumber: string,
  warnings: string[],
): SimblistItem | null {
  const qtyRaw = cell(row, idx, "Quantity");
  const priceRaw = cell(row, idx, "Unit Price");
  const totalRaw = cell(row, idx, "Total Price");
  const qty = readQuantity(qtyRaw);
  // A blank price is $0, as it always was; anything else must read as a number.
  const unitPrice = priceRaw === "" ? 0 : readMoney(priceRaw);
  const lineTotal = totalRaw === "" ? 0 : readMoney(totalRaw);
  const unread = (column: string, raw: string) =>
    warnings.push(
      `Item ${itemNumber}: the ${column} "${clip(raw)}" is not a number, so the line was ` +
        "left out — add it by hand.",
    );
  if (qty === null) unread("Quantity", qtyRaw);
  else if (unitPrice === null) unread("Unit Price", priceRaw);
  else if (lineTotal === null) unread("Total Price", totalRaw);
  if (qty === null || unitPrice === null || lineTotal === null) return null;

  if (qty <= 0 || Math.abs(unitPrice * qty - lineTotal) > 0.01) {
    warnings.push(
      `Item ${itemNumber}: ${qty} x ${unitPrice.toFixed(2)} does not equal the line total ` +
        `${lineTotal.toFixed(2)} — check it before importing.`,
    );
    return null;
  }
  return {
    itemNumber,
    name: cell(row, idx, "Name"),
    qty,
    unitPrice,
    lineTotal,
    upc: cell(row, idx, "UPC"),
    // Null when blank or unreadable; nothing downstream reads it.
    listPrice: readMoney(cell(row, idx, "List Price")),
    notes: cell(row, idx, "Notes"),
  };
}

export function parseSimblistCsvText(text: string): SimblistOrder {
  const warnings: string[] = [];
  const order: SimblistOrder = {
    vendorName: "",
    repGroup: "",
    poNumber: "",
    orderDate: "",
    shipDate: "",
    printedTotal: 0,
    items: [],
    warnings,
  };

  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const rows = parsed.data.filter((r) => Array.isArray(r) && r.some((c) => c && c.trim() !== ""));

  // The item table begins at the row whose header carries "Item Number".
  const itemHeaderRow = rows.findIndex((r) => headerIndex(r).has(ITEM_HEADER_KEY));
  if (itemHeaderRow < 1) {
    warnings.push("Could not find the item table in the CSV (no 'Item Number' header row).");
    return order;
  }

  // The order header is the first row; its values are the row directly under it.
  const orderIdx = headerIndex(rows[0]);
  const orderValues = rows[1] ?? [];
  order.repGroup = cell(orderValues, orderIdx, "RepGroup");
  order.vendorName = cell(orderValues, orderIdx, "Manufacturer");
  order.poNumber = cell(orderValues, orderIdx, "PO #");
  order.orderDate = cell(orderValues, orderIdx, "Order Date");
  order.shipDate = cell(orderValues, orderIdx, "Ship Date");
  const totalRaw = cell(orderValues, orderIdx, "Order Total");
  const printedTotal = readMoney(totalRaw);
  order.printedTotal = printedTotal ?? 0;
  if (totalRaw && printedTotal === null) {
    warnings.push(
      `The Order Total "${clip(totalRaw)}" is not a number, so the line totals were not ` +
        "checked against it.",
    );
  }

  const itemIdx = headerIndex(rows[itemHeaderRow]);
  for (let i = itemHeaderRow + 1; i < rows.length; i++) {
    const row = rows[i];
    const itemNumber = cell(row, itemIdx, "Item Number");
    if (!itemNumber) continue;
    const item = readItem(row, itemIdx, itemNumber, warnings);
    if (item) order.items.push(item);
  }

  const lineSum = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  if (order.printedTotal > 0 && lineSum - order.printedTotal > 0.01) {
    order.warnings.push(
      `The line totals sum to ${lineSum.toFixed(2)} but the order total is ` +
        `${order.printedTotal.toFixed(2)} — an order-level discount of ` +
        `${(lineSum - order.printedTotal).toFixed(2)} that is NOT reflected in the unit costs ` +
        "shown. Apply it to the costs before importing if the PO should carry the discounted price.",
    );
  } else if (order.printedTotal > 0 && Math.abs(lineSum - order.printedTotal) > 0.01) {
    order.warnings.push(
      `Line totals sum to ${lineSum.toFixed(2)}, which does not match the order total ` +
        `${order.printedTotal.toFixed(2)}.`,
    );
  }

  return order;
}

export function parseSimblistCsvBuffer(buffer: Buffer): SimblistOrder {
  return parseSimblistCsvText(buffer.toString("utf8"));
}
