// /app/src/pages/api/reports/sales-by-salesperson/export.ts
//
// CSV export for the sales-by-salesperson report. Streams either the
// grouped totals (level=group, default) or the line-item drill-down
// (level=items) so HR can drop the file into Excel without manual
// copy-paste.
//
// Data loading delegates to the shared report lib
// (src/lib/reports/salesBySalespersonReport.ts) — the same source of
// truth the App Router page + tRPC procedures use. This endpoint stays
// a REST download (a browser file download can't ride tRPC), so it
// owns its own session read + query parsing here.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { formatMarginPct } from "@/lib/marginMath";
import { csvRow } from "@/lib/csvExport";
import { getAppSettings } from "@/lib/appSettings";
import { parseStandardQuery } from "@/lib/salesBySalesperson";
import {
  getSalesBySalesperson,
  getSalesBySalespersonItems,
  type SalesByGroupResponse,
  type SalesByGroupItem,
  type SalesBySalespersonAuth,
} from "@/lib/reports/salesBySalespersonReport";

type Level = "group" | "items";

function parseLevel(raw: unknown): Level {
  return raw === "items" ? "items" : "group";
}

function groupHeaderLabel(groupBy: string): string {
  if (groupBy === "department") return "Department";
  if (groupBy === "customer") return "Customer";
  return "Salesperson";
}

function buildHeader(req: NextApiRequest, groupBy: string, brand: string): string {
  const startDate = (req.query.startDate as string) || "";
  const endDate = (req.query.endDate as string) || "";
  const departmentNames = (req.query.departmentNames as string) || "";
  const includeDeliveryFreight =
    req.query.includeDeliveryFreight === "1" || req.query.includeDeliveryFreight === "true";
  let csv = "";
  csv += csvRow([`${brand} — Sales by ${groupBy}`]);
  csv += csvRow([`Date range: ${startDate || "(start)"} to ${endDate || "(end)"}`]);
  if (departmentNames) {
    csv += csvRow([`Department filter: ${departmentNames.split(",").join(", ")}`]);
  }
  csv += csvRow([`Delivery & freight: ${includeDeliveryFreight ? "INCLUDED" : "excluded"}`]);
  csv += "\n";
  return csv;
}

function buildGroupCsv(data: SalesByGroupResponse): string {
  let csv = "";
  csv += csvRow([groupHeaderLabel(data.groupBy), "Items", "Retail", "Cost", "Margin", "Margin %"]);
  for (const r of data.rows) {
    csv += csvRow([
      r.groupLabel,
      r.itemCount,
      r.retail.toFixed(2),
      r.cost.toFixed(2),
      r.margin.toFixed(2),
      formatMarginPct(r.marginPct),
    ]);
  }
  csv += csvRow([
    "TOTAL",
    data.total.itemCount,
    data.total.retail.toFixed(2),
    data.total.cost.toFixed(2),
    data.total.margin.toFixed(2),
    formatMarginPct(data.total.marginPct),
  ]);
  return csv;
}

function buildItemsCsv(items: SalesByGroupItem[]): string {
  let csv = "";
  csv += csvRow([
    "Order #",
    "Order Date",
    "Customer",
    "Salesperson",
    "Department",
    "Part #",
    "Product",
    "Qty",
    "Retail",
    "Cost",
    "Margin",
    "Margin %",
    "Split",
  ]);
  for (const i of items) {
    csv += csvRow([
      i.orderno,
      i.orderDate ? i.orderDate.slice(0, 10) : "",
      i.customerLabel,
      i.salesPersonName ?? "",
      i.departmentName ?? "",
      i.partNo ?? "",
      i.productName ?? "",
      i.qty,
      i.retail.toFixed(2),
      i.cost.toFixed(2),
      i.margin.toFixed(2),
      formatMarginPct(i.marginPct),
      i.isSplit ? "yes" : "",
    ]);
  }
  return csv;
}

function buildFilename(level: Level, groupBy: string, startDate: string, endDate: string): string {
  const stamp = `${startDate || "all"}_to_${endDate || "all"}`.replaceAll(/[^a-zA-Z0-9_-]/g, "");
  const base =
    level === "items" ? `sales-items_${groupBy}_${stamp}` : `sales-by-${groupBy}_${stamp}`;
  return `${base}.csv`;
}

/**
 * resolveSalesPersonFilter (inside the report lib) reads `session.role` and
 * `session.user.id`. getServerSession surfaces both via the next-auth callbacks
 * in this app, so pull them off here for the lib's auth param.
 */
function sessionAuth(session: Session): SalesBySalespersonAuth {
  return {
    role: (session as { role?: string }).role,
    userId: (session.user as { id?: string } | undefined)?.id,
  };
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
    const groupBy = (req.query.groupBy as string) || "salesperson";
    const startDate = (req.query.startDate as string) || "";
    const endDate = (req.query.endDate as string) || "";

    const parsed = parseStandardQuery(req);
    const auth = sessionAuth(session);

    const settings = await getAppSettings();
    const brand = settings.companyName || settings.appName;
    let csv = buildHeader(req, groupBy, brand);
    if (level === "items") {
      const groupKey = typeof req.query.groupKey === "string" ? req.query.groupKey : "";
      const items = await getSalesBySalespersonItems(prisma, {
        auth,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        groupBy: parsed.groupBy,
        salesPersonIds: parsed.requestedSalesPersonIds,
        departmentNames: parsed.departmentNames,
        includeDeliveryFreight: parsed.includeDeliveryFreight,
        groupKey,
      });
      csv += buildItemsCsv(items);
    } else {
      const data = await getSalesBySalesperson(prisma, {
        auth,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        groupBy: parsed.groupBy,
        salesPersonIds: parsed.requestedSalesPersonIds,
        departmentNames: parsed.departmentNames,
        includeDeliveryFreight: parsed.includeDeliveryFreight,
      });
      csv += buildGroupCsv(data);
    }

    const filename = buildFilename(level, groupBy, startDate, endDate);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    logError("sales-by-salesperson/export failed", err);
    const message = err instanceof Error ? err.message : "Export failed";
    return res.status(500).json({ error: message });
  }
}
