// /app/src/lib/pricing/hdProposalParser.ts
//
// Server-only parser for Hunter Douglas Direct Connect proposal PDFs.
// Extracts quote metadata, line items with freight/install charges,
// and totals from the text output of pdf-parse.

const pdfParse = require("pdf-parse");

export interface HDLineItem {
  itemNumber: number;
  room: string;
  description: string;
  qty: number;
  msrp: number;
  each: number;
  extended: number;
  freight: number;
  install: number;
}

export interface HDCustomer {
  name: string;
  street: string;
  cityStateZip: string;
}

export interface HDProposal {
  quoteNumber: string;
  quoteDate: string;
  validThrough: string;
  salesperson: string;
  sidemark: string;
  customer: HDCustomer;
  items: HDLineItem[];
  totalFreight: number;
  totalInstall: number;
  msrpTotal: number;
  discountTotal: number;
  clientPrice: number;
}

function parseNumber(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[,$\s]/g, "");
  const n = Number.parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

export async function parseHDProposal(buffer: Buffer): Promise<HDProposal> {
  const data = await pdfParse(buffer);
  const text: string = data.text;
  const lines: string[] = text.split("\n").map((l: string) => l.trim());

  // Valid through date
  let validThrough = "";
  const validMatch = text.match(/valid through:\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (validMatch) validThrough = validMatch[1];

  // Quote number and date: PDF concatenates as "03/21/202621366155"
  let quoteNumber = "";
  let quoteDate = "";
  const dateQuoteLine = lines.find((l: string) => /^\d{2}\/\d{2}\/\d{4}\s*\d+/.test(l));
  if (dateQuoteLine) {
    const dqMatch = dateQuoteLine.match(/^(\d{2}\/\d{2}\/\d{4})\s*(\d+)/);
    if (dqMatch) {
      quoteDate = dqMatch[1];
      quoteNumber = dqMatch[2];
    }
  }

  // Salesperson
  let salesperson = "";
  const spIdx = lines.findIndex((l: string) => l === "Salesperson");
  if (spIdx >= 0 && spIdx + 1 < lines.length) {
    const next = lines[spIdx + 1];
    if (next && !next.startsWith("Sold") && next.length > 0) {
      salesperson = next;
    }
  }

  // Customer: after "Sold To:"
  const customer: HDCustomer = { name: "", street: "", cityStateZip: "" };
  const soldIdx = lines.findIndex((l: string) => l.startsWith("Sold To:"));
  if (soldIdx >= 0) {
    const afterSold = lines.slice(soldIdx + 1);
    let ci = 0;
    while (ci < afterSold.length && afterSold[ci] === "") ci++;
    if (ci < afterSold.length) customer.name = afterSold[ci++];
    while (ci < afterSold.length && afterSold[ci] === "") ci++;
    if (ci < afterSold.length) customer.street = afterSold[ci++];
    while (ci < afterSold.length && afterSold[ci] === "") ci++;
    if (ci < afterSold.length && !afterSold[ci].startsWith("Sidemark")) {
      customer.cityStateZip = afterSold[ci];
    }
  }

  // Sidemark
  let sidemark = "";
  const sidemarkMatch = text.match(/Sidemark:\s*(.+?)(?:\n|$)/);
  if (sidemarkMatch) sidemark = sidemarkMatch[1].trim();

  // Extract all freight and install charges in order of appearance
  const freightMatches = text.match(/Freight Charges\s*:\s*([\d,.]+)/g) || [];
  const installMatches = text.match(/Installation Charges\s*:\s*([\d,.]+)/g) || [];

  const allFreights: number[] = freightMatches.map((m: string) => {
    const v = m.match(/([\d,.]+)$/);
    return v ? parseNumber(v[1]) : 0;
  });
  const allInstalls: number[] = installMatches.map((m: string) => {
    const v = m.match(/([\d,.]+)$/);
    return v ? parseNumber(v[1]) : 0;
  });

  // Extract qty+MSRP+Each+Extended: PDF renders as "1514.00425.00425.00"
  // Pattern: qty(1 digit) + MSRP(price) + Each(price) + Extended(price)
  const priceMatches: { qty: number; msrp: number; each: number; extended: number }[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d)([\d,]+\.\d{2})([\d,]+\.\d{2})([\d,]+\.\d{2})$/);
    if (m) {
      priceMatches.push({
        qty: Number.parseInt(m[1]),
        msrp: parseNumber(m[2]),
        each: parseNumber(m[3]),
        extended: parseNumber(m[4]),
      });
    }
  }

  // Extract item blocks by finding "Hunter Douglas" description lines.
  // HD descriptions can appear as:
  //   "Hunter Douglas ..."           (standalone line)
  //   "5PantryHunter Douglas ..."    (item+room+desc concatenated)
  //   "6 Hunter Douglas ..."         (item number + space + desc)
  const items: HDLineItem[] = [];
  const hdIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("Hunter Douglas") && !lines[i].startsWith("Location")) {
      hdIndices.push(i);
    }
  }

  for (let hi = 0; hi < hdIndices.length; hi++) {
    const descIdx = hdIndices[hi];
    const fullLine = lines[descIdx];

    // Extract the HD description from the line (may be prefixed with item#/room)
    const hdStart = fullLine.indexOf("Hunter Douglas");
    let description = fullLine.substring(hdStart);

    // Description may continue on next line
    if (
      descIdx + 1 < lines.length &&
      !lines[descIdx + 1].startsWith("Freight") &&
      !lines[descIdx + 1].includes("Hunter Douglas") &&
      !lines[descIdx + 1].match(/^\d[\d,]+\.\d{2}$/) &&
      lines[descIdx + 1] !== ""
    ) {
      description += " " + lines[descIdx + 1];
    }

    // Extract item number and room from what precedes "Hunter Douglas" on this line
    let itemNumber = hi + 1;
    let room = "";
    const prefix = fullLine.substring(0, hdStart).trim();

    if (prefix) {
      // Prefix like "5Pantry" or "6 " or "1Dining"
      const numMatch = prefix.match(/^(\d{1,2})\s*(.*)/);
      if (numMatch) {
        itemNumber = Number.parseInt(numMatch[1]);
        room = numMatch[2].trim();
      }
    } else {
      // HD description on its own line; look backward for item number + room
      const roomParts: string[] = [];

      for (let j = descIdx - 1; j >= Math.max(0, descIdx - 5); j--) {
        const prev = lines[j];
        if (!prev) continue;
        if (prev.match(/^\d[\d,]+\.\d{2}$/)) continue;
        if (prev.startsWith("Freight") || prev.startsWith("Installation")) continue;
        if (prev.startsWith("Location") || prev.startsWith("Control System")) break;
        if (prev === "No" || prev === "Yes") continue;

        const numMatch = prev.match(/^(\d{1,2})(.*)/);
        if (numMatch) {
          const num = Number.parseInt(numMatch[1]);
          if (num >= 1 && num <= 99) {
            itemNumber = num;
            const rest = numMatch[2].trim();
            if (rest) roomParts.unshift(rest);
            break;
          }
        }

        if (/^[A-Z]/.test(prev) && prev.length < 30) {
          roomParts.unshift(prev);
        }
      }

      room = roomParts.join(" ").trim();
    }

    const price = priceMatches[hi];
    const freight = hi < allFreights.length ? allFreights[hi] : 0;
    const install = hi < allInstalls.length ? allInstalls[hi] : 0;

    items.push({
      itemNumber,
      room,
      description: description.trim(),
      qty: price?.qty ?? 1,
      msrp: price?.msrp ?? 0,
      each: price?.each ?? 0,
      extended: price?.extended ?? 0,
      freight,
      install,
    });
  }

  // Totals: PDF concatenates as "9,075.02-1,495.028,584.22"
  let msrpTotal = 0;
  let discountTotal = 0;
  let clientPrice = 0;

  const totalsLine = lines.find((l: string) => /^[\d,]+\.\d{2}-/.test(l));
  if (totalsLine) {
    const tm = totalsLine.match(/^([\d,]+\.\d{2})([-][\d,]+\.\d{2})([\d,]+\.\d{2})$/);
    if (tm) {
      msrpTotal = parseNumber(tm[1]);
      discountTotal = parseNumber(tm[2]);
      clientPrice = parseNumber(tm[3]);
    }
  }

  const totalFreight = allFreights.reduce((sum: number, v: number) => sum + v, 0);
  const totalInstall = allInstalls.reduce((sum: number, v: number) => sum + v, 0);

  return {
    quoteNumber,
    quoteDate,
    validThrough,
    salesperson,
    sidemark,
    customer,
    items,
    totalFreight,
    totalInstall,
    msrpTotal,
    discountTotal,
    clientPrice,
  };
}
