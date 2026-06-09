// scripts/reimport-invoices-direct.js
//
// Runs inside the Docker container to re-import historical invoices.
// Handles order rewrites: "SBOM25445 - A" replaces "SBOM25445".
// If Memo is "SBOM25445", checks for rewrites (- A, - B, etc.) and
// links to the latest version.
//
// Usage:
//   docker cp combined_invoices.json furniture-configurator-app-1:/tmp/
//   docker exec furniture-configurator-app-1 node /app/reimport-invoices-direct.js

const { PrismaClient } = require("@prisma/client");

const BATCH_SIZE = 5000;
const REWRITE_SUFFIXES = [" - D", " - C", " - B", " - A"];

async function main() {
  const fs = require("fs");
  const inputFile = process.argv[2] || "/tmp/combined_invoices.json";

  if (!fs.existsSync(inputFile)) {
    console.error("File not found:", inputFile);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  console.log("Total rows:", data.length);

  const prisma = new PrismaClient();

  let created = 0;
  let updated = 0;
  let notFound = 0;
  let rewriteMatched = 0;
  let errors = 0;

  // Group by invoiceNo
  const groups = new Map();
  for (const row of data) {
    const invoiceNo = row["Invoice No"];
    if (!invoiceNo) continue;
    const invoiceDate = row["Invoice Date"]
      ? new Date(row["Invoice Date"])
      : null;
    if (!invoiceDate || isNaN(invoiceDate.getTime())) continue;

    const taxStr = String(row["Product/Service Sales Tax"] || "0").replace(
      /[$,]/g,
      "",
    );
    const taxAmount = parseFloat(taxStr) || 0;
    const memo = String(row["Memo"] || "").trim();

    const existing = groups.get(invoiceNo);
    if (existing) {
      existing.totalTax += taxAmount;
      if (memo && !existing.memos.includes(memo)) {
        existing.memos.push(memo);
      }
    } else {
      groups.set(invoiceNo, {
        invoiceDate,
        memos: memo ? [memo] : [],
        totalTax: taxAmount,
      });
    }
  }

  console.log("Unique invoices:", groups.size);

  // Pre-load all order numbers for fast lookup
  const allOrders = await prisma.salesOrder.findMany({
    select: { id: true, orderno: true },
  });
  const orderByNumber = new Map();
  for (const o of allOrders) {
    orderByNumber.set(o.orderno, o.id);
  }
  console.log("Orders in DB:", orderByNumber.size);

  // Resolve an order number. Always prefer the latest rewrite because
  // "- A" replaces the base, "- B" replaces "- A", etc. The invoice
  // belongs to whatever version was actually delivered.
  function resolveOrderId(memo) {
    const base = memo.split(" - ")[0].trim();

    // Try latest rewrite first (- D, - C, - B, - A)
    for (const suffix of REWRITE_SUFFIXES) {
      const rewrite = base + suffix;
      if (orderByNumber.has(rewrite)) {
        return { id: orderByNumber.get(rewrite), rewrite: true };
      }
    }

    // No rewrites — use the base order
    if (orderByNumber.has(base)) {
      return { id: orderByNumber.get(base), rewrite: false };
    }

    return null;
  }

  let batch = 0;
  const entries = [...groups.entries()];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    batch++;
    const chunk = entries.slice(i, i + BATCH_SIZE);
    console.log(
      "Batch " +
        batch +
        ": processing " +
        chunk.length +
        " invoices (" +
        i +
        "-" +
        (i + chunk.length) +
        ")...",
    );

    for (const [invoiceNo, group] of chunk) {
      try {
        if (group.memos.length === 0) {
          errors++;
          continue;
        }

        // Find best matching order across all memos on this invoice
        let salesOrderId = null;
        let wasRewrite = false;

        for (const memo of group.memos) {
          const result = resolveOrderId(memo);
          if (result) {
            salesOrderId = result.id;
            wasRewrite = result.rewrite;
            break;
          }
        }

        if (!salesOrderId) {
          notFound++;
          continue;
        }

        if (wasRewrite) rewriteMatched++;

        // Upsert invoice
        const existing = await prisma.invoice.findUnique({
          where: { invoiceNo },
        });

        if (existing) {
          await prisma.invoice.update({
            where: { invoiceNo },
            data: {
              invoiceDate: group.invoiceDate,
              taxAmount: group.totalTax,
              salesOrderId,
            },
          });
          updated++;
        } else {
          await prisma.invoice.create({
            data: {
              invoiceNo,
              invoiceDate: group.invoiceDate,
              taxAmount: group.totalTax,
              salesOrderId,
            },
          });
          created++;
        }
      } catch (err) {
        errors++;
      }
    }

    console.log(
      "  Running: created=" +
        created +
        " updated=" +
        updated +
        " rewrites=" +
        rewriteMatched +
        " notFound=" +
        notFound +
        " errors=" +
        errors,
    );
  }

  // Promote orders with invoices from ORDER/QUOTE to FULFILLED
  const promoteResult = await prisma.salesOrder.updateMany({
    where: {
      status: { in: ["QUOTE", "ORDER"] },
      invoices: { some: {} },
    },
    data: { status: "FULFILLED", updatedBy: "invoice-reimport" },
  });

  console.log("\n=== Final Results ===");
  console.log("Created:", created);
  console.log("Updated:", updated);
  console.log("Rewrite matches:", rewriteMatched);
  console.log("Not Found:", notFound);
  console.log("Errors:", errors);
  console.log("Orders Promoted to FULFILLED:", promoteResult.count);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
