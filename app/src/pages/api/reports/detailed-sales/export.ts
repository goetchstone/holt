// /app/src/pages/api/reports/detailed-sales/export.ts
//
// CSV export for the Detailed Sales report. Mirrors the shape of
// sales-by-salesperson/export.ts so the surfaces are consistent.
//
// Supports two levels:
//   level=group  — rolled rows (store|dept|cat|vendor)
//   level=items  — drilldown line items
//
// Pivot toggle is for in-page UX only; the rolled rows already carry
// every dimension so a single export covers both pivots.
//
// Data loading delegates to the shared report lib
// (src/lib/reports/detailedSales.ts) — the same source of truth the App Router
// page + tRPC procedures use. This endpoint stays a REST download (a browser
// file download can't ride tRPC), so it owns its own session read + query
// parsing here.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { csvRow } from "@/lib/csvExport";
import { getAppSettings } from "@/lib/appSettings";
import {
  getDetailedSales,
  getDetailedSalesItems,
  type DetailedSalesRow,
  type DetailedSalesItem,
} from "@/lib/reports/detailedSales";

type Level = "group" | "items";

function parseLevel(raw: unknown): Level {
  return raw === "items" ? "items" : "group";
}

function splitCsvParam(raw: unknown): string[] {
  return typeof raw === "string" ? raw.split(",").filter(Boolean) : [];
}

function buildHeader(req: NextApiRequest, brand: string): string {
  const startDate = (req.query.startDate as string) || "";
  const endDate = (req.query.endDate as string) || "";
  const departmentNames = (req.query.departments as string) || "";
  const storeNames = (req.query.stores as string) || "";
  const vendorNames = (req.query.vendors as string) || "";
  let csv = "";
  csv += csvRow([`${brand} — Detailed Sales`]);
  csv += csvRow([`Date range: ${startDate || "(start)"} to ${endDate || "(end)"}`]);
  if (storeNames) {
    csv += csvRow([`Store filter: ${storeNames.split(",").join(", ")}`]);
  }
  if (departmentNames) {
    csv += csvRow([`Department filter: ${departmentNames.split(",").join(", ")}`]);
  }
  if (vendorNames) {
    csv += csvRow([`Vendor filter: ${vendorNames.split(",").join(", ")}`]);
  }
  csv += "\n";
  return csv;
}

function buildGroupCsv(rows: DetailedSalesRow[]): string {
  let csv = "";
  csv += csvRow([
    "Store",
    "Department",
    "Category",
    "Vendor",
    "Items",
    "Net Sales",
    "Tax",
    "Total",
  ]);
  let totalItems = 0;
  let totalNet = 0;
  let totalTax = 0;
  for (const r of rows) {
    csv += csvRow([
      r.storeLocation,
      r.department,
      r.category,
      r.vendor,
      r.itemCount,
      r.netSales.toFixed(2),
      r.taxCollected.toFixed(2),
      (r.netSales + r.taxCollected).toFixed(2),
    ]);
    totalItems += r.itemCount;
    totalNet += r.netSales;
    totalTax += r.taxCollected;
  }
  csv += csvRow([
    "TOTAL",
    "",
    "",
    "",
    totalItems,
    totalNet.toFixed(2),
    totalTax.toFixed(2),
    (totalNet + totalTax).toFixed(2),
  ]);
  return csv;
}

function buildItemsCsv(items: DetailedSalesItem[]): string {
  let csv = "";
  csv += csvRow([
    "Order #",
    "Order Date",
    "Customer",
    "Store",
    "Department",
    "Category",
    "Type",
    "Vendor",
    "Part #",
    "Product",
    "Qty",
    "Net",
    "Tax",
    "Total",
  ]);
  for (const i of items) {
    csv += csvRow([
      i.orderno,
      i.orderDate ? i.orderDate.slice(0, 10) : "",
      i.customerName ?? "",
      i.storeLocation ?? "",
      i.departmentName ?? "",
      i.categoryName ?? "",
      i.typeName ?? "",
      i.vendorName ?? "",
      i.partNo ?? "",
      i.productName ?? "",
      i.orderedQuantity,
      i.netPrice.toFixed(2),
      i.vatAmount.toFixed(2),
      (i.netPrice + i.vatAmount).toFixed(2),
    ]);
  }
  return csv;
}

function buildFilename(level: Level, startDate: string, endDate: string): string {
  const stamp = `${startDate || "all"}_to_${endDate || "all"}`.replaceAll(/[^a-zA-Z0-9_-]/g, "");
  const base = level === "items" ? `detailed-sales-items_${stamp}` : `detailed-sales_${stamp}`;
  return `${base}.csv`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end("Method Not Allowed");
  }

  try {
    const level = parseLevel(req.query.level);
    const startDate = (req.query.startDate as string) || "";
    const endDate = (req.query.endDate as string) || "";

    const settings = await getAppSettings();
    const brand = settings.companyName || settings.appName;
    let csv = buildHeader(req, brand);
    if (level === "items") {
      const items = await getDetailedSalesItems(prisma, {
        store: typeof req.query.store === "string" ? req.query.store : null,
        department: typeof req.query.department === "string" ? req.query.department : null,
        category: typeof req.query.category === "string" ? req.query.category : null,
        vendor: typeof req.query.vendor === "string" ? req.query.vendor : null,
        type: typeof req.query.type === "string" ? req.query.type : null,
        startDate: startDate || null,
        endDate: endDate || null,
      });
      csv += buildItemsCsv(items);
    } else {
      const rows = await getDetailedSales(prisma, {
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        departments: splitCsvParam(req.query.departments),
        stores: splitCsvParam(req.query.stores),
        vendors: splitCsvParam(req.query.vendors),
      });
      csv += buildGroupCsv(rows);
    }

    const filename = buildFilename(level, startDate, endDate);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    logError("detailed-sales/export failed", err);
    const message = err instanceof Error ? err.message : "Export failed";
    return res.status(500).json({ error: message });
  }
}
