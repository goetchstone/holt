// app/scripts/import-legacy-archive.mjs
//
// One-time loader for the Legacy Archive (feature flag `legacyArchive`).
// Generic by design: the SOURCE-SPECIFIC part is a JSON mapping config that
// names which delimited-file column fills which LegacyOrder/LegacyOrderLine
// field — code stays white-label, each onboarding gets its own config.
//
// Usage:
//   node scripts/import-legacy-archive.mjs <mapping.json> <orders-file> <lines-file>
//
// Mapping config shape (see docs/domains/legacy-archive.md for a worked
// example):
//   {
//     "delimiter": "\t",                  // "\t" or ","
//     "order": {                           // source column name -> field
//       "invoiceId": "orderNumber",       // REQUIRED target: orderNumber
//       "saleDate": "saleDate",
//       "billName": "customerName", ...
//     },
//     "line": {
//       "invoiceId": "orderNumber",       // REQUIRED: joins line -> order
//       "sku": "sku", "desc": "description", "ext": "lineTotal", ...
//     },
//     "dateFormat": "iso"                  // iso | mdY (MM/DD/YYYY)
//   }
//
// Idempotent: orders upsert on orderNumber; lines are replaced per order.
// Batched (500 orders per transaction) so a 400K-order archive loads in
// minutes without exhausting memory. Files may be .gz.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const [mappingPath, ordersPath, linesPath] = process.argv.slice(2);
if (!mappingPath || !ordersPath || !linesPath) {
  console.error("Usage: node scripts/import-legacy-archive.mjs <mapping.json> <orders-file> <lines-file>");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const ORDER_FIELDS = new Set([
  "orderNumber", "salesOrderNumber", "saleDate", "customerCode", "customerName",
  "companyName", "email", "phone", "phone2", "address", "city", "state", "zip",
  "grandTotal", "taxTotal",
]);
const LINE_FIELDS = new Set([
  "orderNumber", "lineNumber", "sku", "description", "lineTotal", "vendor",
  "vendorSku", "manufacturer", "misc1", "misc2", "misc3", "misc4", "misc5",
]);
const DECIMAL_FIELDS = new Set(["grandTotal", "taxTotal", "lineTotal"]);
const INT_FIELDS = new Set(["lineNumber"]);

function loadMapping(p) {
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!cfg.order || !cfg.line) throw new Error("Mapping needs `order` and `line` sections");
  for (const [section, valid] of [["order", ORDER_FIELDS], ["line", LINE_FIELDS]]) {
    for (const target of Object.values(cfg[section])) {
      if (!valid.has(target)) throw new Error(`Unknown ${section} target field "${target}"`);
    }
    if (!Object.values(cfg[section]).includes("orderNumber")) {
      throw new Error(`The ${section} mapping must map some column to orderNumber`);
    }
  }
  return { delimiter: cfg.delimiter ?? "\t", dateFormat: cfg.dateFormat ?? "iso", ...cfg };
}

function openLines(file) {
  let stream = fs.createReadStream(file);
  if (file.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

function parseDate(value, format) {
  if (!value || !value.trim()) return null;
  let d;
  if (format === "mdY") {
    const [m, day, y] = value.split(/[/-]/).map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(value);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDecimal(value) {
  if (value === undefined || value === null || value.trim() === "") return null;
  const n = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function mapRow(headers, cells, mapping, cfg) {
  const out = {};
  for (const [src, target] of Object.entries(mapping)) {
    const idx = headers.indexOf(src);
    if (idx === -1) continue;
    const raw = cells[idx]?.trim() ?? "";
    if (target === "saleDate") {
      out[target] = parseDate(raw, cfg.dateFormat);
    } else if (DECIMAL_FIELDS.has(target)) {
      out[target] = parseDecimal(raw);
    } else if (INT_FIELDS.has(target)) {
      const n = Number.parseInt(raw, 10);
      out[target] = Number.isNaN(n) ? null : n;
    } else {
      out[target] = raw || null;
    }
  }
  return out;
}

async function readFileRows(file, mapping, cfg) {
  const rows = [];
  let headers = null;
  for await (const line of openLines(file)) {
    if (line.trim() === "") continue;
    const cells = line.split(cfg.delimiter);
    if (!headers) {
      headers = cells.map((h) => h.trim());
      continue;
    }
    rows.push(mapRow(headers, cells, mapping, cfg));
  }
  return rows;
}

const BATCH = 500;

async function main() {
  const cfg = loadMapping(mappingPath);
  const log = await prisma.legacyImportLog.create({
    data: { sourceFile: path.basename(ordersPath), triggeredBy: process.env.USER ?? "script" },
  });
  const errors = [];

  console.log("Reading orders file...");
  const orderRows = (await readFileRows(ordersPath, cfg.order, cfg)).filter((r) => {
    if (!r.orderNumber) {
      errors.push("Order row missing orderNumber — skipped");
      return false;
    }
    return true;
  });
  console.log(`Parsed ${orderRows.length} orders. Reading lines file...`);
  const lineRows = (await readFileRows(linesPath, cfg.line, cfg)).filter((r) => r.orderNumber);
  const linesByOrder = new Map();
  for (const l of lineRows) {
    const list = linesByOrder.get(l.orderNumber) ?? [];
    list.push(l);
    linesByOrder.set(l.orderNumber, list);
  }
  console.log(`Parsed ${lineRows.length} lines across ${linesByOrder.size} orders. Loading...`);

  let ordersLoaded = 0;
  let linesLoaded = 0;
  for (let i = 0; i < orderRows.length; i += BATCH) {
    const batch = orderRows.slice(i, i + BATCH);
    await prisma.$transaction(
      async (tx) => {
        for (const row of batch) {
          const { orderNumber, ...fields } = row;
          const order = await tx.legacyOrder.upsert({
            where: { orderNumber },
            create: { orderNumber, ...fields },
            update: fields,
            select: { id: true },
          });
          const lines = linesByOrder.get(orderNumber) ?? [];
          await tx.legacyOrderLine.deleteMany({ where: { legacyOrderId: order.id } });
          if (lines.length > 0) {
            await tx.legacyOrderLine.createMany({
              data: lines.map(({ orderNumber: _on, ...lf }) => ({
                legacyOrderId: order.id,
                ...lf,
              })),
            });
            linesLoaded += lines.length;
          }
          ordersLoaded += 1;
        }
      },
      { timeout: 120_000 },
    );
    console.log(`  ${Math.min(i + BATCH, orderRows.length)}/${orderRows.length} orders`);
  }

  await prisma.legacyImportLog.update({
    where: { id: log.id },
    data: { finishedAt: new Date(), ordersLoaded, linesLoaded, errors: errors.slice(0, 100) },
  });
  console.log(`Done: ${ordersLoaded} orders, ${linesLoaded} lines, ${errors.length} skipped rows.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
