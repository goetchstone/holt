// /app/src/lib/pricing/nuorderPrintoutParser.ts
//
// Server-only parser for NuOrder "order printout" PDFs (ORDER_Brand_date_PO.pdf).
// Unlike the order-confirmation layout (nuorderParser.ts, one "Style #:" line
// per field), the printout renders each item as a size GRID: a header row of
// size labels (XXS–XL, numeric 00–14, or one-size) with quantity digits under
// the ordered columns. Flat text extraction (pdf-parse) concatenates those
// digits into ambiguous runs ("1111 4USD 448.00" under "XXSXSSMLXLQty"), so
// this parser works from positioned text items (pdfjs-dist getTextContent
// x/y): each digit is assigned to the size column with the nearest header x.
// Verified against rendered pages of the Frank & Eileen (PO 18573341) and
// Hunter Bell (PO 18908185) printouts.
//
// REFUSE-TO-GUESS: a block is dropped (with a warning) unless its per-size
// quantities sum to its own Qty column AND unit price x quantity equals the
// printed line total. Two digits landing in one column is treated as broken
// alignment, never averaged. A parsed-vs-printed Grand Total mismatch adds a
// warning so dropped lines can't pass silently.

export interface PositionedItem {
  str: string;
  x: number;
  y: number;
}

export interface NuOrderPrintoutSize {
  size: string;
  quantity: number;
}

export interface NuOrderPrintoutItem {
  styleNumber: string;
  /** The block's accumulated color/description text as printed. Printouts mix
   *  codes and names freely ("PRBG Pink Red Blue Flowers", "1984 Washed Blue",
   *  "Lost At Sea") — splitting code from name would be a guess. */
  colorCode: string;
  productName: string;
  /** Sugg. Retail from the style row. */
  msrp: number;
  /** Wholesale from the style row. */
  unitPrice: number;
  totalUnits: number;
  totalPrice: number;
  sizes: NuOrderPrintoutSize[];
}

export interface NuOrderPrintout {
  /** Always "" — the printout renders the brand as a logo image, not text.
   *  Registry entries carry catalogVendorName; the generic entry leaves the
   *  vendor to the buyer. */
  vendorName: string;
  poNumber: string;
  /** "Created:" from the Order Information block. */
  orderDate: string;
  /** "Start Ship:" from the Order Information block. */
  deliveryStart: string;
  /** "Complete Ship:" from the Order Information block. */
  deliveryEnd: string;
  terms: string;
  /** First non-empty season from the "Style #X | SEASON" anchors. */
  season: string;
  /** Printed "Total Quantity:" (active styles). */
  totalUnits: number;
  /** Printed "Grand Total:". */
  totalPrice: number;
  warnings: string[];
  /** "Cancelled Styles:" section summary — those blocks never become items. */
  cancelled: { items: number; units: number; total: number };
  items: NuOrderPrintoutItem[];
}

// Size labels seen across NuOrder brands: letter scales, even numerics
// (00 = double-zero), and one-size ("O/S" on Frank & Eileen, "OS" on
// Hunter Bell). An unknown label refuses the whole block.
const SIZE_VOCAB = new Set([
  "XXS",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "XXL",
  "00",
  "0",
  "2",
  "4",
  "6",
  "8",
  "10",
  "12",
  "14",
  "16",
  "18",
  "20",
  "O/S",
  "OS",
]);

// Far-left column (x < 100pt) holds product names and section headings;
// the leftmost Order Information column ends before x=170 (the Brand
// Information column starts at 176).
const LEFT_MARGIN_MAX_X = 100;
const INFO_COLUMN_MAX_X = 170;
// The grid zone starts a little left of the first size column so slightly
// offset digits still land inside; color/description text starts ~80pt
// further left, far outside this margin.
const GRID_MARGIN = 30;
// Items whose y differ by more than this are separate visual rows (real
// rows in these printouts sit 2pt+ apart).
const ROW_Y_TOLERANCE = 1;

const STYLE_ANCHOR =
  /^Style #\s*(\S+)\s*\|\s*(.*?)\s*Wholesale:\s*USD\s*([\d,.]+)(?:\s*Sugg\. Retail:\s*USD\s*([\d,.]+))?/;

interface Row {
  items: PositionedItem[];
  text: string;
}

interface SizeColumn {
  label: string;
  x: number;
}

