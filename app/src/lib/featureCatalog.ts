// /app/src/lib/featureCatalog.ts
//
// Shared client/server contract (CLAUDE.md rule 7) for optional / tiered
// modules. AppSettings.features is a { [key]: boolean } map; both the Settings
// UI and any server-side gate validate keys against this list. Core modules
// (catalog, sales, customers, reporting) are always on and are NOT listed here
// -- only the modules a plan can switch off appear.

export interface FeatureDef {
  key: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
}

export const FEATURES: FeatureDef[] = [
  {
    key: "warehousing",
    name: "Warehousing",
    description: "Inventory locations, transfers, physical counts, warehouse dashboards.",
    defaultEnabled: true,
  },
  {
    key: "dispatch",
    name: "Dispatch & Delivery",
    description: "Delivery zones, dispatch board, route planning, service appointments.",
    defaultEnabled: false,
  },
  {
    key: "consignment",
    name: "Consignment",
    description: "Consignment receipts, items, vendor payouts, and returns.",
    defaultEnabled: false,
  },
  {
    key: "purchasing",
    name: "Purchasing",
    description: "Purchase orders, receiving, and inbound tracking.",
    defaultEnabled: true,
  },
  {
    key: "pos",
    name: "Point of Sale",
    description: "Register checkout / counter sales.",
    defaultEnabled: true,
  },
  {
    key: "giftCards",
    name: "Gift Cards",
    description: "Sell and redeem gift cards.",
    defaultEnabled: true,
  },
  {
    key: "tills",
    name: "Tills & Cash Drawers",
    description: "Till sessions and cash reconciliation.",
    defaultEnabled: true,
  },
  {
    key: "accounting",
    name: "Accounting",
    description: "Journal entries, GL chart, period close, customer ledger.",
    defaultEnabled: false,
  },
  {
    key: "marketing",
    name: "Marketing & Enrichment",
    description: "Campaign attribution, lead scoring, and wealth enrichment.",
    defaultEnabled: false,
  },
  {
    key: "cms",
    name: "Content (CMS)",
    description: "Public marketing pages, content blocks, and site navigation.",
    defaultEnabled: true,
  },
  {
    key: "blog",
    name: "Blog",
    description: "Dated blog posts on the public site (requires Content).",
    defaultEnabled: false,
  },
  {
    key: "booking",
    name: "Booking",
    description: "Public consultation booking with calendar (.ics) invites and a staff iCal feed.",
    defaultEnabled: true,
  },
  {
    key: "helpdesk",
    name: "Helpdesk",
    description: "Support tickets with a threaded message log and a public submit form.",
    defaultEnabled: true,
  },
  {
    key: "timeTracking",
    name: "Time Tracking",
    description: "Log billable and non-billable time against customers.",
    defaultEnabled: false,
  },
  {
    key: "blogComments",
    name: "Blog Comments",
    description: "Let visitors comment on blog posts, held for moderation (requires Blog).",
    defaultEnabled: false,
  },
  {
    key: "billing",
    name: "Billing & Invoices",
    description:
      "Author invoices, issue them to AR (GL + customer ledger), email with a Stripe pay link, and record payments. Requires AR GL mappings in Accounting setup.",
    defaultEnabled: false,
  },
  {
    key: "dmarcTools",
    name: "Email Auth Tools (DMARC)",
    description:
      "Public DMARC / SPF / DKIM domain checker + aggregate-report analyzer. Lead-gen consult tooling; off by default.",
    defaultEnabled: false,
  },
];

const FEATURE_KEYS = new Set(FEATURES.map((f) => f.key));

export function isValidFeatureKey(key: string): boolean {
  return FEATURE_KEYS.has(key);
}

// Resolve effective on/off for a feature: an explicit AppSettings value wins,
// otherwise the catalog default applies.
export function isFeatureEnabled(features: Record<string, boolean>, key: string): boolean {
  if (key in features) return features[key];
  return FEATURES.find((f) => f.key === key)?.defaultEnabled ?? false;
}
