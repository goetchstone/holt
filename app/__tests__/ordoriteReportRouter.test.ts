// /app/__tests__/ordoriteReportRouter.test.ts

import { resolveImportRoute } from "@/lib/adapters/ordorite/reportRouter";

describe("resolveImportRoute", () => {
  describe("sales and customer reports", () => {
    it("routes Prior_Day_Sales_Data_Export to sales", () => {
      const result = resolveImportRoute("Prior_Day_Sales_Data_Export.csv");
      expect(result).not.toBeNull();
      expect(result).not.toBe("skip");
      expect((result as { importType: string }).importType).toBe("sales");
    });

    it("routes Daily_Quote_Report to quotes", () => {
      const result = resolveImportRoute("Daily_Quote_Report.csv");
      expect(result).not.toBeNull();
      expect(result).not.toBe("skip");
      expect((result as { importType: string }).importType).toBe("quotes");
    });

    it("routes Customer_Deposits_Export to deposits", () => {
      const result = resolveImportRoute("Customer_Deposits_Export.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("deposits");
    });

    it("routes Riverbend_Home_Customers to customers", () => {
      const result = resolveImportRoute("Riverbend_Home_Customers.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("customers");
    });

    // 2026-05-20 rename: owner renamed the Ordorite customer export to
    // include "Prior_Day_" so it scopes to new data only. Router accepts
    // both old + new names — the org prefix is a config, so any prefix routes.
    it("routes Riverbend_Home_Prior_Day_Customers to customers (post-rename)", () => {
      const result = resolveImportRoute("Riverbend_Home_Prior_Day_Customers.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("customers");
    });
  });

  describe("purchasing and receiving reports", () => {
    it("routes Prior_Day_Received_Items to received-items", () => {
      const result = resolveImportRoute("Riverbend_Home_Prior_Day_Received_Items.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("received-items");
    });

    it("routes Prior_Day_Temp_Items to temp-items", () => {
      const result = resolveImportRoute("Riverbend_Home_Prior_Day_Temp_Items.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("temp-items");
    });

    // 2026-05-20 rename: owner renamed the Ordorite temp export from
    // "Temp_Items" to "Temp_Purchase_Orders". Router accepts both —
    // regex is /Prior_Day_Temp_(Items|Purchase_Orders)/i.
    it("routes Prior_Day_Temp_Purchase_Orders to temp-items (post-rename)", () => {
      const result = resolveImportRoute("Riverbend_Home_Prior_Day_Temp_Purchase_Orders.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("temp-items");
    });

    it("routes SH_Purchase_Order_Line_Export to po-lines", () => {
      const result = resolveImportRoute("SH_Purchase_Order_Line_Export.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("po-lines");
    });

    it("routes Riverbend_Home_Inbound_Items to inbound-items (not purchase-orders)", () => {
      const result = resolveImportRoute("Riverbend_Home_Inbound_Items.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("inbound-items");
    });

    it("routes generic Inbound_Items to purchase-orders", () => {
      const result = resolveImportRoute("Inbound_Items.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("purchase-orders");
    });

    it("routes Prior_Day_POR_Export to purchase-orders", () => {
      const result = resolveImportRoute("Prior_Day_POR_Export.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("purchase-orders");
    });
  });

  describe("other reports", () => {
    it("routes SH_Stock_by_Item to stock", () => {
      const result = resolveImportRoute("SH_Stock_by_Item.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("stock");
    });

    // 2026-05-26: daily product master from Ordorite — wires the SH Item
    // Export CSV through to runProductsImport so it refreshes the
    // product catalog automatically. Owner direction: "ensure this file
    // gets imported too during the automated gmail imports."
    it("routes SH_Item_Export to products", () => {
      const result = resolveImportRoute("SH_Item_Export.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("products");
    });

    // Tolerant of date suffix (owner often appends YYYY-MM-DD) and the
    // mixed "SH ITEM EXPORT" casing that appears in the email subject.
    it("routes SH_Item_Export with date suffix to products", () => {
      const result = resolveImportRoute("SH_Item_Export_2026-05-26.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("products");
    });

    it("routes SH_Item_Export to products case-insensitively", () => {
      const result = resolveImportRoute("sh_item_export.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("products");
    });

    it("routes Prior_Day_Payments_Export to payments", () => {
      const result = resolveImportRoute("Prior_Day_Payments_Export.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("payments");
    });

    it("routes Prior_Day_Invoice_Export to invoices", () => {
      const result = resolveImportRoute("Prior_Day_Invoice_Export.csv");
      expect(result).not.toBeNull();
      expect((result as { importType: string }).importType).toBe("invoices");
    });
  });

  describe("skip patterns", () => {
    it("skips Inbound_Customer_Orders", () => {
      expect(resolveImportRoute("Inbound_Customer_Orders.csv")).toBe("skip");
    });

    it("skips Inbound_Stock.csv", () => {
      expect(resolveImportRoute("Inbound_Stock.csv")).toBe("skip");
    });

    it("skips Marjan_Daily_Sales", () => {
      expect(resolveImportRoute("Marjan_Daily_Sales.csv")).toBe("skip");
    });

    it("skips Daily_Sales_Detail_Export", () => {
      expect(resolveImportRoute("Daily_Sales_Detail_Export.csv")).toBe("skip");
    });
  });

  describe("unknown files", () => {
    it("returns null for unrecognized filenames", () => {
      expect(resolveImportRoute("random_report.csv")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(resolveImportRoute("")).toBeNull();
    });
  });

  // The org prefix is a deployment fact, not a constant. Every fixture above
  // uses one made-up org; these prove the router is not keyed to it -- a second
  // org routes identically, and a deployment can pin its own prefix.
  describe("org report prefix is not hardcoded", () => {
    const ORIGINAL = process.env.ORDORITE_REPORT_PREFIX;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.ORDORITE_REPORT_PREFIX;
      else process.env.ORDORITE_REPORT_PREFIX = ORIGINAL;
    });

    it("routes a different org's prefix identically", () => {
      for (const [file, importType] of [
        ["Acme_Furniture_Inbound_Items.csv", "inbound-items"],
        ["Acme_Furniture_Prior_Day_Customers.csv", "customers"],
        ["ACME_Item_Export.csv", "products"],
        ["ACME_Stock_by_Item.csv", "stock"],
      ] as const) {
        const result = resolveImportRoute(file);
        expect(result).not.toBeNull();
        expect((result as { importType: string }).importType).toBe(importType);
      }
    });

    it("honours a pinned ORDORITE_REPORT_PREFIX", () => {
      process.env.ORDORITE_REPORT_PREFIX = "Acme_Furniture";
      expect(
        (resolveImportRoute("Acme_Furniture_Inbound_Items.csv") as { importType: string })
          .importType,
      ).toBe("inbound-items");
      // A pinned prefix narrows the match: another org's file falls through to
      // the unprefixed vendor-standard route rather than the org-report one.
      expect(
        (resolveImportRoute("Other_Co_Inbound_Items.csv") as { importType: string })
          .importType,
      ).toBe("purchase-orders");
    });
  });

  describe("route order (Riverbend_Home_Inbound_Items before Inbound_Items)", () => {
    it("Riverbend_Home_Inbound_Items matches inbound-items, not purchase-orders", () => {
      const result = resolveImportRoute("Riverbend_Home_Inbound_Items.csv");
      expect((result as { importType: string }).importType).toBe("inbound-items");
    });
  });
});
