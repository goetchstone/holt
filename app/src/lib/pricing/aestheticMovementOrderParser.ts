// /app/src/lib/pricing/aestheticMovementOrderParser.ts
//
// Server-only parser for Aesthetic Movement order PDFs. Printworks writes
// orders through this rep (owner 2026-07-17), and the form prints
// "Vendor: <name>", so one parser serves every vendor Aesthetic Movement reps.
//
// An item is a stack of lines:
//
//   PW00689                <- SKU (letters + digits)
//   Classic - Tic Tac Toe  <- product name
//   ETA EARLY JULY         <- optional status note(s), ignored
//   7350108174152          <- optional UPC (some items carry none)
//   12$33.00$396.00        <- qty $unit-price $line-total
//
// Verified against the real order (PON09056, 6 items, 66 units, $2,688.00):
//
// 1. The money line HAS dollar signs — "12$33.00$396.00" (qty $price $total),
//    the split is unambiguous, but qty x price == total is still checked.
// 2. The UPC is OPTIONAL — an out-of-stock item ("Reverra - Mahjong",
//    OOS) prints no UPC, so its barcode exports blank and Ordorite assigns one.
// 3. The vendor prints on a "Vendor: <name>" line, read like MarketTime's MFR.

const pdfParse = require("pdf-parse");

export interface AestheticMovementItem {
  sku: string;
  name: string;
  upc: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface AestheticMovementOrder {
  vendorName: string;
  poNumber: string;
  shipDate: string;
  printedTotal: number;
  printedItems: number | null;
  printedUnits: number | null;
  items: AestheticMovementItem[];
  warnings: string[];
}

const VENDOR = /^Vendor:\s*(.+?)\s*$/;
const PO_NUMBER = /(PON\d+)/;
const SHIP_DATE = /Earliest Ship Date\s*(.+?)\s*$/;
const ORDER_TOTAL = /^Order Total:\s*\$?([\d,]+\.\d{2})/i;
const NUMBER_OF_ITEMS = /^Number of Items:\s*(\d+)/i;
const TOTAL_QUANTITY = /^Total Quantity:\s*(\d+)/i;

// SKU like "PW00689" — letters then digits, on its own line.
const SKU_LINE = /^([A-Z]{2,}\d+)$/;
// qty + $unit price + $line total.
const MONEY_LINE = /^(\d+)\$([\d,]+\.\d{2})\$([\d,]+\.\d{2})$/;
// A bare UPC line (12-14 digits).
const UPC_LINE = /^\d{12,14}$/;

function parseMoney(raw: string): number {
  return Number.parseFloat(raw.replaceAll(",", ""));
}

interface Scan {
  sku: string | null;
  name: string;
  upc: string;
}

function reset(scan: Scan): void {
  scan.sku = null;
  scan.name = "";
  scan.upc = "";
}

function flush(scan: Scan, money: RegExpExecArray, order: AestheticMovementOrder): void {
  const qty = Number.parseInt(money[1], 10);
  const unitPrice = parseMoney(money[2]);
  const lineTotal = parseMoney(money[3]);
  if (qty <= 0 || Math.abs(unitPrice * qty - lineTotal) > 0.01) {
    order.warnings.push(
      `Item ${scan.sku}: ${qty} x ${unitPrice.toFixed(2)} does not equal the line total ` +
        `${lineTotal.toFixed(2)} — check it before importing.`,
    );
    reset(scan);
    return;
  }
  order.items.push({
    sku: scan.sku as string,
    name: scan.name,
    upc: scan.upc,
    qty,
    unitPrice,
    lineTotal,
  });
  reset(scan);
}

/** The first capture group of the first line that matches, or undefined. */
function firstCapture(rawLines: readonly string[], pattern: RegExp): string | undefined {
  for (const line of rawLines) {
    const m = pattern.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

function readHeader(rawLines: readonly string[], order: AestheticMovementOrder): void {
  order.vendorName = firstCapture(rawLines, VENDOR) ?? "";
  order.poNumber = firstCapture(rawLines, PO_NUMBER) ?? "";
  order.shipDate = firstCapture(rawLines, SHIP_DATE) ?? "";
  const total = firstCapture(rawLines, ORDER_TOTAL);
  if (total !== undefined) order.printedTotal = parseMoney(total);
  const items = firstCapture(rawLines, NUMBER_OF_ITEMS);
  if (items !== undefined) order.printedItems = Number.parseInt(items, 10);
  const units = firstCapture(rawLines, TOTAL_QUANTITY);
  if (units !== undefined) order.printedUnits = Number.parseInt(units, 10);
}

function readItemLine(line: string, scan: Scan, order: AestheticMovementOrder): void {
  if (scan.sku !== null) {
    const money = MONEY_LINE.exec(line);
    if (money) {
      flush(scan, money, order);
      return;
    }
    if (UPC_LINE.test(line)) {
      scan.upc = line;
      return;
    }
    // The FIRST free-text line after the SKU is the product name; later ones
    // (ETA/OOS status notes) are ignored.
    if (!scan.name && !SKU_LINE.test(line)) {
      scan.name = line;
      return;
    }
  }
  const skuM = SKU_LINE.exec(line);
  if (skuM) {
    scan.sku = skuM[1];
    scan.name = "";
    scan.upc = "";
  }
}

function reconcile(order: AestheticMovementOrder): void {
  if (order.printedTotal > 0) {
    const calculated = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
    if (Math.abs(calculated - order.printedTotal) > 0.01) {
      order.warnings.push(
        `Line totals sum to ${calculated.toFixed(2)}, which does not match the order total ` +
          `${order.printedTotal.toFixed(2)}.`,
      );
    }
  }
  if (order.printedItems !== null && order.items.length !== order.printedItems) {
    order.warnings.push(
      `Read ${order.items.length} item(s), but the document says ${order.printedItems}.`,
    );
  }
  const units = order.items.reduce((sum, i) => sum + i.qty, 0);
  if (order.printedUnits !== null && units !== order.printedUnits) {
    order.warnings.push(`Quantities total ${units}, but the document says ${order.printedUnits}.`);
  }
}

export function parseAestheticMovementOrderText(text: string): AestheticMovementOrder {
  const warnings: string[] = [];
  const order: AestheticMovementOrder = {
    vendorName: "",
    poNumber: "",
    shipDate: "",
    printedTotal: 0,
    printedItems: null,
    printedUnits: null,
    items: [],
    warnings,
  };

  const rawLines = text
    .split("\n")
    .map((l) => l.replaceAll(/[\u00a0\u2007\u202f]/gu, " ").trim())
    .filter((l) => l !== "");

  readHeader(rawLines, order);

  const scan: Scan = { sku: null, name: "", upc: "" };
  for (const line of rawLines) {
    readItemLine(line, scan, order);
  }
  if (scan.sku) {
    warnings.push(`Item ${scan.sku}: no price line was found -- skipped.`);
  }

  reconcile(order);
  return order;
}

export async function parseAestheticMovementOrderPDF(
  buffer: Buffer,
): Promise<AestheticMovementOrder> {
  const data = await pdfParse(buffer);
  return parseAestheticMovementOrderText(data.text);
}