interface StyleBlock {
  styleNumber: string;
  season: string;
  unitPrice: number;
  msrp: number;
  productName: string;
  columns: SizeColumn[] | null;
  colorParts: string[];
  gridTokens: PositionedItem[];
}

function parseMoney(s: string): number {
  const n = Number.parseFloat(s.replaceAll(",", ""));
  return Number.isNaN(n) ? 0 : n;
}

function isDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** Money amount at the END of a grid token ("USD 448.00" or a bare
 *  "1,057.00" when NuOrder stacks the currency and amount on separate
 *  rows). Anchored so size labels and page numbers can't match. */
function trailingMoney(s: string): number | null {
  const m = /(\d[\d,]*\.\d{2})$/.exec(s.trim());
  return m ? parseMoney(m[1]) : null;
}

function buildRow(items: PositionedItem[]): Row {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const text = sorted
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { items: sorted, text };
}

/** Group a page's positioned items into visual rows: sort top-to-bottom and
 *  start a new row when the y gap exceeds the tolerance. */
function groupRows(page: PositionedItem[]): Row[] {
  const sorted = page.filter((it) => it.str.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Row[] = [];
  let current: PositionedItem[] = [];
  let currentY = 0;
  for (const item of sorted) {
    if (current.length > 0 && currentY - item.y > ROW_Y_TOLERANCE) {
      rows.push(buildRow(current));
      current = [];
    }
    if (current.length === 0) currentY = item.y;
    current.push(item);
  }
  if (current.length > 0) rows.push(buildRow(current));
  return rows;
}

/** Collapse NuOrder's "<code> <name>" doubling when code and name are the
 *  same text ("Natural Natural", "Somers Shell Cream Somers Shell Cream").
 *  Exact-halves equality only — anything else is kept verbatim. */
function collapseDoubledColor(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length % 2 === 0) {
    const half = words.length / 2;
    const first = words.slice(0, half).join(" ");
    if (first === words.slice(half).join(" ")) return first;
  }
  return text;
}

class PrintoutScanner {
  private readonly items: NuOrderPrintoutItem[] = [];
  private readonly cancelledItems: NuOrderPrintoutItem[] = [];
  private readonly warnings: string[] = [];
  private pending: StyleBlock | null = null;
  private inCancelled = false;
  private productName = "";
  private season = "";
  private poNumber = "";
  private orderDate = "";
  private deliveryStart = "";
  private deliveryEnd = "";
  private terms = "";
  private printedTotalQty = 0;
  private printedGrandTotal: number | null = null;

  scanPage(page: PositionedItem[]): void {
    for (const row of groupRows(page)) this.scanRow(row);
    // Blocks never span pages (every page re-renders the full header).
    this.flush();
  }

  private scanRow(row: Row): void {
    const t = row.text;
    if (t === "Cancelled Styles:") {
      // The section heading sits at the far-left margin; the summary box
      // repeats the same label at x~346 and must not flip the state.
      if (row.items[0].x < LEFT_MARGIN_MAX_X) {
        this.flush();
        this.inCancelled = true;
      }
      return;
    }
    if (this.tryStyleAnchor(t)) return;
    // "Colors ... Total" is boilerplate above every grid; "Materials:" is a
    // Hunter Bell fabric-content line (far-left — would pollute productName).
    if (/^Colors\b/.test(t) || t.startsWith("Materials:")) return;
    if (this.trySummary(t)) return;
    if (this.tryHeaderField(row)) return;
    if (this.pending && !this.pending.columns && t.replaceAll(/\s+/g, "").endsWith("Qty")) {
      this.readSizeHeader(row);
      return;
    }
    if (row.items[0].x < LEFT_MARGIN_MAX_X) {
      // Far-left rows between blocks are product names ("Relaxed Button-Up
      // Shirt"). Page-header noise also lands here and is overwritten by the
      // real product row before the next style anchor uses it.
      this.productName = t;
      return;
    }
    if (this.pending?.columns) this.readGridRow(row);
  }

  private tryStyleAnchor(text: string): boolean {
    const m = STYLE_ANCHOR.exec(text);
    if (!m) return false;
    this.flush();
    const season = m[2].trim();
    if (!this.season && season) this.season = season;
    this.pending = {
      styleNumber: m[1],
      season,
      unitPrice: parseMoney(m[3]),
      msrp: m[4] ? parseMoney(m[4]) : 0,
      productName: this.productName,
      columns: null,
      colorParts: [],
      gridTokens: [],
    };
    return true;
  }

