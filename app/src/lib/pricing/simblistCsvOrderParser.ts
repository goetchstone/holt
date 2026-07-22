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
//   Simblist Group,MAISON ZOE FORD,PON09047,2026-06-11,...,722.74,...
//   Sequence #,Item Number,Name,Description,Quantity,Unit Price,...,UPC,...,Total Price
//   3,ZFUSA03-C,Big Time Brownie Mix - case pack of 6,,2,53.94,...,10628678860152,...,$107.88
//
// Verified against the real order (PON09047, 5 items):
//
// 1. qty x Unit Price == Total Price on every line (2 x 53.94 == 107.88).
// 2. The UPCs are real 14-digit manufacturer codes, so new items carry them.
// 3. The line Total Prices sum to $803.04 but the header Order Total is $722.74
//    (10% less) -- an order-level discount that is NOT in the unit prices. It is
//    surfaced as a warning, never applied (same doctrine as SuperCat).

import Papa from "papaparse";

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

function parseMoney(raw: string | undefined): number {
  if (!raw) return 0;
  return Number.parseFloat(raw.replaceAll(/[$,]/g, "").trim()) || 0;
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
  order.printedTotal = parseMoney(cell(orderValues, orderIdx, "Order Total"));

  const itemIdx = headerIndex(rows[itemHeaderRow]);
  for (let i = itemHeaderRow + 1; i < rows.length; i++) {
    const row = rows[i];
    const itemNumber = cell(row, itemIdx, "Item Number");
    if (!itemNumber) continue;
    const qty = Number.parseInt(cell(row, itemIdx, "Quantity"), 10);
    const unitPrice = parseMoney(cell(row, itemIdx, "Unit Price"));
    const lineTotal = parseMoney(cell(row, itemIdx, "Total Price"));
    if (!Number.isFinite(qty) || qty <= 0 || Math.abs(unitPrice * qty - lineTotal) > 0.01) {
      warnings.push(
        `Item ${itemNumber}: ${qty} x ${unitPrice.toFixed(2)} does not equal the line total ` +
          `${lineTotal.toFixed(2)} — check it before importing.`,
      );
      continue;
    }
    const listRaw = cell(row, itemIdx, "List Price");
    order.items.push({
      itemNumber,
      name: cell(row, itemIdx, "Name"),
      qty,
      unitPrice,
      lineTotal,
      upc: cell(row, itemIdx, "UPC"),
      listPrice: listRaw ? parseMoney(listRaw) : null,
      notes: cell(row, itemIdx, "Notes"),
    });
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
