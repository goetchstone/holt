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
  pattern: RegExp;
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
    pattern: /SH_Stock_by_Item/i,
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
    pattern: /SH_Purchase_Order_Line_Export/i,
    importType: "po-lines",
    runner: runPOLineExportImport,
  },
  {
    pattern: /Saybrook_Home_Inbound_Items/i,
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
    // Matches both legacy `Saybrook_Home_Customers` AND post-2026-05-20
    // rename to `Saybrook_Home_Prior_Day_Customers` — owner renamed the
    // Ordorite report so it scopes to new (prior-day) data only.
    // Both filenames carry the same data shape (customer master);
    // runCustomerImport handles both.
    pattern: /Saybrook_Home_(Prior_Day_)?Customers/i,
    importType: "customers",
    runner: runCustomerImport,
  },
  {
    // Daily product master from Ordorite, added 2026-05-26. Replaces
    // the historical manual upload at /admin/import/ordorite-products
    // for routine refreshes — the manual page still exists for ad-hoc
    // bulk imports. Filename: `SH_Item_Export.csv` (~100K rows). All
    // rows in the export are Active=yes; discontinued products are
    // simply absent. The runner self-chunks 500 rows per batch.
    pattern: /SH_Item_Export/i,
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

export function resolveImportRoute(filename: string): ResolvedRoute | "skip" | null {
  // Check if this is a known-redundant file
  for (const skip of SKIP_PATTERNS) {
    if (skip.test(filename)) return "skip";
  }

  for (const route of REPORT_ROUTES) {
    if (route.pattern.test(filename)) {
      return { importType: route.importType, runner: route.runner };
    }
  }

  return null;
}
