// /app/prisma/seed/coverage.ts
//
// THE SEED COVERAGE MANIFEST — one row per model in schema.prisma, no exceptions.
//
// A demo seed rots silently. A module stops running, a model is added and never
// wired up, and nobody notices because an empty table looks exactly like a
// feature nobody clicked. This file is the declaration of what SHOULD be true;
// `npm run seed:coverage` measures a seeded database against it and fails on any
// disagreement, in either direction:
//
//   seeded  — the demo seed populates this. If it comes up empty, that is a
//             REGRESSION and the check fails.
//   skipped — deliberately never seeded, and the reason says why. Integration
//             payloads, runtime logs, auth tokens, secrets, PII.
//   todo    — a known gap, assigned to a tranche. If it comes up POPULATED, the
//             manifest is stale and the check fails: move it to `seeded`.
//
// The `tranche` is the unit of delegation. One tranche is one self-contained
// piece of work: "seed the geography-delivery tranche" is a complete brief on
// its own, and `npm run seed:coverage` tells you when it is done.
//
// GENERATED ONCE, MAINTAINED BY HAND. Adding a model to schema.prisma without
// adding it here fails __tests__/seedCoverage.test.ts — which is the point: a
// new table cannot slip in unclassified.
//
// See docs/domains/seed-data.md for how to take a tranche.

export type SeedStatus = "seeded" | "skipped" | "todo";

/** Which seeder populates a model. `setup.sh` runs all three; CI runs --no-cms. */
export type Seeder = "demo" | "cms";

export interface SeedCoverageEntry {
  status: SeedStatus;
  /**
   * Which seeder owns this, when it is not the demo seed. A model owned by a
   * seeder that did not run is not a regression, and the check must be able to
   * tell those apart -- CI seeds with --no-cms, so without this the CMS tables
   * would report as three false regressions on every run.
   */
  seeder?: Seeder;
  /** Required for `skipped`: why this must never be seeded. */
  reason?: string;
  /** Required for `todo`: the delegable unit of work this belongs to. */
  tranche?: string;
}

