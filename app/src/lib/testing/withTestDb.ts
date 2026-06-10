// /app/src/lib/testing/withTestDb.ts
//
// Real-database test harness for integration tests (Phase 0.6.1).
//
// HOW THIS WORKS
//
// Production code throughout the app imports `prisma` from
// `@/lib/prisma` and uses it directly. To test that code against a
// real Postgres database without refactoring every call site to
// accept a tx parameter, we:
//
//   1. Point `DATABASE_URL` at a separate `fbc_test_db` database
//      before the worker process imports `lib/prisma`. Jest's
//      `globalSetup` runs migrations against that DB once per Jest
//      run (jest.integration.setup.ts).
//
//   2. Between every test, `truncateAll()` empties every data table.
//      Tests start from a clean slate without rebuilding the schema.
//
//   3. Tests build whatever fixtures they need via the same `prisma`
//      instance the code under test uses, so the code-under-test sees
//      its data and the test sees what the code wrote.
//
// WHY TRUNCATE INSTEAD OF TRANSACTION-ROLLBACK
//
// Transaction-rollback (open a transaction, run the test inside it,
// roll back at the end) is faster but only works if every call site
// in production code accepts a `tx` parameter. Ours doesn't — it
// imports `prisma` from `lib/prisma`. Refactoring every API route to
// accept a tx would be a months-long project. TRUNCATE gives us
// real-DB isolation today without that refactor.
//
// Cost: ~50ms per test for the TRUNCATE pass. Acceptable.
//
// USAGE
//
//   import { resetTestDb } from "@/lib/testing/withTestDb";
//   import { prisma } from "@/lib/prisma";
//
//   describe("my integration test", () => {
//     beforeEach(async () => { await resetTestDb(); });
//
//     it("does the thing", async () => {
//       await prisma.salesOrder.create({ data: { ... } });
//       const result = await myFunctionUnderTest();
//       expect(result).toEqual(...);
//     });
//   });

import { prisma } from "@/lib/prisma";

/**
 * Tables that hold test fixture data and are safe to TRUNCATE between
 * tests. Compiled by inspecting the schema for every model — kept
 * exhaustive so a new test isn't surprised by lingering data from a
 * prior test.
 *
 * If a new model is added to schema.prisma, add it here too. The
 * source-text tripwire in `__tests__/testHarness.test.ts` enforces
 * this list stays in sync.
 *
 * Order doesn't matter — `TRUNCATE ... CASCADE` resolves FK ordering
 * automatically.
 */
