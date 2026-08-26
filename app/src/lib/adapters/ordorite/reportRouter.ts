// /app/src/lib/adapters/ordorite/reportRouter.ts
//
// Maps Ordorite report filenames to their corresponding import runner
// functions. Unknown filenames are returned as null so the orchestrator
// can log them as skipped.

import {
  runSalesImport,
  runQuotesImport,
  runDepositsImport,
  runPurchaseOrdersImport,
  runStockByItemImport,
  runPaymentsImport,
  runInvoicesImport,
  runCustomerImport,
  runReceivedItemsImport,
  runInboundItemsImport,
  runTempItemsImport,
  runPOLineExportImport,
  runProductsImport,
} from "@/lib/adapters/ordorite/runners";

interface RouteEntry {
  // A report Ordorite names the same way for every customer.
  pattern?: RegExp;
  // A report the DEPLOYING ORG named after itself: `<Org>_Stock_by_Item.csv`.
  // Ordorite lets the owner choose export filenames, so the prefix is a
  // deployment fact, not a vendor constant (CLAUDE.md 61-63) -- it comes from
  // ORDORITE_REPORT_PREFIX, which accepts a comma-separated list because one
  // deployment routinely uses several (a full name for some reports, an
  // initialism for others).
  //
  // Matched ANCHORED, with the prefix OPTIONAL. Anchoring is the point: an
  // earlier version matched `.+_Customers` unanchored, which quietly routed
  // `Deleted_Customers.csv` and `Vendor_Stock_by_Item.csv` into master-data
  // imports that had previously returned null. A router that cannot positively
  // identify a file must refuse it, not guess.
  orgReport?: string;
  // Set when the prefix is REQUIRED rather than optional -- true only where an
  // unprefixed route of the same name exists and means something else. Without
  // a configured prefix these never match, so the bare route wins.
  orgPrefixRequired?: boolean;
  importType: string;
  runner: (data: Record<string, unknown>[], createdBy?: string) => Promise<unknown>;
  // stock-by-item wraps records in { records: [...] } -- the runner accepts
  // the inner array directly, but the CSV rows need no wrapping.
  wrapKey?: string;
}

const REPORT_ROUTES: RouteEntry[] = [
  {
    pattern: /Prior_Day_Sales_Data_Export/i,
    importType: "sales",
    runner: runSalesImport,
  },
  {
    pattern: /Daily_Quote_Report/i,
    importType: "quotes",
    runner: runQuotesImport,
  },
  {
    pattern: /Customer_Deposits_Export/i,
    importType: "deposits",
    runner: runDepositsImport,
  },
  {
    orgReport: "Stock_by_Item",
    importType: "stock",
    runner: runStockByItemImport,
  },
  {
    pattern: /Prior_Day_Received_Items/i,
    importType: "received-items",
    runner: runReceivedItemsImport,
  },
  {
    // Matches both legacy `Prior_Day_Temp_Items` AND post-2026-05-20
    // rename to `Prior_Day_Temp_Purchase_Orders` — owner renamed the
    // Ordorite report so it scopes to new (prior-day) data only.
    // Both filenames carry the same data shape (temp purchase orders);
    // runTempItemsImport handles both.
    pattern: /Prior_Day_Temp_(Items|Purchase_Orders)/i,
    importType: "temp-items",
    runner: runTempItemsImport,
  },
  {
    orgReport: "Purchase_Order_Line_Export",
    importType: "po-lines",
    runner: runPOLineExportImport,
  },
  {
    // `<Org>_Inbound_Items` and a bare `Inbound_Items` are DIFFERENT reports
    // with different runners, so this one needs a real prefix to fire.
    orgReport: "Inbound_Items",
    orgPrefixRequired: true,
    importType: "inbound-items",
    runner: runInboundItemsImport,
  },
  {
    pattern: /Inbound_Items/i,
    importType: "purchase-orders",
    runner: runPurchaseOrdersImport,
  },
  {
    pattern: /Prior_Day_POR_Export/i,
    importType: "purchase-orders",
    runner: runPurchaseOrdersImport,
  },
  {
    pattern: /Prior_Day_Payments_Export/i,
    importType: "payments",
    runner: runPaymentsImport,
  },
  {
    pattern: /Prior_Day_Invoice_Export/i,
    importType: "invoices",
    runner: runInvoicesImport,
  },
  {
    // Matches both the legacy `<Org>_Customers` AND the post-2026-05-20
    // rename to `<Org>_Prior_Day_Customers` — the owner renamed the
    // Ordorite report so it scopes to new (prior-day) data only.
    // Both filenames carry the same data shape (customer master);
    // runCustomerImport handles both.
    orgReport: "(?:Prior_Day_)?Customers",
    importType: "customers",
    runner: runCustomerImport,
  },
  {
    // Daily product master from Ordorite, added 2026-05-26. Replaces
    // the historical manual upload at /admin/import/ordorite-products
    // for routine refreshes — the manual page still exists for ad-hoc
    // bulk imports. Filename: `<Org>_Item_Export.csv` (~100K rows). All
    // rows in the export are Active=yes; discontinued products are
    // simply absent. The runner self-chunks 500 rows per batch.
    orgReport: "Item_Export",
    importType: "products",
    runner: runProductsImport,
  },
];

// Filenames to silently skip (redundant reports)
const SKIP_PATTERNS: RegExp[] = [
  /Inbound_Customer_Orders/i,
  /Inbound_Stock\.csv$/i,
  /Marjan_Daily_Sales/i,
  // Daily Sales Detail Export has a different format than Prior Day Sales;
  // only the Prior Day Sales export is used for automated sales imports.
  /Daily_Sales_Detail_Export/i,
];

export interface ResolvedRoute {
  importType: string;
  runner: (data: Record<string, unknown>[], createdBy?: string) => Promise<unknown>;
}

/**
 * Alternation of the deploying org's report-name prefixes, or null when none
 * is configured.
 *
 * Comma-separated because a single deployment commonly uses more than one --
 * a full name on some exports and an initialism on others. A scalar could not
 * express that, and regex-escaping meant an operator could not smuggle one in
 * as `A|B` either: pinning the prefix silently unrouted every report under the
 * other one.
 */
function orgPrefixAlternation(): string | null {
  const parts = (process.env.ORDORITE_REPORT_PREFIX ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return parts.length ? `(?:${parts.join("|")})` : null;
}

function patternFor(route: RouteEntry, prefixAlt: string | null): RegExp | null {
  if (route.pattern) return route.pattern;
  if (prefixAlt) return new RegExp(`^${prefixAlt}_(?:${route.orgReport})`, "i");
  // No prefix configured. A required-prefix route cannot fire at all; the rest
  // still match their bare name, so an org that does not prefix its exports
  // works with no configuration.
  if (route.orgPrefixRequired) return null;
  return new RegExp(`^(?:${route.orgReport})`, "i");
}

export function resolveImportRoute(filename: string): ResolvedRoute | "skip" | null {
  // Check if this is a known-redundant file
  for (const skip of SKIP_PATTERNS) {
    if (skip.test(filename)) return "skip";
  }

  // Anchored matching is on the base name, so a directory component cannot
  // stand in for the org prefix (`.` matches `/`).
  const base = filename.split("/").pop() ?? filename;
  const prefixAlt = orgPrefixAlternation();
  for (const route of REPORT_ROUTES) {
    const pattern = patternFor(route, prefixAlt);
    if (pattern && pattern.test(base)) {
      return { importType: route.importType, runner: route.runner };
    }
  }

  return null;
}
