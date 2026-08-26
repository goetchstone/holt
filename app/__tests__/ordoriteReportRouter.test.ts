// /app/__tests__/ordoriteReportRouter.test.ts

import { resolveImportRoute } from "@/lib/adapters/ordorite/reportRouter";

describe("resolveImportRoute", () => {
  // Two prefixes, because that is what a real deployment looks like: a full
  // name on some exports and an initialism on others. Every org-report case
  // below therefore also proves the alternation works -- a single-value knob
  // would route one family and silently drop the other.
  const ORIGINAL_PREFIX = process.env.ORDORITE_REPORT_PREFIX;
  beforeAll(() => {
    process.env.ORDORITE_REPORT_PREFIX = "Riverbend_Home,SH";
  });
  afterAll(() => {
    if (ORIGINAL_PREFIX === undefined) delete process.env.ORDORITE_REPORT_PREFIX;
    else process.env.ORDORITE_REPORT_PREFIX = ORIGINAL_PREFIX;
  });

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

  // The org prefix is a deployment fact, not a constant.
  describe("org report prefix is configuration", () => {
    // Restore the SUITE's value, not the module-load value -- the outer
    // beforeAll has already set it, and clearing it here instead would leave
    // every later describe running unconfigured.
    afterEach(() => {
      process.env.ORDORITE_REPORT_PREFIX = "Riverbend_Home,SH";
    });
    const typeOf = (f: string) => {
      const r = resolveImportRoute(f);
      return r === null ? null : r === "skip" ? "skip" : (r as { importType: string }).importType;
    };

    it("routes a different org's prefix identically", () => {
      process.env.ORDORITE_REPORT_PREFIX = "Acme_Furniture,ACME";
      expect(typeOf("Acme_Furniture_Inbound_Items.csv")).toBe("inbound-items");
      expect(typeOf("Acme_Furniture_Prior_Day_Customers.csv")).toBe("customers");
      expect(typeOf("ACME_Item_Export.csv")).toBe("products");
      expect(typeOf("ACME_Stock_by_Item.csv")).toBe("stock");
    });

    // A deployment routinely uses more than one prefix. A scalar knob could not
    // say so, and escaping meant "A|B" could not be smuggled in either -- so
    // pinning the prefix unrouted every report filed under the other one.
    it("accepts a list, and needs one when the org uses two prefixes", () => {
      process.env.ORDORITE_REPORT_PREFIX = "Riverbend_Home";
      expect(typeOf("Riverbend_Home_Inbound_Items.csv")).toBe("inbound-items");
      expect(typeOf("SH_Stock_by_Item.csv")).toBeNull();

      process.env.ORDORITE_REPORT_PREFIX = "Riverbend_Home,SH";
      expect(typeOf("Riverbend_Home_Inbound_Items.csv")).toBe("inbound-items");
      expect(typeOf("SH_Stock_by_Item.csv")).toBe("stock");
      expect(typeOf("SH_Item_Export.csv")).toBe("products");
      expect(typeOf("SH_Purchase_Order_Line_Export.csv")).toBe("po-lines");
    });

    it("narrows to the pinned prefix -- another org's file is not an org report", () => {
      process.env.ORDORITE_REPORT_PREFIX = "Acme_Furniture";
      expect(typeOf("Other_Co_Inbound_Items.csv")).toBe("purchase-orders");
      expect(typeOf("Other_Co_Customers.csv")).toBeNull();
    });

    // The regression that made anchoring necessary: an unanchored `.+_Customers`
    // sent anything ending in the report name into a master-data import, where
    // before it returned null and an operator saw an unrouted file.
    it("refuses a look-alike rather than guessing it is an org report", () => {
      for (const prefix of ["Riverbend_Home,SH", undefined]) {
        if (prefix === undefined) delete process.env.ORDORITE_REPORT_PREFIX;
        else process.env.ORDORITE_REPORT_PREFIX = prefix;
        for (const f of [
          "Deleted_Customers.csv",
          "Inactive_Customers.csv",
          "Marjan_Customers.csv",
          "Vendor_Stock_by_Item.csv",
          "Q3_Customers_Report.csv",
        ]) {
          expect(typeOf(f)).toBeNull();
        }
        // A directory component must not stand in for the org prefix.
        expect(typeOf("archive/2025/Old_Customers.csv")).toBeNull();
      }
    });

    // Unconfigured, an org that does not prefix its exports still works, and
    // the prefix-required route stands down so the bare route keeps its meaning.
    it("falls back to bare report names when nothing is configured", () => {
      delete process.env.ORDORITE_REPORT_PREFIX;
      expect(typeOf("Customers.csv")).toBe("customers");
      expect(typeOf("Stock_by_Item.csv")).toBe("stock");
      expect(typeOf("Item_Export.csv")).toBe("products");
      expect(typeOf("Inbound_Items.csv")).toBe("purchase-orders");
      expect(typeOf("Riverbend_Home_Inbound_Items.csv")).toBe("purchase-orders");
    });
  });

  describe("route order (Riverbend_Home_Inbound_Items before Inbound_Items)", () => {
    it("Riverbend_Home_Inbound_Items matches inbound-items, not purchase-orders", () => {
      const result = resolveImportRoute("Riverbend_Home_Inbound_Items.csv");
      expect((result as { importType: string }).importType).toBe("inbound-items");
    });
  });
});