const ALL_TABLES = [
  "Account",
  "AccountGroup",
  "AppSettings",
  "AutoImportLog",
  "AvailabilityWindow",
  "BlogComment",
  "Booking",
  "BuyerDraftBuy",
  "BuyerDraftItem",
  "BuyerDraftPoRealPoLink",
  "BuyerDraftPurchaseOrder",
  "CalendarBlock",
  "CampaignTarget",
  "Category",
  "Collection",
  "CommissionPayout",
  "CommissionPayoutEdit",
  "CommissionTier",
  "ConsignmentItem",
  "ConsignmentPaymentBatch",
  "ConsignmentReceipt",
  "ConsignmentSale",
  "ConsignmentSaleLine",
  "ConsignmentVendorReturn",
  "Customer",
  "CustomerAddress",
  "CustomerCreditTransaction",
  "CustomerInteraction",
  "CustomerLedgerEntry",
  "CustomerExternalId",
  "DailyReconciliationLog",
  "DeliveryRun",
  "DeliveryStop",
  "DeliveryZone",
  "DeliveryZoneZip",
  "Department",
  "EmailQueue",
  "EmailTemplate",
  "FabricCatalog",
  "GLAccount",
  "GiftCard",
  "GiftCardPreset",
  "GiftCardTransaction",
  "Installer",
  "IntegrationCredential",
  "InventoryFreeze",
  "InventoryFreezeItem",
  "InventoryPosition",
  "InventorySnapshot",
  "InventoryTransfer",
  "Invoice",
  "InvoiceLineItem",
  "JournalEntry",
  "JournalEntryLine",
  "LabelTemplate",
  "Lead",
  "LegacyImportLog",
  "LegacyOrder",
  "LegacyOrderLine",
  "MailchimpActivity",
  "MailchimpCampaign",
  "MailchimpCampaignStats",
  "MailchimpSyncLog",
  "MediaAsset",
  "Menu",
  "MonthlySalesPercentage",
  "NavPermission",
  "OrderChangeLog",
  "OrderLineItem",
  "Organization",
  "Page",
  "Payment",
  "PaymentApplication",
  "PayPeriodConfirmation",
  "PayPeriodIssue",
  "PhysicalInventoryCount",
  "PickList",
  "PickListItem",
  "Post",
  "PriceDimensionTier",
  "PriceList",
  "Printer",
  "Product",
  "ProductAxisPrice",
  "ProductGradePrice",
  "ProductOptionOverride",
  "ProductPairing",
  "ProductSpeciesPrice",
  "ProductVariant",
  "Proposal",
  "ProposalItemImage",
  "ProposalLineItem",
  "PurchaseOrder",
  "PurchaseOrderItem",
  "ReceivingRecord",
  "Reconciliation",
  "Register",
  "Return",
  "SEComponent",
  "SalesGoal",
  "SalesGoals",
  "SalesOrder",
  "Service",
  "ServiceAppointment",
  "ServiceCase",
  "ServiceCaseNote",
  "ServiceCasePriority",
  "ServiceCaseStatus",
  "ServiceCaseType",
  "ServiceEmail",
  "ServiceTask",
  "Session",
  "StaffMember",
  "StaffShift",
  "StockLocation",
  "StoreLocation",
  "StyleAxisPrice",
  "StyleGradePrice",
  "StyleOptionOverride",
  "StyleSpeciesPrice",
  "SystemGLMapping",
  "TaxDistrict",
  "TaxDistrictZipCode",
  "TaxExemptReason",
  "TaxGroup",
  "TaxRule",
  "Ticket",
  "TicketMessage",
  "Till",
  "TillCount",
  "TimeEntry",
  "TradeTier",
  "TrafficSnapshot",
  "TrafficSyncLog",
  "Type",
  "UnidentifiedScan",
  "UpBoardEntry",
  "Upc",
  "User",
  "Vehicle",
  "Vendor",
  "VendorContact",
  "VendorOption",
  "VendorOptionGroup",
  "VendorPriceDimension",
  "VendorProgram",
  "VendorStyle",
  "VerificationToken",
  "WindfallEnrichment",
];

/**
 * TRUNCATE every data table in the test database. Wraps a single
 * `TRUNCATE ... RESTART IDENTITY CASCADE` so FK dependencies resolve
 * automatically and serial sequences reset to 1.
 *
 * Run as the first line of `beforeEach` in every integration test.
 * Refuses to run unless DATABASE_URL points at a database whose name
 * contains "test" — defense in depth so a misconfigured runner can
 * never wipe dev or prod data.
 */
export async function resetTestDb(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("test")) {
    throw new Error(
      `resetTestDb refused: DATABASE_URL does not contain "test" (got: ${maskUrl(url)}). ` +
        `This is a safety guard — integration tests must run against fbc_test_db, ` +
        `never the dev or prod database.`,
    );
  }
  // Quote each table name so mixed-case identifiers (Postgres folds
  // unquoted identifiers to lowercase) match the Prisma-generated tables.
  const quoted = ALL_TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`);
}

/**
 * Strip the password from a DATABASE_URL for safe logging.
 */
function maskUrl(url: string): string {
  return url.replace(/:[^:@]+@/, ":****@");
}

/**
 * The full table list — exported so the source-text tripwire in
 * `__tests__/testHarness.test.ts` can assert it stays in sync with
 * schema.prisma.
 */
export const TABLES_FOR_TEST_RESET: readonly string[] = ALL_TABLES;
