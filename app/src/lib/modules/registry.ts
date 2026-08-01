// /app/src/lib/modules/registry.ts
//
// THE module manifest -- single source of truth (CLAUDE.md rules 6/37) for
// every optional / tiered module Holt ships. This replaces the old
// featureCatalog.ts FEATURES list; featureCatalog.ts now derives FEATURES
// FROM this file so the 25 existing isFeatureEnabled call sites keep working
// unchanged (see docs/domains/modules.md).
//
// KEEP key / defaultEnabled EXACTLY as they were in featureCatalog.ts. `key`
// round-trips through AppSettings.features in the database; renaming one here
// is a data migration, not a refactor. Core modules (catalog, sales,
// customers, reporting) are always on and are NOT listed here -- only the
// modules a plan can switch off appear.
//
// category is "core" for every pre-existing module (unchanged visibility: all
// of them already showed up in the Settings > Modules toggle grid regardless
// of on/off state, and this refactor does not change that). dmarcTools is the
// one deliberate exception -- see its entry below and docs/domains/dmarc-tools.md.

import type { ModuleDef } from "./types";

export const MODULES: ModuleDef[] = [
  {
    key: "warehousing",
    name: "Warehousing",
    description: "Inventory locations, transfers, physical counts, warehouse dashboards.",
    defaultEnabled: true,
    category: "core",
  },
  {
    key: "dispatch",
    name: "Dispatch & Delivery",
    description: "Delivery zones, dispatch board, route planning, service appointments.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "consignment",
    name: "Consignment",
    description: "Consignment receipts, items, vendor payouts, and returns.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "purchasing",
    name: "Purchasing",
    description: "Purchase orders, receiving, and inbound tracking.",
    defaultEnabled: true,
    category: "core",
  },
  {
    key: "pos",
    name: "Point of Sale",
    description: "Register checkout / counter sales.",
    defaultEnabled: true,
    category: "core",
  },
  {
    key: "giftCards",
    name: "Gift Cards",
    description: "Sell and redeem gift cards.",
    defaultEnabled: true,
    category: "core",
  },
  {
    key: "tills",
    name: "Tills & Cash Drawers",
    description: "Till sessions and cash reconciliation.",
    defaultEnabled: true,
    category: "core",
  },
  {
    key: "accounting",
    name: "Accounting",
    description: "Journal entries, GL chart, period close, customer ledger.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "marketing",
    name: "Marketing & Enrichment",
    description: "Campaign attribution, lead scoring, and wealth enrichment.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "cms",
    name: "Content (CMS)",
    description: "Public marketing pages, content blocks, and site navigation.",
    defaultEnabled: true,
    category: "core",
  },
  {
    key: "blog",
    name: "Blog",
    description: "Dated blog posts on the public site (requires Content).",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "booking",
    name: "Booking",
    description: "Public consultation booking with calendar (.ics) invites and a staff iCal feed.",
    defaultEnabled: true,
    category: "core",
  },
  {
    key: "helpdesk",
    name: "Helpdesk",
    description: "Support tickets with a threaded message log and a public submit form.",
    defaultEnabled: true,
    category: "core",
  },
  {
    key: "timeTracking",
    name: "Time Tracking",
    description: "Log billable and non-billable time against customers.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "blogComments",
    name: "Blog Comments",
    description: "Let visitors comment on blog posts, held for moderation (requires Blog).",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "billing",
    name: "Billing & Invoices",
    description:
      "Author invoices, issue them to AR (GL + customer ledger), email with a Stripe pay link, and record payments. Requires AR GL mappings in Accounting setup.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "legacyPosImport",
    name: "Legacy POS auto-import",
    description:
      "Automated daily ingestion of the legacy POS's emailed CSV reports (sales, quotes, payments, invoices, POs, stock, customers, products) via the edition's import adapter. Runs in parallel with the legacy system until cutover.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "legacyArchive",
    name: "Legacy Archive",
    description:
      "Read-only lookup of sales history imported from a previous system (one-time load at onboarding). Isolated from live data and reports.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "clientPortal",
    name: "Client Portal",
    description:
      "No-login client hub (tokenized link): upcoming appointments, invoices with online payment, and support ticket status.",
    defaultEnabled: false,
    category: "core",
  },
  {
    key: "dmarcTools",
    name: "Email Auth Tools (DMARC)",
    description:
      "Public DMARC / SPF / DKIM domain checker + aggregate-report analyzer. Lead-gen consult tooling; off by default.",
    defaultEnabled: false,
    // Niche, single-tenant (Akritos-only) lead-gen tooling. Hidden from the
    // Modules toggle grid for every deployment that doesn't already have it
    // on -- a furniture retailer should never see this as an option.
    // Provisioned via scripts/seed-akritos.mjs, not the Settings UI.
    category: "addon",
    // No configurable settings today -- this is the "nav but no fields"
    // case. /admin/settings/dmarcTools still renders (module found + module
    // has nav), it just shows the nav/docs links instead of a form.
    nav: [
      { label: "DMARC / SPF / DKIM Checker", href: "/tools/dmarc-check" },
      { label: "DMARC Report Analyzer", href: "/tools/dmarc-report" },
    ],
    docs: "docs/domains/dmarc-tools.md",
  },
];
