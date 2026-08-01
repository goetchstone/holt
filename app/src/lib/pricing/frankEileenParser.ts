// /app/src/lib/pricing/frankEileenParser.ts
//
// Server-only parser for Frank & Eileen order acknowledgement PDFs
// ("A C K N O W L E D G E M E N T", orackf.frei layout). Used by the
// Apparel Order Import tool's frank-eileen format.
//
// Each line item is a 6-line block in the pdf-parse text:
//
//   EILEEN                                          <- style
//   PRBG                                            <- color code
//   Relaxed Button-Up Shirt Pink Red Blue Flowers   <- description
//     XXS   XS    S    M    L   XL                  <- size scale header
//   0010_                                           <- line number
//       1    1    1    1 112.00     4   448.00      <- qtys, price, units, extension
//
// Per-size quantities are RIGHT-ALIGNED to their size label: a quantity
// token's END offset equals the label's END offset in the size header
// (fixed-width layout that pdf-parse preserves). The last three numeric
// tokens of the quantity line are unit price / total units / extension;
// everything before them maps to sizes by nearest end-offset. A line whose
// mapped quantities do not sum to its own UNITS column is NEVER guessed —
// it is dropped and reported in `warnings` so the buyer adds it by hand.

const pdfParse = require("pdf-parse");

export interface FrankEileenSize {
  size: string;
  quantity: number;
}

export interface FrankEileenLineItem {
  styleNumber: string;
  colorCode: string;
  description: string;
  unitPrice: number;
  totalUnits: number;
  totalPrice: number;
  sizes: FrankEileenSize[];
}

export interface FrankEileenOrder {
  /** Catalog vendor name (1,916 existing products) — NOT the PDF's "FRANK & EILEEN". */
  vendorName: string;
  ackNumber: string;
  /** Customer P.O. from the header — the PO reference the buyer placed. */
  poNumber: string;
  orderDate: string;
  deliveryStart: string;
  deliveryEnd: string;
  season: string;
  totalUnits: number;
  totalPrice: number;
  warnings: string[];
  items: FrankEileenLineItem[];
}

export const FRANK_EILEEN_VENDOR_NAME = "Frank and Eileen";

const LINE_NUMBER = /^\d{4}(_|OS)\s*$/;
const STYLE = /^[A-Z][A-Z0-9]{1,15}$/;
const COLOR = /^[A-Z0-9]{2,6}$/;
const SEASON = /(Spring|Summer|Fall|Autumn|Winter|Holiday|Resort)\s*(\d{4})/i;
const DATE = /\d{2}\/\d{2}\/\d{2}/g;

interface NumberToken {
  value: number;
  end: number;
}

function numberTokens(line: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    tokens.push({ value: Number.parseFloat(m[0]), end: m.index + m[0].length - 1 });
  }
  return tokens;
}

interface SizeColumn {
  size: string;
  end: number;
}

function sizeColumns(headerLine: string): SizeColumn[] {
  const cols: SizeColumn[] = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(headerLine)) !== null) {
    cols.push({ size: m[0], end: m.index + m[0].length - 1 });
  }
  return cols;
}

/** Map quantity tokens to size columns by matching right-aligned end offsets. */
function mapQuantities(qtyTokens: NumberToken[], columns: SizeColumn[]): FrankEileenSize[] | null {
  const used = new Set<number>();
  const sizes: FrankEileenSize[] = [];
  for (const token of qtyTokens) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < columns.length; i++) {
      const distance = Math.abs(columns[i].end - token.end);
      if (!used.has(i) && distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    // The layout is fixed-width; anything further than a couple of chars
    // means the alignment assumption broke — refuse rather than guess.
    if (best === -1 || bestDistance > 2) return null;
    used.add(best);
    sizes.push({ size: columns[best].size, quantity: token.value });
  }
  return sizes;
}

/** Parse the 6-line block anchored at the line-number marker (index i).
 *  Returns the item, or null after pushing a warning — never guesses. */
function parseItemBlock(
  lines: string[],
  i: number,
  warnings: string[],
): FrankEileenLineItem | null {
  const styleNumber = (lines[i - 4] ?? "").trim();
  const colorCode = (lines[i - 3] ?? "").trim();
  const lineNo = lines[i].trim();

  if (!STYLE.test(styleNumber) || !COLOR.test(colorCode)) {
    warnings.push(`Line ${lineNo}: could not read style/color — add this item manually.`);
    return null;
  }

  const tokens = numberTokens(lines[i + 1] ?? "");
  if (tokens.length < 4) {
    warnings.push(`Line ${lineNo} (${styleNumber}-${colorCode}): unreadable quantity row.`);
    return null;
  }
  const [priceToken, unitsToken, extensionToken] = tokens.slice(-3);
  const unitPrice = priceToken.value;
  const totalUnits = unitsToken.value;
  const extension = extensionToken.value;
  const sizes = mapQuantities(tokens.slice(0, -3), sizeColumns(lines[i - 1] ?? ""));

  const mappedUnits = sizes?.reduce((sum, s) => sum + s.quantity, 0) ?? -1;
  if (!sizes || mappedUnits !== totalUnits) {
    warnings.push(
      `Line ${lineNo} (${styleNumber}-${colorCode}): size quantities did not line up ` +
        `with the ${totalUnits}-unit total — add this item manually.`,
    );
    return null;
  }

  return {
    styleNumber,
    colorCode,
    description: (lines[i - 2] ?? "").trim(),
    unitPrice,
    totalUnits,
    totalPrice: extension,
    sizes,
  };
}

export function parseFrankEileenText(text: string): FrankEileenOrder {
  const lines = text.split("\n");
  const warnings: string[] = [];
  const items: FrankEileenLineItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!LINE_NUMBER.test(lines[i].trim())) continue;
    const item = parseItemBlock(lines, i, warnings);
    if (item) items.push(item);
  }

  // Header fields repeat identically on every page; first hit wins.
  const ackMatch = /^(\d{5,})(\d{2}\/\d{2}\/\d{2})$/m.exec(text);
  const poMatch = /^(\d{6,})(?=[A-Z])/m.exec(text);
  const seasonMatch = SEASON.exec(text);
  const seasonLine = seasonMatch ? lines.find((l) => l.includes(seasonMatch[0])) : undefined;
  const headerDates = seasonLine ? (seasonLine.match(DATE) ?? []) : [];

  const totalMatch = /Merchandise USD Total\s+(\d+)\s+([\d.]+)/.exec(text);
  const totalUnits = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0;
  const totalPrice = totalMatch ? Number.parseFloat(totalMatch[2]) : 0;
  const parsedUnits = items.reduce((sum, it) => sum + it.totalUnits, 0);
  if (totalMatch && parsedUnits !== totalUnits) {
    warnings.push(
      `Parsed ${parsedUnits} units but the document total says ${totalUnits} — ` +
        "check the dropped lines above.",
    );
  }

  return {
    vendorName: FRANK_EILEEN_VENDOR_NAME,
    ackNumber: ackMatch ? ackMatch[1] : "",
    poNumber: poMatch ? poMatch[1] : "",
    orderDate: headerDates[0] ?? "",
    deliveryStart: headerDates[1] ?? "",
    deliveryEnd: headerDates[2] ?? "",
    season: seasonMatch ? `${seasonMatch[1]} ${seasonMatch[2]}` : "",
    totalUnits,
    totalPrice,
    warnings,
    items,
  };
}

export async function parseFrankEileenPDF(buffer: Buffer): Promise<FrankEileenOrder> {
  const data = await pdfParse(buffer);
  return parseFrankEileenText(data.text);
}