export const SEED_COVERAGE: Record<string, SeedCoverageEntry> = {
  AdapterOrderFlag: {
    status: "skipped",
    reason:
      "Per-order state written by a source adapter at import time, or by an operator overriding one of its heuristics. Seeding it would invent an override nobody made.",
  },
  Account: { status: "todo", tranche: "money-detail" },
  AccountGroup: { status: "seeded" },
  AppSettings: { status: "seeded" },
  AutoImportLog: {
    status: "skipped",
    reason: "Runtime log. Written by the importer as it runs.",
  },
  AvailabilityWindow: { status: "todo", tranche: "service-scheduling" },
  BlogComment: { status: "todo", tranche: "crm-pipeline" },
  Booking: { status: "todo", tranche: "service-scheduling" },
  BuyerDraftBuy: { status: "todo", tranche: "buying-consignment" },
  BuyerDraftItem: { status: "todo", tranche: "buying-consignment" },
  BuyerDraftPoRealPoLink: { status: "todo", tranche: "buying-consignment" },
  BuyerDraftPurchaseOrder: { status: "todo", tranche: "buying-consignment" },
  CalendarBlock: { status: "todo", tranche: "service-scheduling" },
  CampaignTarget: { status: "todo", tranche: "crm-pipeline" },
  Category: { status: "seeded" },
  Collection: { status: "todo", tranche: "catalog-depth" },
  CommissionPayout: { status: "seeded" },
  CommissionPayoutEdit: { status: "todo", tranche: "commission-completeness" },
  CommissionPlan: { status: "seeded" },
  CommissionPlanRule: { status: "todo", tranche: "commission-completeness" },
  CommissionPlanTier: { status: "seeded" },
  CommissionRuleTier: { status: "todo", tranche: "commission-completeness" },
  CommissionTier: { status: "todo", tranche: "commission-completeness" },
  ConfigChangeLog: {
    status: "skipped",
    reason: "Runtime audit log. Written when config changes; seeding it invents an audit trail.",
  },
  ConsignmentItem: { status: "seeded" },
  ConsignmentPaymentBatch: { status: "seeded" },
  ConsignmentReceipt: { status: "seeded" },
  ConsignmentSale: { status: "todo", tranche: "buying-consignment" },
  ConsignmentSaleLine: { status: "todo", tranche: "buying-consignment" },
  ConsignmentVendorReturn: { status: "todo", tranche: "buying-consignment" },
  Customer: { status: "seeded" },
  CustomerAddress: { status: "seeded" },
  CustomerCreditTransaction: { status: "seeded" },
  CustomerExternalId: { status: "todo", tranche: "catalog-depth" },
  CustomerInteraction: { status: "todo", tranche: "crm-pipeline" },
  CustomerLedgerEntry: { status: "todo", tranche: "money-detail" },
  DailyReconciliationLog: { status: "todo", tranche: "money-detail" },
  DeliveryRun: { status: "todo", tranche: "geography-delivery" },
  DeliveryStop: { status: "todo", tranche: "geography-delivery" },
  DeliveryZone: { status: "todo", tranche: "geography-delivery" },
  DeliveryZoneZip: { status: "todo", tranche: "geography-delivery" },
  Department: { status: "seeded" },
  EmailQueue: {
    status: "skipped",
    reason: "Outbound queue drained by a worker. Seeding it would send mail on first boot.",
  },
  EmailTemplate: { status: "todo", tranche: "content-comms" },
  ErrorEvent: {
    status: "skipped",
    reason:
      "Runtime log. Written by the app in the act of failing; seeding it fakes an incident history.",
  },
  FabricCatalog: { status: "todo", tranche: "catalog-depth" },
  GLAccount: { status: "seeded" },
  GiftCard: { status: "seeded" },
  GiftCardPreset: { status: "todo", tranche: "money-detail" },
  GiftCardTransaction: { status: "seeded" },
  ImportDefinition: { status: "todo", tranche: "imports" },
  ImportFieldMapping: { status: "todo", tranche: "imports" },
  ImportValueMapping: { status: "todo", tranche: "imports" },
  Installer: { status: "todo", tranche: "geography-delivery" },
  IntegrationCredential: {
    status: "skipped",
    reason:
      "Encrypted third-party secrets. Never seed; a shipped credential is a leaked credential.",
  },
  InventoryException: { status: "todo", tranche: "inventory-ops" },
  InventoryFreeze: { status: "todo", tranche: "inventory-ops" },
  InventoryFreezeItem: { status: "todo", tranche: "inventory-ops" },
  InventoryPosition: { status: "seeded" },
  InventorySnapshot: { status: "todo", tranche: "inventory-ops" },
  InventoryTransfer: { status: "todo", tranche: "inventory-ops" },
  Invoice: { status: "seeded" },
  InvoiceLineItem: { status: "todo", tranche: "money-detail" },
  JournalEntry: { status: "seeded" },
  JournalEntryLine: { status: "seeded" },
  LabelTemplate: { status: "todo", tranche: "catalog-depth" },
  Lead: { status: "todo", tranche: "crm-pipeline" },
  LegacyImportLog: {
    status: "skipped",
    reason: "Ordorite import staging — a source system's history, not this product's data.",
  },
  LegacyOrder: {
    status: "skipped",
    reason: "Ordorite import staging — a source system's history, not this product's data.",
  },
  LegacyOrderLine: {
    status: "skipped",
    reason: "Ordorite import staging — a source system's history, not this product's data.",
  },
  MailchimpActivity: {
    status: "skipped",
    reason: "Mailchimp integration data. Arrives from a sync, not from using the product.",
  },
  MailchimpCampaign: {
    status: "skipped",
    reason: "Mailchimp integration data. Arrives from a sync, not from using the product.",
  },
  MailchimpCampaignStats: {
    status: "skipped",
    reason: "Mailchimp integration data. Arrives from a sync, not from using the product.",
  },
  MailchimpSyncLog: {
    status: "skipped",
    reason: "Mailchimp integration data. Arrives from a sync, not from using the product.",
  },
  MediaAsset: { status: "todo", tranche: "catalog-depth" },
  Menu: { status: "seeded", seeder: "cms" },
  MonthlySalesPercentage: { status: "todo", tranche: "commission-completeness" },
  OrderChangeLog: { status: "todo", tranche: "money-detail" },
  OrderLineItem: { status: "seeded" },
  Organization: { status: "seeded" },
  Page: { status: "seeded", seeder: "cms" },
  PasswordResetToken: {
    status: "skipped",
    reason: "Short-lived auth token. Created by asking for a reset.",
  },
  PayPeriodConfirmation: { status: "todo", tranche: "commission-completeness" },
  PayPeriodIssue: { status: "todo", tranche: "commission-completeness" },
  Payment: { status: "seeded" },
  PaymentApplication: { status: "todo", tranche: "money-detail" },
  PhysicalInventoryCount: { status: "todo", tranche: "inventory-ops" },
  PickList: { status: "todo", tranche: "geography-delivery" },
  PickListItem: { status: "todo", tranche: "geography-delivery" },
  Post: { status: "seeded", seeder: "cms" },
  PriceDimensionTier: { status: "todo", tranche: "special-order-pricing" },
  PriceList: { status: "todo", tranche: "special-order-pricing" },
  Printer: { status: "todo", tranche: "geography-delivery" },
  Product: { status: "seeded" },
  ProductAxisPrice: { status: "todo", tranche: "special-order-pricing" },
  ProductGradePrice: { status: "todo", tranche: "special-order-pricing" },
  ProductOptionOverride: { status: "todo", tranche: "special-order-pricing" },
  ProductPairing: { status: "todo", tranche: "catalog-depth" },
  ProductSpeciesPrice: { status: "todo", tranche: "special-order-pricing" },
  ProductVariant: { status: "todo", tranche: "catalog-depth" },
  Proposal: { status: "todo", tranche: "crm-pipeline" },
  ProposalItemImage: { status: "todo", tranche: "crm-pipeline" },
  ProposalLineItem: { status: "todo", tranche: "crm-pipeline" },
  PurchaseOrder: { status: "seeded" },
  PurchaseOrderItem: { status: "seeded" },
  ReceivingRecord: { status: "seeded" },
  Reconciliation: { status: "todo", tranche: "money-detail" },
  Register: { status: "seeded" },
  Return: { status: "seeded" },
  Role: { status: "seeded" },
  RolePermission: { status: "seeded" },
  SEComponent: { status: "todo", tranche: "special-order-pricing" },
  SalesGoal: { status: "todo", tranche: "commission-completeness" },
  SalesGoals: { status: "todo", tranche: "commission-completeness" },
  SalesOrder: { status: "seeded" },
  Service: { status: "todo", tranche: "service-scheduling" },
  ServiceAppointment: { status: "todo", tranche: "service-scheduling" },
  ServiceCase: { status: "seeded" },
  ServiceCaseNote: { status: "seeded" },
  ServiceCasePriority: { status: "seeded" },
  ServiceCaseStatus: { status: "seeded" },
  ServiceCaseType: { status: "seeded" },
  ServiceEmail: { status: "todo", tranche: "service-scheduling" },
  ServiceTask: { status: "todo", tranche: "service-scheduling" },
  Session: {
    status: "skipped",
    reason: "NextAuth session state. Created by signing in.",
  },
  StaffMember: { status: "seeded" },
  StaffShift: { status: "seeded" },
  StockLocation: { status: "seeded" },
  StoreLocation: { status: "seeded" },
  StyleAxisPrice: { status: "todo", tranche: "special-order-pricing" },
  StyleGradePrice: { status: "todo", tranche: "special-order-pricing" },
  StyleOptionOverride: { status: "todo", tranche: "special-order-pricing" },
  StyleSpeciesPrice: { status: "todo", tranche: "special-order-pricing" },
  SystemGLMapping: { status: "seeded" },
  TaxDistrict: { status: "seeded" },
  TaxDistrictZipCode: { status: "todo", tranche: "geography-delivery" },
  TaxExemptReason: { status: "seeded" },
  TaxGroup: { status: "seeded" },
  TaxRule: { status: "seeded" },
  Ticket: { status: "seeded" },
  TicketAttachment: { status: "todo", tranche: "content-comms" },
  TicketMessage: { status: "seeded" },
  Till: { status: "seeded" },
  TillCount: { status: "seeded" },
  TimeEntry: { status: "seeded" },
  TradeTier: { status: "todo", tranche: "crm-pipeline" },
  TrafficSnapshot: {
    status: "skipped",
    reason:
      "Axper traffic-counter data — one vendor's feed, and the column names still carry its brand.",
  },
  TrafficSyncLog: {
    status: "skipped",
    reason:
      "Axper traffic-counter data — one vendor's feed, and the column names still carry its brand.",
  },
  Type: { status: "seeded" },
  UnidentifiedScan: { status: "todo", tranche: "inventory-ops" },
  UpBoardEntry: { status: "todo", tranche: "commission-completeness" },
  Upc: { status: "todo", tranche: "catalog-depth" },
  User: { status: "seeded" },
  Vehicle: { status: "todo", tranche: "geography-delivery" },
  Vendor: { status: "seeded" },
  VendorContact: { status: "todo", tranche: "special-order-pricing" },
  VendorOption: { status: "todo", tranche: "special-order-pricing" },
  VendorOptionGroup: { status: "todo", tranche: "special-order-pricing" },
  VendorPriceDimension: { status: "todo", tranche: "special-order-pricing" },
  VendorProgram: { status: "todo", tranche: "special-order-pricing" },
  VendorStyle: { status: "todo", tranche: "special-order-pricing" },
  VerificationToken: {
    status: "skipped",
    reason: "Short-lived auth token. Created by the verification flow.",
  },
  WindfallEnrichment: {
    status: "skipped",
    reason:
      "Third-party wealth enrichment keyed to real named people. Never seed this; holt is a PUBLIC repo.",
  },
};

/** Every tranche named above, in the order a newcomer should take them. */
export const SEED_TRANCHES: readonly string[] = [
  "imports",
  "catalog-depth",
  "special-order-pricing",
  "crm-pipeline",
  "geography-delivery",
  "inventory-ops",
  "commission-completeness",
  "service-scheduling",
  "money-detail",
  "buying-consignment",
  "content-comms",
];

export function modelsInTranche(tranche: string): string[] {
  return Object.entries(SEED_COVERAGE)
    .filter(([, e]) => e.tranche === tranche)
    .map(([m]) => m)
    .sort();
}