  /** Summary rows must be intercepted BEFORE grid processing: they sit in
   *  the grid x-zone while the page's last block is still pending, so their
   *  numbers would otherwise be binned as quantities. */
  private trySummary(text: string): boolean {
    const qtyMatch = /^Total Quantity:\s*(\d+)/.exec(text);
    if (qtyMatch) {
      if (!this.inCancelled) this.printedTotalQty = Number.parseInt(qtyMatch[1], 10);
      return true;
    }
    if (text.startsWith("Grand Total:")) {
      const money = /(\d[\d,]*\.\d{2})/.exec(text);
      if (money) this.printedGrandTotal = parseMoney(money[1]);
      return true;
    }
    // Subtotal (duplicate of Grand Total), the cancelled section's Total,
    // and Order Comments carry nothing we report — intercept and discard.
    return (
      text.startsWith("Subtotal:") || text.startsWith("Total:") || text.startsWith("Order Comments")
    );
  }

  /** Order Information fields repeat on every page; first hit wins. The
   *  Brand/Shipping/Billing columns share the same rows, so matching is
   *  restricted to items left of the info-column boundary. */
  private tryHeaderField(row: Row): boolean {
    const poMatch = /^PO#:\s*(\S+)/.exec(row.text);
    if (poMatch) {
      if (!this.poNumber) this.poNumber = poMatch[1];
      return true;
    }
    const leftText = buildRow(row.items.filter((i) => i.x < INFO_COLUMN_MAX_X)).text;
    const created = /^Created:\s*(\S+)/.exec(leftText);
    if (created) {
      this.orderDate = this.orderDate || created[1];
      return true;
    }
    const startShip = /^Start Ship:\s*(\S+)/.exec(leftText);
    if (startShip) {
      this.deliveryStart = this.deliveryStart || startShip[1];
      return true;
    }
    const completeShip = /^Complete Ship:\s*(\S+)/.exec(leftText);
    if (completeShip) {
      this.deliveryEnd = this.deliveryEnd || completeShip[1];
      return true;
    }
    const terms = /^Terms:\s*(.+)/.exec(leftText);
    if (terms) {
      this.terms = this.terms || terms[1].trim();
      return true;
    }
    return false;
  }

  private readSizeHeader(row: Row): void {
    const block = this.pending;
    if (!block) return;
    const last = row.items.at(-1);
    const sizeItems = row.items.slice(0, -1);
    if (last?.str !== "Qty" || sizeItems.some((i) => !SIZE_VOCAB.has(i.str))) {
      this.warnings.push(
        `Style ${block.styleNumber}: unrecognized size header "${row.text}" — ` +
          "the items under it were skipped, add them manually.",
      );
      this.pending = null;
      return;
    }
    block.columns = row.items.map((i) => ({ label: i.str, x: i.x }));
  }

  private readGridRow(row: Row): void {
    const block = this.pending;
    if (!block?.columns) return;
    const threshold = block.columns[0].x - GRID_MARGIN;
    const left = row.items.filter((i) => i.x < threshold);
    const right = row.items.filter((i) => i.x >= threshold);
    // Color/description text accumulates across wrapped rows — it can even
    // continue BELOW the quantity row ("PRBG Pink Red Blue" / "Flowers").
    if (left.length > 0) block.colorParts.push(buildRow(left).text);
    block.gridTokens.push(...right);
  }

  /** Assign each quantity digit to the nearest size column. Returns a
   *  failure reason instead of guessing when the alignment breaks. */
  private binDigits(block: StyleBlock): { sizes: NuOrderPrintoutSize[]; qty: number } | string {
    const columns = block.columns as SizeColumn[];
    const digits = block.gridTokens.filter((tok) => isDigits(tok.str));
    if (digits.length === 0) return "no quantities found in the size grid";
    const assigned = new Map<number, number>();
    for (const tok of digits) {
      let best = 0;
      for (let i = 1; i < columns.length; i++) {
        if (Math.abs(columns[i].x - tok.x) < Math.abs(columns[best].x - tok.x)) best = i;
      }
      if (assigned.has(best)) return `two quantities landed in the "${columns[best].label}" column`;
      assigned.set(best, Number.parseInt(tok.str, 10));
    }
    const qtyIndex = columns.length - 1;
    const qty = assigned.get(qtyIndex);
    if (qty === undefined) return "no Qty total found";
    const sizes: NuOrderPrintoutSize[] = [];
    for (const [index, quantity] of assigned) {
      if (index !== qtyIndex) sizes.push({ size: columns[index].label, quantity });
    }
    const summed = sizes.reduce((sum, s) => sum + s.quantity, 0);
    if (summed !== qty) return `size quantities sum to ${summed} but the Qty column says ${qty}`;
    return { sizes, qty };
  }

