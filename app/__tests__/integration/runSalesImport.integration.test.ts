// /app/__tests__/integration/runSalesImport.integration.test.ts
//
// PHASE 0.6.3 — real-DB integration tests for runSalesImport. The
// sales runner has been the source of multiple production incidents
// this year. Pure-helper tests catch some bug shapes; runner-level
// mocks couldn't catch the incidents because they happened at the
// SQL/Prisma boundary.
//
// Scenarios (each maps to a real prod incident or a regression
// guard for a recent fix):
//
//   1. PR #209 rewrite-freeze (2026-05-05): when a base order has a
//      sibling rewrite (`<orderno> - A`), orphan-cleanup is SKIPPED.
//      Otherwise re-imports with shrunk CSVs silently dropped lines
//      that legitimately stayed on the base.
//
//   2. PR #201 reactivation (2026-05-02): when a CSV provides a
//      lineNumber that's currently CANCELLED with NULL cancelReason
//      (= orphan-cancelled, not user-cancelled), the line is
//      reactivated to ACTIVE. User-cancelled lines (cancelReason
//      set) stay CANCELLED.
//
//   3. PR #210 isUntrustedMergeEmail (2026-05-05): when an incoming
//      CSV row has a company-domain email (COMPANY_EMAIL_DOMAIN),
//      findOrCreateCustomer does NOT merge into an existing customer
//      that happens to have the same staff email. Stores NULL email
//      on creation.
//
//   4. PR #216 name+email match tightening (2026-05-06): even with
//      a non-staff email, the email match requires the customer
//      name to also match. Email-only matches with a different
//      name fall through to the by-name lookup.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { runSalesImport } from "@/lib/adapters/ordorite/runners";

const ORDERNO = "SBOM38000";

// isUntrustedMergeEmail (lib/importHelpers.ts) is driven by the
// COMPANY_EMAIL_DOMAIN env var — the guard matches on the domain part
// of the email only, via substring. Pin it for this file so the
// staff-email scenarios behave deterministically, and restore the
// original value afterwards.
const COMPANY_DOMAIN = "holtco.example";
const STAFF_EMAIL = `joneil@${COMPANY_DOMAIN}`;
const ORIGINAL_COMPANY_DOMAIN = process.env.COMPANY_EMAIL_DOMAIN;

interface SalesCsvRow extends Record<string, unknown> {
  Orderno: string;
  Cuscode: string;
  Customer: string;
  Email: string;
  Orderdate: string;
  Company: string;
  Salesperson: string;
  "Part No": string;
  "Product Name": string;
  "Barcode No": string;
  Orderqty: number;
  netprice: number;
  cost: number;
  Vatrate: number;
  Vatamount: number;
}

function csvRow(overrides: Partial<SalesCsvRow> & { partNo: string }): SalesCsvRow {
  return {
    Orderno: ORDERNO,
    Cuscode: "SBCT99999",
    Customer: "Test Customer",
    Email: "test@example.com",
    Orderdate: "2026-04-21",
    Company: "Old Saybrook",
    Salesperson: "Kim Dransfield",
    "Part No": overrides.partNo,
    "Product Name": `Product ${overrides.partNo}`,
    "Barcode No": "",
    Orderqty: 1,
    netprice: 100,
    cost: 50,
    Vatrate: 0.0635,
    Vatamount: 6.35,
    ...overrides,
  };
}

