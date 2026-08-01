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
//
//   5. Same-day-rewrite base/rewrite/return triple (docs/domains/
//      import-pipeline.md "Follow-up (not yet shipped)"): a real-DB
//      exercise of the full base + same-day rewrite + accounting-
//      return chain through runSalesImport end-to-end (grouping,
//      upsert, orphan-freeze, AND the post-import
//      cancelSameDayRewriteDroppedLines sweep that calls
//      findDroppedBaseLineIds). This is the highest-consequence path
//      in the importer — it's what the Ordorite parallel-run drift
//      checker's trustworthiness rests on — and until now only the
//      pure helper (`__tests__/sameDayRewriteCleanup.test.ts`) and
//      source-text tripwires (`__tests__/ordoriteImportRunners.
//      regression.test.ts`) exercised this logic; neither goes
//      through Prisma/Postgres. See "Same-day rewrites — the
//      dropped-line edge case" in the domain doc for the full
//      incident history (2026-05-12 Cheshire $1,109 delta,
//      2026-05-15 SBOM39618 over-cancellation, 2026-05-22 SBOM39876
//      return-lookup bug).
//
//      Writing this real-DB exercise surfaced a NEW bug, since fixed:
//      `cleanupOneRewriteChain` cancelled dropped base lines without a
//      `cancelReason`, so the PR #201 reactivation guard couldn't tell
//      a same-day-rewrite drop apart from a genuine orphan-cancel — a
//      base-only re-import (no paired rewrite in the same batch)
//      silently reactivated the drops. Fixed by stamping
//      `cancelReason = SAME_DAY_REWRITE_DROP_CANCEL_REASON` (shared.ts)
//      on the drop. See the "regression: re-importing the base
//      WITHOUT its paired rewrite..." test below.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { runSalesImport } from "@/lib/adapters/ordorite/runners";
import { SAME_DAY_REWRITE_DROP_CANCEL_REASON } from "@/lib/adapters/ordorite/shared";

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

  // ─── Same-day rewrite: base + rewrite + return prefix triple ────────
  //
  // docs/domains/import-pipeline.md "Follow-up (not yet shipped)":
  // "real-DB integration test exercising runSalesImport against a
  // fixture CSV of the base + rewrite + the return prefix triple,
  // asserting the cancellations match the helper's output."
  //
  // Fixture shape mirrors the canonical CHOM1726 case pinned by the
  // pure-helper unit tests (__tests__/sameDayRewriteCleanup.test.ts),
  // adapted to real Ordorite order-number grammar so the WHOLE chain
  // — grouping, upsert, the rewrite-freeze on orphan-cleanup, AND the
  // post-import cancelSameDayRewriteDroppedLines sweep — runs through
  // Prisma/Postgres, not just the pure helper in isolation:
  //
  //   Base    CHOM90001       5 lines, same orderDate throughout
  //   Return  CHOA90501       3 lines (accounting return, independent
  //                           numeric sequence per the doc — NOT a
  //                           swap of the base orderno)
  //   Rewrite CHOM90001 - A   3 lines
  //
  //   Lines 1-3 (CUSHION-A x3, SOFA-A, DELIVERY) are the credit-cycled
  //   "kept" items: present on base, negated on the return, re-billed
  //   on the rewrite. Lines 4-5 (LOUNGE-A, extra DELIVERY) are
  //   DROPPED — the customer removed them before close-of-business,
  //   Ordorite's accounting return never covers them (the exact
  //   post-failure-log 2026-05-12 quirk), and they must end up
  //   CANCELLED so daily-sales reports (which filter lineItemStatus
  //   != CANCELLED) don't double-count them.
  describe("same-day rewrite: base + rewrite + return-prefix triple (docs follow-up)", () => {
    const BASE_ORDERNO = "CHOM90001";
    const RETURN_ORDERNO = "CHOA90501";
    const REWRITE_ORDERNO = "CHOM90001 - A";
    const SAME_DAY = "2026-05-09";
    const CUSCODE = "CHCT90001";

    function tripleCsvRow(
      orderno: string,
      partNo: string,
      qty: number,
      netprice: number,
    ): SalesCsvRow {
      return csvRow({
        Orderno: orderno,
        Cuscode: CUSCODE,
        Customer: "Brian Tenerow",
        Email: "",
        Orderdate: SAME_DAY,
        Company: "Cheshire",
        partNo,
        Orderqty: qty,
        netprice,
        cost: Math.abs(netprice) / 2,
      });
    }

    function buildTripleCsv(): SalesCsvRow[] {
      return [
        // Base — 5 lines, all initially ACTIVE.
        tripleCsvRow(BASE_ORDERNO, "CUSHION-A", 3, 300),
        tripleCsvRow(BASE_ORDERNO, "SOFA-A", 1, 1500),
        tripleCsvRow(BASE_ORDERNO, "DELIVERY", 1, 99),
        tripleCsvRow(BASE_ORDERNO, "LOUNGE-A", 2, 1600), // dropped
        tripleCsvRow(BASE_ORDERNO, "DELIVERY", 1, 99), // dropped (extra)
        // Accounting return — negates only the KEPT lines. Ordorite
        // never returns the dropped lounges/extra-delivery — that's
        // the whole quirk this cleanup exists to correct for.
        tripleCsvRow(RETURN_ORDERNO, "CUSHION-A", -3, -300),
        tripleCsvRow(RETURN_ORDERNO, "SOFA-A", -1, -1500),
        tripleCsvRow(RETURN_ORDERNO, "DELIVERY", -1, -99),
        // Rewrite — re-bills the kept lines only.
        tripleCsvRow(REWRITE_ORDERNO, "CUSHION-A", 3, 300),
        tripleCsvRow(REWRITE_ORDERNO, "SOFA-A", 1, 1500),
        tripleCsvRow(REWRITE_ORDERNO, "DELIVERY", 1, 99),
      ];
    }

    it("imports the base order + line items with correct netPrice and status", async () => {
      const result = await runSalesImport(buildTripleCsv());
      expect(result.errors).toEqual([]);

      const base = await prisma.salesOrder.findUnique({
        where: { orderno: BASE_ORDERNO },
        include: { lineItems: { orderBy: { lineNumber: "asc" } } },
      });
      expect(base).not.toBeNull();
      expect(base!.status).toBe("ORDER");
      expect(base!.lineItems).toHaveLength(5);
      expect(base!.lineItems.map((l) => Number(l.netPrice))).toEqual([300, 1500, 99, 1600, 99]);
      expect(base!.lineItems.map((l) => l.partNo)).toEqual([
        "CUSHION-A",
        "SOFA-A",
        "DELIVERY",
        "LOUNGE-A",
        "DELIVERY",
      ]);
    });

    it("same-day rewrite supersedes the base without double-counting revenue: drop lines get CANCELLED, kept lines stay ACTIVE", async () => {
      const result = await runSalesImport(buildTripleCsv());
      expect(result.errors).toEqual([]);

      // The runner's own counter should report exactly 2 cancellations
      // — this is the field the daily-import admin UI surfaces.
      expect(result.sameDayRewriteLinesCancelled).toBe(2);

      const base = await prisma.salesOrder.findUnique({
        where: { orderno: BASE_ORDERNO },
        include: { lineItems: { orderBy: { lineNumber: "asc" } } },
      });
      const statuses = base!.lineItems.map((l) => l.lineItemStatus);
      // Lines 1-3 (kept, credit-cycled): stay ACTIVE.
      expect(statuses.slice(0, 3)).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
      // Lines 4-5 (dropped, beyond the rewrite's footprint, no return
      // or rewrite match): CANCELLED by the post-import sweep. This is
      // exactly the SO-1726/CHOM1726 shape from the post-failure log
      // 2026-05-12 — the $1,109 Cheshire delta.
      expect(statuses.slice(3, 5)).toEqual(["CANCELLED", "CANCELLED"]);

      // Cross-check against the pure helper directly — the runner's
      // real-DB wiring must agree with findDroppedBaseLineIds's output
      // on the same triple. This is the assertion the doc's follow-up
      // explicitly asked for ("asserting the cancellations match the
      // helper's output").
      const { findDroppedBaseLineIds } =
        await import("@/lib/adapters/ordorite/sameDayRewriteCleanup");
      const rewrite = await prisma.salesOrder.findUnique({
        where: { orderno: REWRITE_ORDERNO },
        include: { lineItems: true },
      });
      const ret = await prisma.salesOrder.findUnique({
        where: { orderno: RETURN_ORDERNO },
        include: { lineItems: true },
      });
      const toCleanupLine = (l: {
        id: number;
        lineNumber: number | null;
        lineItemStatus: string;
        partNo: string | null;
        orderedQuantity: unknown;
      }) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        lineItemStatus: l.lineItemStatus,
        partNo: l.partNo,
        orderedQuantity: Number(l.orderedQuantity),
      });
      // Re-derive against the ORIGINAL (pre-cleanup) base status so the
      // helper's decision is computed from the same inputs the runner
      // saw, not from the already-cancelled post-cleanup state.
      const baseLinesPreCleanup = base!.lineItems.map((l) => ({
        ...toCleanupLine(l),
        lineItemStatus: "ACTIVE",
      }));
      const expectedDroppedIds = findDroppedBaseLineIds({
        baseLines: baseLinesPreCleanup,
        rewriteLines: rewrite!.lineItems.map(toCleanupLine),
        returnLines: ret!.lineItems.map(toCleanupLine),
      });
      const actualCancelledIds = base!.lineItems
        .filter((l) => l.lineItemStatus === "CANCELLED")
        .map((l) => l.id);
      expect(actualCancelledIds.sort()).toEqual(expectedDroppedIds.sort());
    });

    it("return prefix nets out against the base rather than creating a phantom sale, and the chain's ACTIVE total matches the rewrite (no double-count)", async () => {
      await runSalesImport(buildTripleCsv());

      const ret = await prisma.salesOrder.findUnique({
        where: { orderno: RETURN_ORDERNO },
        include: { lineItems: true },
      });
      // The return order itself is a real row (not folded into the
      // base) with RETURNED status and negative line totals — it nets
      // the base's kept lines within the same-day window rather than
      // producing a separate phantom sale.
      expect(ret).not.toBeNull();
      expect(ret!.status).toBe("RETURNED");
      const returnTotal = ret!.lineItems.reduce((sum, l) => sum + Number(l.netPrice), 0);
      expect(returnTotal).toBe(-1899); // -(300 + 1500 + 99)

      // Financial invariant from the doc's worked example: sum of
      // ACTIVE line revenue across the WHOLE base+return+rewrite chain
      // must equal the rewrite's total exactly — not the base's total,
      // not base+rewrite double-counted. This is the actual dollar
      // assertion the Ordorite parallel-run drift checker depends on.
      const [base, rewrite] = await Promise.all([
        prisma.salesOrder.findUnique({
          where: { orderno: BASE_ORDERNO },
          include: { lineItems: true },
        }),
        prisma.salesOrder.findUnique({
          where: { orderno: REWRITE_ORDERNO },
          include: { lineItems: true },
        }),
      ]);
      const activeTotal = [...base!.lineItems, ...ret!.lineItems, ...rewrite!.lineItems]
        .filter((l) => l.lineItemStatus === "ACTIVE")
        .reduce((sum, l) => sum + Number(l.netPrice), 0);
      const rewriteTotal = rewrite!.lineItems.reduce((sum, l) => sum + Number(l.netPrice), 0);
      expect(rewriteTotal).toBe(1899); // 300 + 1500 + 99
      expect(activeTotal).toBe(rewriteTotal);
    });

    it("cancelled/superseded lines carry lineItemStatus CANCELLED so reports filtering it out see the correct set", async () => {
      await runSalesImport(buildTripleCsv());

      const base = await prisma.salesOrder.findUnique({
        where: { orderno: BASE_ORDERNO },
        include: { lineItems: true },
      });
      const cancelled = base!.lineItems.filter((l) => l.lineItemStatus === "CANCELLED");
      expect(cancelled).toHaveLength(2);
      expect(cancelled.map((l) => l.partNo).sort()).toEqual(["DELIVERY", "LOUNGE-A"]);

      // Mirrors the report-filtering convention (CLAUDE.md rule 33 /
      // cancelledLineFilter.integration.test.ts): a query that filters
      // lineItemStatus != CANCELLED must see exactly the 3 kept lines
      // for the base order, not 5.
      const reportVisibleBaseLines = await prisma.orderLineItem.findMany({
        where: {
          salesOrder: { orderno: BASE_ORDERNO },
          lineItemStatus: { not: "CANCELLED" },
        },
      });
      expect(reportVisibleBaseLines).toHaveLength(3);
    });

    it("does NOT over-cancel the SO-39618-shaped keep case (past incident: 3-way credit cycle + unchanged lines must stay ACTIVE)", async () => {
      // Second canonical shape from the doc's "Two canonical shapes
      // the test set must keep green" table. Distinguishes true drops
      // from lines that are kept via a 3-way credit cycle or left
      // unchanged within the rewrite's footprint. Only the MRC sticky
      // fee (documented, accepted small gap) gets cancelled.
      const orderno = "CHOM90777";
      const returnOrderno = "CHOA90777";
      const rewriteOrderno = "CHOM90777 - A";
      const day = "2026-05-13";
      const cuscode = "CHCT90777";

      const row = (o: string, partNo: string, qty: number, netprice: number) =>
        csvRow({
          Orderno: o,
          Cuscode: cuscode,
          Customer: "Keep Case Customer",
          Email: "",
          Orderdate: day,
          Company: "Cheshire",
          partNo,
          Orderqty: qty,
          netprice,
          cost: Math.abs(netprice) / 2,
        });

      const csv = [
        // Base — 6 lines.
        row(orderno, "VIDYA-DUVET", 1, 400), // kept, within footprint
        row(orderno, "VIDYA-SHAMS", 2, 150), // kept, within footprint
        row(orderno, "SHOREVIEW-BED", 1, 900), // return-only credit cycle
        row(orderno, "STORAGE", 1, 250), // 3-way credit cycle
        row(orderno, "SH-300", 1, 300), // 3-way credit cycle
        row(orderno, "MRC", 1, 16), // dropped sticky fee (documented gap)
        // Return — 3 lines.
        row(returnOrderno, "SHOREVIEW-BED", -1, -900),
        row(returnOrderno, "STORAGE", -1, -250),
        row(returnOrderno, "SH-300", -1, -300),
        // Rewrite — 2 lines.
        row(rewriteOrderno, "STORAGE", 1, 250),
        row(rewriteOrderno, "SH-300", 1, 300),
      ];

      const result = await runSalesImport(csv);
      expect(result.errors).toEqual([]);
      expect(result.sameDayRewriteLinesCancelled).toBe(1);

      const base = await prisma.salesOrder.findUnique({
        where: { orderno },
        include: { lineItems: { orderBy: { lineNumber: "asc" } } },
      });
      const statuses = base!.lineItems.map((l) => l.lineItemStatus);
      expect(statuses).toEqual([
        "ACTIVE", // VIDYA-DUVET
        "ACTIVE", // VIDYA-SHAMS
        "ACTIVE", // SHOREVIEW-BED (return-only)
        "ACTIVE", // STORAGE (3-way)
        "ACTIVE", // SH-300 (3-way)
        "CANCELLED", // MRC
      ]);
    });

    it("idempotency: running the identical triple CSV twice converges to the same final DB state (no duplicate orders/lines, drop-set stays [4,5])", async () => {
      // The runner is documented as idempotent by design — OrderLineItem.
      // lineNumber's doc comment in schema.prisma reads "sequential
      // within order, for idempotent re-import" and the domain doc's
      // verification checklist requires "safe to process the same CSV
      // twice." SalesOrder is upserted by the unique `orderno`, and line
      // items are matched by (salesOrderId, lineNumber) rather than
      // inserted unconditionally, so the row-level claim holds and is
      // checked here directly rather than assumed.
      //
      // `cleanupOneRewriteChain` stamps `cancelReason =
      // SAME_DAY_REWRITE_DROP_CANCEL_REASON` on the lines it drops (see
      // shared.ts), so on the second pass the per-row loop's PR #201
      // reactivation guard (`!cancelReason`) correctly leaves lines 4/5
      // CANCELLED instead of bouncing them back to ACTIVE. With nothing
      // reactivated, `findDroppedBaseLineIds` sees those base lines
      // already `lineItemStatus === "CANCELLED"` and skips them (its
      // own idempotency rule), so `cleanupOneRewriteChain` finds zero
      // NEW drops on the second pass. `sameDayRewriteLinesCancelled`
      // is only set when `totalCancelled > 0`
      // (`cancelSameDayRewriteDroppedLines`), so it stays `undefined`
      // on the second pass rather than repeating `2` — the counter
      // means "cancelled just now," and nothing was.
      const csv = buildTripleCsv();
      const first = await runSalesImport(csv);
      const second = await runSalesImport(csv);

      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);

      // Second pass creates nothing new — every order/line already
      // exists.
      expect(second.salesOrdersCreated).toBe(0);
      expect(second.lineItemsCreated).toBe(0);
      // See comment above: the cancelReason stamp makes the drop
      // "sticky" across re-imports, so the second pass finds nothing
      // new to cancel and the counter is left unset.
      expect(second.sameDayRewriteLinesCancelled).toBeUndefined();

      const orders = await prisma.salesOrder.findMany({
        where: { orderno: { in: [BASE_ORDERNO, RETURN_ORDERNO, REWRITE_ORDERNO] } },
      });
      expect(orders).toHaveLength(3);

      const base = await prisma.salesOrder.findUnique({
        where: { orderno: BASE_ORDERNO },
        include: { lineItems: { orderBy: { lineNumber: "asc" } } },
      });
      expect(base!.lineItems).toHaveLength(5);
      const cancelled = base!.lineItems.filter((l) => l.lineItemStatus === "CANCELLED");
      expect(cancelled).toHaveLength(2);
      expect(cancelled.map((l) => l.lineNumber)).toEqual([4, 5]);
      // Both drops carry the sentinel cancelReason, both passes.
      expect(cancelled.every((l) => l.cancelReason === SAME_DAY_REWRITE_DROP_CANCEL_REASON)).toBe(
        true,
      );

      // No duplicate customer rows — same cuscode both passes.
      const customers = await prisma.customer.findMany({
        where: { externalIds: { some: { externalId: CUSCODE } } },
      });
      expect(customers).toHaveLength(1);
    });

    it("regression: re-importing the base WITHOUT its paired rewrite in the same batch does NOT reactivate previously-dropped same-day-rewrite lines", async () => {
      // FIXED 2026-07-24. This test originally PINNED a real bug found
      // while writing this suite (no pre-existing post-failure-log
      // entry — reported here with reproduction evidence per the
      // task's instruction to surface real bugs rather than paper over
      // them). It now guards the fix instead.
      //
      // Bug mechanism (pre-fix):
      //   1. `cleanupOneRewriteChain` (runners.ts) cancelled dropped
      //      base lines via `updateMany({ data: { lineItemStatus:
      //      "CANCELLED" } })` — it did NOT set `cancelReason`.
      //   2. The per-row reactivation logic (PR #201, runners.ts ~line
      //      427) treats ANY cancelled line with a NULL cancelReason as
      //      "orphan-cancelled" and reactivates it to ACTIVE the moment
      //      the CSV provides that lineNumber again. It cannot tell a
      //      same-day-rewrite drop apart from a genuine orphan.
      //   3. `cancelSameDayRewriteDroppedLines` only re-examines orders
      //      whose orderno is a REWRITE *and is present in the current
      //      import batch* (`importedOrdernos.filter(isRewriteOrder)`,
      //      runners.ts ~line 737). If a later import re-sends the
      //      base's rows without also re-sending the rewrite's rows in
      //      the SAME call, the cleanup sweep never runs for that base
      //      — so step 2's reactivation was never corrected.
      //
      // Net effect (pre-fix): a base order that already went through
      // same-day-rewrite cleanup got its dropped lines silently
      // reinstated as ACTIVE — reintroducing the exact double-count bug
      // the cleanup exists to prevent (post-failure log 2026-05-12) —
      // with no error, no counter change, and no signal anywhere in the
      // result. This was plausible in production any time the base
      // order was re-imported on its own: a manual re-upload of a
      // single day's corrected file via
      // `/admin/import/POS-automation.tsx`, or (per "Rewrite-truncated
      // CSVs" in the domain doc) any path that re-sends the base's
      // original lineNumbers without the rewrite.
      //
      // Fix: `cleanupOneRewriteChain` now stamps `cancelReason =
      // SAME_DAY_REWRITE_DROP_CANCEL_REASON` (shared.ts) on the lines
      // it drops, so step 2's reactivation guard (`!cancelReason`)
      // treats the drop as deliberate — same as a user-cancel — and
      // leaves it CANCELLED no matter what's in a later batch.
      const csv = buildTripleCsv();
      const first = await runSalesImport(csv);
      expect(first.sameDayRewriteLinesCancelled).toBe(2);

      let base = await prisma.salesOrder.findUnique({
        where: { orderno: BASE_ORDERNO },
        include: { lineItems: { orderBy: { lineNumber: "asc" } } },
      });
      expect(base!.lineItems.map((l) => l.lineItemStatus)).toEqual([
        "ACTIVE",
        "ACTIVE",
        "ACTIVE",
        "CANCELLED",
        "CANCELLED",
      ]);
      expect(base!.lineItems[3].cancelReason).toBe(SAME_DAY_REWRITE_DROP_CANCEL_REASON);
      expect(base!.lineItems[4].cancelReason).toBe(SAME_DAY_REWRITE_DROP_CANCEL_REASON);

      // Re-import ONLY the base's 5 rows — no return, no rewrite in
      // this batch (simulates a re-upload of just the base's file, or
      // any downstream path that re-sends the base alone).
      const baseOnlyCsv = [
        tripleCsvRow(BASE_ORDERNO, "CUSHION-A", 3, 300),
        tripleCsvRow(BASE_ORDERNO, "SOFA-A", 1, 1500),
        tripleCsvRow(BASE_ORDERNO, "DELIVERY", 1, 99),
        tripleCsvRow(BASE_ORDERNO, "LOUNGE-A", 2, 1600),
        tripleCsvRow(BASE_ORDERNO, "DELIVERY", 1, 99),
      ];
      const second = await runSalesImport(baseOnlyCsv);
      expect(second.errors).toEqual([]);
      // No same-day cleanup runs at all in this batch — the rewrite
      // orderno isn't present, so cancelSameDayRewriteDroppedLines has
      // nothing to iterate over. This confirms the guarantee below
      // holds WITHOUT the post-import sweep ever re-running — it's the
      // per-row reactivation guard alone (armed by the cancelReason
      // stamped on the first pass) that keeps the drop intact.
      expect(second.sameDayRewriteLinesCancelled).toBeUndefined();

      base = await prisma.salesOrder.findUnique({
        where: { orderno: BASE_ORDERNO },
        include: { lineItems: { orderBy: { lineNumber: "asc" } } },
      });
      // FIXED: lines 4 and 5 stay CANCELLED. The dropped same-day-
      // rewrite lines are never reactivated by a base-only re-import,
      // closing the double-count hole the pre-fix behavior reopened.
      expect(base!.lineItems.map((l) => l.lineItemStatus)).toEqual([
        "ACTIVE",
        "ACTIVE",
        "ACTIVE",
        "CANCELLED",
        "CANCELLED",
      ]);
      // cancelReason survives the re-import untouched (lineData never
      // writes cancelReason, so Prisma leaves the column as-is).
      expect(base!.lineItems[3].cancelReason).toBe(SAME_DAY_REWRITE_DROP_CANCEL_REASON);
      expect(base!.lineItems[4].cancelReason).toBe(SAME_DAY_REWRITE_DROP_CANCEL_REASON);
    });
  });
});