  private flush(): void {
    const block = this.pending;
    this.pending = null;
    if (!block) return;
    const colorCode = collapseDoubledColor(block.colorParts.join(" ").trim());
    const colorSuffix = colorCode ? ` (${colorCode})` : "";
    const label = `Style ${block.styleNumber}${colorSuffix}`;
    if (!block.columns) {
      this.warnings.push(`${label}: size-grid header not found — add this item manually.`);
      return;
    }
    const binned = this.binDigits(block);
    if (typeof binned === "string") {
      this.warnings.push(`${label}: ${binned} — add this item manually.`);
      return;
    }
    let extension: number | null = null;
    for (const tok of block.gridTokens) {
      extension = trailingMoney(tok.str) ?? extension;
    }
    if (extension === null) {
      this.warnings.push(`${label}: no line total found — add this item manually.`);
      return;
    }
    if (Math.abs(block.unitPrice * binned.qty - extension) > 0.01) {
      this.warnings.push(
        `${label}: ${binned.qty} units x ${block.unitPrice.toFixed(2)} does not equal the ` +
          `printed line total ${extension.toFixed(2)} — add this item manually.`,
      );
      return;
    }
    (this.inCancelled ? this.cancelledItems : this.items).push({
      styleNumber: block.styleNumber,
      colorCode,
      productName: block.productName,
      msrp: block.msrp,
      unitPrice: block.unitPrice,
      totalUnits: binned.qty,
      totalPrice: extension,
      sizes: binned.sizes,
    });
  }

  result(): NuOrderPrintout {
    const parsedTotal = this.items.reduce((sum, it) => sum + it.totalPrice, 0);
    if (this.printedGrandTotal === null) {
      this.warnings.push("Printed Grand Total not found — parsed totals are unverified.");
    } else if (Math.abs(parsedTotal - this.printedGrandTotal) > 0.005) {
      this.warnings.push(
        `Parsed items total ${parsedTotal.toFixed(2)} but the printed Grand Total is ` +
          `${this.printedGrandTotal.toFixed(2)} — check the dropped lines above.`,
      );
    }
    return {
      vendorName: "",
      poNumber: this.poNumber,
      orderDate: this.orderDate,
      deliveryStart: this.deliveryStart,
      deliveryEnd: this.deliveryEnd,
      terms: this.terms,
      season: this.season,
      totalUnits: this.printedTotalQty,
      totalPrice: this.printedGrandTotal ?? 0,
      warnings: this.warnings,
      cancelled: {
        items: this.cancelledItems.length,
        units: this.cancelledItems.reduce((sum, it) => sum + it.totalUnits, 0),
        total: this.cancelledItems.reduce((sum, it) => sum + it.totalPrice, 0),
      },
      items: this.items,
    };
  }
}

/** Pure core — one array of positioned text items per page, top of page =
 *  larger y (PDF coordinates, as pdfjs getTextContent returns them). */
export function parseNuOrderPrintoutItems(pages: PositionedItem[][]): NuOrderPrintout {
  const scanner = new PrintoutScanner();
  for (const page of pages) scanner.scanPage(page);
  return scanner.result();
}

export async function parseNuOrderPrintoutPDF(buffer: Buffer): Promise<NuOrderPrintout> {
  // pdfjs-dist v4 only ships ESM; dynamic import required for CJS
  // compatibility (same pattern as pdfImageExtractor.ts).
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
  const pages: PositionedItem[][] = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const positioned: PositionedItem[] = [];
      for (const raw of content.items) {
        const item = raw as { str?: unknown; transform?: unknown };
        if (typeof item.str !== "string" || !Array.isArray(item.transform)) continue;
        positioned.push({ str: item.str, x: item.transform[4], y: item.transform[5] });
      }
      pages.push(positioned);
      page.cleanup();
    }
  } finally {
    doc.destroy();
  }
  return parseNuOrderPrintoutItems(pages);
}