describe("runSalesImport — real-DB scenarios", () => {
  beforeAll(() => {
    process.env.COMPANY_EMAIL_DOMAIN = COMPANY_DOMAIN;
  });

  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    if (ORIGINAL_COMPANY_DOMAIN === undefined) {
      delete process.env.COMPANY_EMAIL_DOMAIN;
    } else {
      process.env.COMPANY_EMAIL_DOMAIN = ORIGINAL_COMPANY_DOMAIN;
    }
    await prisma.$disconnect();
  });

  // ─── PR #209 rewrite-freeze ──────────────────────────────────────────

  describe("rewrite-freeze (PR #209)", () => {
    it("skips orphan-cleanup when a sibling rewrite exists", async () => {
      // Seed: base order with 5 lines + sibling rewrite "<orderno> - A".
      // The base order represents the historical 5/3 sale; the rewrite
      // captures whatever lines moved to a different cuscode/order on a
      // subsequent date. SBOM39275 hit this exact pattern in prod.
      const customer = await prisma.customer.create({
        data: { firstName: "Sandy", lastName: "Favale" },
      });
      await prisma.salesOrder.create({
        data: {
          orderno: ORDERNO,
          status: "ORDER",
          orderDate: new Date("2026-05-03"),
          customerId: customer.id,
          storeLocation: "Old Saybrook",
          salesperson: "Molly",
          lineItems: {
            create: [1, 2, 3, 4, 5].map((n) => ({
              lineNumber: n,
              partNo: `BASE-${n}`,
              productName: `Base item ${n}`,
              netPrice: 100,
              cost: 50,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE" as const,
            })),
          },
        },
      });
      // Create sibling rewrite — its content doesn't matter for this test;
      // its mere existence triggers the freeze in runSalesImport.
      await prisma.salesOrder.create({
        data: {
          orderno: `${ORDERNO} - A`,
          status: "ORDER",
          orderDate: new Date("2026-05-04"),
          customerId: customer.id,
          storeLocation: "Old Saybrook",
        },
      });

      // Re-import the base with only 2 lines (CSV legitimately shrunk
      // because the POS split the order at rewrite time).
      const csv = [
        csvRow({ partNo: "BASE-1", Customer: "Sandy Favale" }),
        csvRow({ partNo: "BASE-2", Customer: "Sandy Favale" }),
      ];
      const result = await runSalesImport(csv);

      expect(result.errors).toEqual([]);

      // The freeze MUST keep all 5 lines ACTIVE. Pre-fix behavior would
      // have cancelled lines 3, 4, 5.
      const lines = await prisma.orderLineItem.findMany({
        where: { salesOrder: { orderno: ORDERNO } },
        orderBy: { lineNumber: "asc" },
      });
      expect(lines).toHaveLength(5);
      expect(lines.every((l) => l.lineItemStatus === "ACTIVE")).toBe(true);
    });

    it("DOES orphan-cleanup when no rewrite sibling exists (control)", async () => {
      // Same shape as above but no rewrite sibling. Lines 3-5 must be
      // orphan-cancelled.
      const customer = await prisma.customer.create({
        data: { firstName: "Test", lastName: "Customer" },
      });
      await prisma.salesOrder.create({
        data: {
          orderno: ORDERNO,
          status: "ORDER",
          orderDate: new Date("2026-04-21"),
          customerId: customer.id,
          storeLocation: "Old Saybrook",
          lineItems: {
            create: [1, 2, 3, 4, 5].map((n) => ({
              lineNumber: n,
              partNo: `X-${n}`,
              productName: `X ${n}`,
              netPrice: 100,
              cost: 50,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE" as const,
            })),
          },
        },
      });

      const csv = [csvRow({ partNo: "X-1" }), csvRow({ partNo: "X-2" })];
      await runSalesImport(csv);

      const lines = await prisma.orderLineItem.findMany({
        where: { salesOrder: { orderno: ORDERNO } },
        orderBy: { lineNumber: "asc" },
      });
      expect(lines).toHaveLength(5);
      expect(lines[0].lineItemStatus).toBe("ACTIVE");
      expect(lines[1].lineItemStatus).toBe("ACTIVE");
      expect(lines[2].lineItemStatus).toBe("CANCELLED");
      expect(lines[3].lineItemStatus).toBe("CANCELLED");
      expect(lines[4].lineItemStatus).toBe("CANCELLED");
      // cancelReason is NULL on orphan-cleanup (distinguishes from user-cancel)
      expect(lines[2].cancelReason).toBeNull();
    });
  });

  // ─── PR #201 reactivation ────────────────────────────────────────────

  describe("orphan-cancelled line reactivation (PR #201)", () => {
    it("reactivates an orphan-cancelled line when CSV provides it again", async () => {
      const customer = await prisma.customer.create({
        data: { firstName: "Test", lastName: "Customer" },
      });
      // Seed: line 2 is orphan-cancelled (status=CANCELLED, cancelReason=null)
      await prisma.salesOrder.create({
        data: {
          orderno: ORDERNO,
          status: "ORDER",
          orderDate: new Date("2026-04-21"),
          customerId: customer.id,
          storeLocation: "Old Saybrook",
          lineItems: {
            create: [
              {
                lineNumber: 1,
                partNo: "Y-1",
                netPrice: 100,
                cost: 50,
                orderedQuantity: 1,
                lineItemStatus: "ACTIVE" as const,
              },
              {
                lineNumber: 2,
                partNo: "Y-2-orphaned",
                netPrice: 100,
                cost: 50,
                orderedQuantity: 1,
                lineItemStatus: "CANCELLED" as const,
                cancelReason: null,
              },
            ],
          },
        },
      });

      // CSV now provides 2 lines again (oscillation case from PR #201)
      const csv = [csvRow({ partNo: "Y-1" }), csvRow({ partNo: "Y-2-back" })];
      await runSalesImport(csv);

      const lines = await prisma.orderLineItem.findMany({
        where: { salesOrder: { orderno: ORDERNO } },
        orderBy: { lineNumber: "asc" },
      });
      expect(lines).toHaveLength(2);
      expect(lines[1].lineItemStatus).toBe("ACTIVE");
      expect(lines[1].partNo).toBe("Y-2-back");
    });

    it("does NOT reactivate a USER-cancelled line (cancelReason set)", async () => {
      const customer = await prisma.customer.create({
        data: { firstName: "Test", lastName: "Customer" },
      });
      // Seed: line 2 is USER-cancelled (cancelReason set)
      await prisma.salesOrder.create({
        data: {
          orderno: ORDERNO,
          status: "ORDER",
          orderDate: new Date("2026-04-21"),
          customerId: customer.id,
          storeLocation: "Old Saybrook",
          lineItems: {
            create: [
              {
                lineNumber: 1,
                partNo: "Z-1",
                netPrice: 100,
                cost: 50,
                orderedQuantity: 1,
                lineItemStatus: "ACTIVE" as const,
              },
              {
                lineNumber: 2,
                partNo: "Z-2-userCancelled",
                netPrice: 100,
                cost: 50,
                orderedQuantity: 1,
                lineItemStatus: "CANCELLED" as const,
                cancelReason: "Customer changed mind",
              },
            ],
          },
        },
      });

      // CSV provides line 2 — but it's user-cancelled, so it STAYS cancelled.
      const csv = [csvRow({ partNo: "Z-1" }), csvRow({ partNo: "Z-2-userCancelled" })];
      await runSalesImport(csv);

      const lines = await prisma.orderLineItem.findMany({
        where: { salesOrder: { orderno: ORDERNO } },
        orderBy: { lineNumber: "asc" },
      });
      expect(lines[1].lineItemStatus).toBe("CANCELLED");
      expect(lines[1].cancelReason).toBe("Customer changed mind");
    });
  });

  // ─── PR #210 + #216 isUntrustedMergeEmail + name match ──────────────

  describe("findOrCreateCustomer guards (PR #210, #216)", () => {
    it("does NOT merge into existing customer when incoming email is a company-domain staff email", async () => {
      // Seed an existing customer with a company-domain email (= a
      // historical merge seed, e.g. 'Sandy and David Favale' on a
      // staff member's email).
      const seed = await prisma.customer.create({
        data: {
          firstName: "Sandy and David",
          lastName: "Favale",
          email: STAFF_EMAIL,
        },
      });

      // Incoming sales row for a DIFFERENT customer using the same
      // staff email (the bug class — salesperson typed her own email).
      const csv = [
        csvRow({
          partNo: "M-1",
          Cuscode: "GTCT99001",
          Customer: "Different Person",
          Email: STAFF_EMAIL,
        }),
      ];
      await runSalesImport(csv);

      // The new customer must be a fresh row, not the seed.
      const order = await prisma.salesOrder.findUnique({
        where: { orderno: ORDERNO },
        select: { customerId: true },
      });
      expect(order?.customerId).not.toBe(seed.id);

      // The new customer's email must be NULL (untrusted email isn't
      // stored — would also trip the @unique constraint otherwise).
      const newCust = await prisma.customer.findUnique({
        where: { id: order!.customerId! },
      });
      expect(newCust?.firstName).toBe("Different");
      expect(newCust?.lastName).toBe("Person");
      expect(newCust?.email).toBeNull();
    });

    it("merges into existing customer when email AND name both match", async () => {
      const seed = await prisma.customer.create({
        data: {
          firstName: "Real",
          lastName: "Customer",
          email: "real@external.com",
        },
      });

      const csv = [
        csvRow({
          partNo: "M-2",
          Cuscode: "GTCT99002",
          Customer: "Real Customer",
          Email: "real@external.com",
        }),
      ];
      await runSalesImport(csv);

      const order = await prisma.salesOrder.findUnique({
        where: { orderno: ORDERNO },
        select: { customerId: true },
      });
      expect(order?.customerId).toBe(seed.id);
    });

    it("does NOT merge by email alone when name differs (PR #216 tightening)", async () => {
      // Marketing-staff donation incident: staffer used their personal
      // email on a non-profit donation entry. Later a sales row arrives
      // with same email but different name — must NOT merge.
      const seed = await prisma.customer.create({
        data: {
          firstName: "Marketing",
          lastName: "Staff",
          email: "marketing@example.com",
        },
      });

      const csv = [
        csvRow({
          partNo: "M-3",
          Cuscode: "GTCT99003",
          Customer: "Local Non-Profit",
          Email: "marketing@example.com",
        }),
      ];
      await runSalesImport(csv);

      const order = await prisma.salesOrder.findUnique({
        where: { orderno: ORDERNO },
        select: { customerId: true },
      });
      // Order must NOT route to the marketing-staff seed.
      expect(order?.customerId).not.toBe(seed.id);

      // The new customer is a fresh row with NO email (because the
      // email is taken by the seed; PR #214's pre-flight collision
      // check stores NULL rather than crashing).
      const newCust = await prisma.customer.findUnique({
        where: { id: order!.customerId! },
      });
      expect(newCust?.firstName).toBe("Local");
      expect(newCust?.lastName).toBe("Non-Profit");
      expect(newCust?.email).toBeNull();
    });

    // ─── 2026-05-16: late-hydrate names on existing customer-stub ───
    // User-reported: "We also have no customer names on some of the
    // orders too, we need to figure that out, they should come in."
    // Audit found 73 stuck anonymous Customer rows in prod with an
    // external id set + active orders + NULL firstName/lastName. Root
    // cause: when a sales CSV row first creates a stub (cuscode +
    // no customerName), then a later CSV row arrives with the real
    // name, the existing find-by-external-id branch returned the stub
    // unchanged. Only `phone` had a late-update branch; names did not.

    it("hydrates NULL firstName/lastName on existing stub when a later CSV provides the name", async () => {
      // Seed: a customer stub with an external id set + NULL name fields.
      // This is the shape that accumulates when sales imports race
      // ahead of customer imports.
      const stub = await prisma.customer.create({
        data: { phone: "860-555-0001" },
      });
      await prisma.customerExternalId.create({
        data: { externalId: "SBCT-LATE-HYDRATE", customerId: stub.id },
      });

      // Incoming sales row provides the real name. The cuscode match
      // hits the stub; the late-hydrate branch fills in the names.
      const csv = [
        csvRow({
          partNo: "M-HYDRATE-1",
          Cuscode: "SBCT-LATE-HYDRATE",
          Customer: "Jane Doe",
          Email: "",
        }),
      ];
      await runSalesImport(csv);

      const order = await prisma.salesOrder.findUnique({
        where: { orderno: ORDERNO },
        select: { customerId: true },
      });
      expect(order?.customerId).toBe(stub.id);

      const hydrated = await prisma.customer.findUnique({
        where: { id: stub.id },
      });
      expect(hydrated?.firstName).toBe("Jane");
      expect(hydrated?.lastName).toBe("Doe");
      // Phone was already set — must NOT be overwritten.
      expect(hydrated?.phone).toBe("860-555-0001");
    });

    it("does NOT overwrite existing firstName/lastName when CSV brings a different name on the same cuscode", async () => {
      // Conservative: an existing customer with names already filled
      // in must not be re-renamed by a later CSV. The late-hydrate
      // branch is opt-in only when the existing field is NULL.
      const customer = await prisma.customer.create({
        data: { firstName: "Real", lastName: "Customer" },
      });
      await prisma.customerExternalId.create({
        data: { externalId: "SBCT-NO-RENAME", customerId: customer.id },
      });

      const csv = [
        csvRow({
          partNo: "M-HYDRATE-2",
          Cuscode: "SBCT-NO-RENAME",
          Customer: "Different Name",
          Email: "",
        }),
      ];
      await runSalesImport(csv);

      const after = await prisma.customer.findUnique({
        where: { id: customer.id },
      });
      // Original names preserved — CSV's "Different Name" must NOT win.
      expect(after?.firstName).toBe("Real");
      expect(after?.lastName).toBe("Customer");
    });

    it("hydrates only the NULL half when one of firstName/lastName is already filled", async () => {
      // Edge case: a stub with firstName set but lastName NULL (or
      // vice versa). The branch should fill in the missing half
      // without disturbing the existing half.
      const stub = await prisma.customer.create({
        data: { firstName: "Madonna" },
      });
      await prisma.customerExternalId.create({
        data: { externalId: "SBCT-PARTIAL", customerId: stub.id },
      });

      const csv = [
        csvRow({
          partNo: "M-HYDRATE-3",
          Cuscode: "SBCT-PARTIAL",
          Customer: "Reborn Ciccone",
          Email: "",
        }),
      ];
      await runSalesImport(csv);

      const after = await prisma.customer.findUnique({
        where: { id: stub.id },
      });
      // firstName was already set — not overwritten.
      expect(after?.firstName).toBe("Madonna");
      // lastName was NULL — filled in from CSV.
      expect(after?.lastName).toBe("Ciccone");
    });
  });

  describe("post-import self-healing via backfillLineItemProductLinks (2026-05-15)", () => {
    // The CHOM1678 fix: a line first imported BEFORE its UPC was
    // registered used to get mis-linked to a fallback product (DELIVERY
    // CHARGE / Quote Placeholder) and the wrong link stuck because the
    // existing backfill only fixed NULL productIds. The runner now calls
    // backfillLineItemProductLinks with fixWrongLinks: true at the end
    // of every import, so timing-issue mis-links self-heal on the next
    // pass once the UPC arrives.
    //
    // Also: the runner no longer auto-creates stub products when the
    // barcode doesn't match a UPC — leaves productId NULL instead. The
    // backfill picks it up on the next import.

    it("leaves productId NULL when barcode doesn't match any UPC (no autoCreate fallback)", async () => {
      const orderno = "CHOM-TEST-NO-UPC";
      const row = csvRow({
        Orderno: orderno,
        "Part No": "",
        "Barcode No": "999999999999", // not in Upc table
        "Product Name": "Some Unknown Item",
        partNo: "",
      });

      const result = await runSalesImport([row]);
      expect(result.errors).toHaveLength(0);

      const order = await prisma.salesOrder.findUnique({
        where: { orderno },
        include: { lineItems: true },
      });
      expect(order?.lineItems).toHaveLength(1);
      expect(order!.lineItems[0].productId).toBeNull();
      // partNo falls back to barcode since CSV's Part No was empty
      expect(order!.lineItems[0].partNo).toBe("999999999999");
      expect(order!.lineItems[0].barcode).toBe("999999999999");
    });

    it("re-links a wrongly-linked productId when UPC arrives and import runs again", async () => {
      // Setup: simulate the CHOM1678 scenario. A line is wrongly linked
      // to a "DELIVERY CHARGE"-like canonical product. Then a UPC gets
      // registered pointing to the correct product. Running the sales
      // import again triggers the post-import backfill which re-links.

      // 1. Create the two products: a wrong-fallback "DELIVERY CHARGE"
      //    and the real product the UPC should point to.
      const vendor = await prisma.vendor.create({
        data: { name: "Test Vendor" },
      });
      const dept = await prisma.department.create({
        data: { name: "TestDept" },
      });
      const cat = await prisma.category.create({
        data: { name: "TestCat", department: { connect: { id: dept.id } } },
      });
      const wrongProduct = await prisma.product.create({
        data: {
          productNumber: "TEST-DELIVERY",
          name: "DELIVERY CHARGE",
          baseCost: 0,
          vendor: { connect: { id: vendor.id } },
          department: { connect: { id: dept.id } },
          category: { connect: { id: cat.id } },
        },
      });
      const realProduct = await prisma.product.create({
        data: {
          productNumber: "TEST-REAL-CHAIR",
          name: "Big Easy One Arm Chair",
          baseCost: 100,
          vendor: { connect: { id: vendor.id } },
          department: { connect: { id: dept.id } },
          category: { connect: { id: cat.id } },
        },
      });

      // 2. Create a SalesOrder + a line item wrongly linked to the
      //    DELIVERY CHARGE product. Mimic CHOM1678 line 2.
      const customer = await prisma.customer.create({
        data: { firstName: "Test", lastName: "Customer" },
      });
      const order = await prisma.salesOrder.create({
        data: {
          orderno: "CHOM-TEST-WRONG-LINK",
          orderDate: new Date("2026-04-30"),
          customerId: customer.id,
          status: "ORDER",
        },
      });
      const wrongLine = await prisma.orderLineItem.create({
        data: {
          salesOrderId: order.id,
          lineNumber: 1,
          partNo: "TEST-BARCODE-555",
          barcode: "TEST-BARCODE-555",
          productName: "DELIVERY CHARGE", // stamped from wrong product
          productId: wrongProduct.id, // WRONG link
          orderedQuantity: 1,
          netPrice: 1966.5,
          cost: 0,
        },
      });

      // 3. Register the UPC pointing to the correct product (simulating
      //    the POS syncing in the catalog entry later).
      await prisma.upc.create({
        data: {
          upc: "TEST-BARCODE-555",
          product: { connect: { id: realProduct.id } },
          source: "IMPORT",
        },
      });

      // 4. Now re-import the same sales row. The backfill call at the
      //    end of runSalesImport with fixWrongLinks: true should re-link
      //    the existing line to the correct product AND sync productName.
      const result = await runSalesImport([
        csvRow({
          Orderno: "CHOM-TEST-WRONG-LINK",
          partNo: "",
          "Barcode No": "TEST-BARCODE-555",
          "Product Name": "",
          netprice: 1966.5,
        }),
      ]);

      expect(result.errors).toHaveLength(0);

      // Final state check: line correctly linked to the chair, productName
      // synced, partNo + barcode preserved as the import audit trail.
      // (Doesn't matter whether the sales-line update path fixed it via
      // barcodeProductMap lookup OR the post-import backfill swept it —
      // both paths converge to the same correct final state, which is
      // what the user-facing report cares about.)
      const updatedLine = await prisma.orderLineItem.findUnique({
        where: { id: wrongLine.id },
      });
      expect(updatedLine?.productId).toBe(realProduct.id);
      expect(updatedLine?.productName).toBe("Big Easy One Arm Chair");
      // partNo gets normalized to the catalog product's productNumber when
      // a match is found (existing runner behavior). barcode preserves
      // the original imported barcode — that's the unique physical-item
      // identifier and the audit trail.
      expect(updatedLine?.partNo).toBe("TEST-REAL-CHAIR");
      expect(updatedLine?.barcode).toBe("TEST-BARCODE-555");
    });
  });
});
