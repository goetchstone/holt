// /app/src/lib/pricing/importVendorConfigs.ts
//
// The vendor list behind the price-book import dropdown.
//
// Two sources, one list. The registry-backed vendors (a compiled profile in
// wholesale/registry.ts) are DERIVED from that registry, so a vendor this build
// can already read cannot be missing from the menu -- the exact drift the old
// hardcoded array had, where hooker / sam-moore / bradington-young parsed fine
// but were unreachable from the UI. The legacy vendors below carry bespoke,
// multi-type import configs (foundations, fabrics, signature-elements) that
// predate the registry and have no profile yet.
//
// Client-safe: the registry and its profiles import no server-only code
// (verified: no prisma/fs/next-server in the chain), so this is importable from
// the "use client" import view.

import { WHOLESALE_VENDOR_PROFILES } from "@/lib/pricing/wholesale/registry";

export interface ImportTypeConfig {
  value: string;
  label: string;
  defaultPriceListName: string;
  /** API endpoint for import. Defaults to wholesale-prices. */
  importEndpoint?: string;
}

export interface VendorConfig {
  slug: string;
  /** Lowercase substring to match against vendor.name from the DB */
  nameMatch: string;
  displayName: string;
  importTypes: ImportTypeConfig[];
}

// Derived from every wholesale profile the build can read. A profile advertises
// only its wholesale book here; richer import types stay a legacy concern.
const PROFILE_VENDOR_CONFIGS: VendorConfig[] = WHOLESALE_VENDOR_PROFILES.map((p) => ({
  slug: p.id,
  // A profile's label is a display string ("Hooker Custom Upholstery"); the DB
  // vendor row may read "Hooker Furniture". nameMatch is the substring that
  // survives that gap, falling back to the lowercased label when unset.
  nameMatch: p.nameMatch ?? p.label.toLowerCase(),
  displayName: p.label,
  importTypes: [
    {
      value: "wholesale",
      label: "Wholesale Price Book",
      defaultPriceListName: `${p.label} Wholesale`,
    },
  ],
}));

const LEGACY_VENDOR_CONFIGS: VendorConfig[] = [
  {
    slug: "wesley-hall",
    nameMatch: "wesley hall",
    displayName: "Wesley Hall",
    importTypes: [
      {
        value: "wholesale",
        label: "Wholesale Price Book",
        defaultPriceListName: "Wesley Hall Wholesale October 2025",
      },
      {
        value: "foundations",
        label: "Foundations Program",
        defaultPriceListName: "Wesley Hall Foundations Program",
        importEndpoint: "/api/pricing/import/foundations",
      },
      {
        value: "fabrics",
        label: "Fabric Catalog",
        defaultPriceListName: "Wesley Hall Fabric Catalog",
        importEndpoint: "/api/pricing/import/fabrics",
      },
      {
        value: "signature-elements",
        label: "Signature Elements",
        defaultPriceListName: "Wesley Hall Signature Elements October 2025",
        importEndpoint: "/api/pricing/import/signature-elements",
      },
    ],
  },
  {
    slug: "c-r-laine",
    nameMatch: "c r laine",
    displayName: "C R Laine",
    importTypes: [
      {
        value: "wholesale",
        label: "Wholesale Price List",
        defaultPriceListName: "C R Laine Wholesale September 2025",
      },
      {
        value: "simplicity",
        label: "Simplicity Program",
        defaultPriceListName: "C R Laine Simplicity October 2025",
        importEndpoint: "/api/pricing/import/foundations",
      },
      {
        value: "fabrics",
        label: "Fabric Catalog",
        defaultPriceListName: "C R Laine Fabric Catalog",
        importEndpoint: "/api/pricing/import/fabrics",
      },
    ],
  },
  {
    slug: "caperton",
    nameMatch: "caperton",
    displayName: "Gat Creek (Caperton)",
    importTypes: [
      {
        value: "wholesale",
        label: "Wholesale Price List",
        defaultPriceListName: "Gat Creek Wholesale January 2026",
        importEndpoint: "/api/pricing/import/wood-prices",
      },
    ],
  },
  {
    slug: "kingsley-bate",
    nameMatch: "kingsley bate",
    displayName: "Kingsley Bate",
    importTypes: [
      {
        value: "retail-prices",
        label: "Retail Price List",
        defaultPriceListName: "Kingsley Bate Retail March 2026",
        importEndpoint: "/api/pricing/import/frame-cushion-prices",
      },
    ],
  },
  {
    slug: "brown-jordan",
    nameMatch: "brown jordan",
    displayName: "Brown Jordan",
    importTypes: [
      {
        value: "retail-prices",
        label: "Retail Price List",
        defaultPriceListName: "Brown Jordan Retail 2026",
        importEndpoint: "/api/pricing/import/retail-grade-prices",
      },
    ],
  },
  {
    slug: "summer-classics",
    nameMatch: "summer classics",
    displayName: "Summer Classics",
    importTypes: [
      {
        value: "wholesale",
        label: "Wholesale Price List",
        defaultPriceListName: "Summer Classics Wholesale August 2025",
        importEndpoint: "/api/pricing/import/summer-classics-prices",
      },
    ],
  },
  {
    slug: "jensen-leisure",
    nameMatch: "jensen",
    displayName: "Jensen Leisure",
    importTypes: [
      {
        value: "wholesale",
        label: "Retail Price List",
        defaultPriceListName: "Jensen Leisure Retail January 2026",
        importEndpoint: "/api/pricing/import/jensen-prices",
      },
    ],
  },
  {
    slug: "ekornes",
    nameMatch: "ekornes",
    displayName: "Ekornes (Stressless)",
    importTypes: [
      {
        value: "retail-prices",
        label: "MRP Price List (PDF)",
        defaultPriceListName: "Ekornes MRP January 2026",
        importEndpoint: "/api/pricing/import/ekornes-prices",
      },
    ],
  },
  {
    slug: "american-leather",
    nameMatch: "american leather",
    displayName: "American Leather",
    importTypes: [
      {
        value: "retail-prices",
        label: "Retail MRP Price List (PDF)",
        defaultPriceListName: "American Leather Retail November 2025",
        importEndpoint: "/api/pricing/import/american-leather",
      },
    ],
  },
];

// Profile-backed vendors first, then the legacy configs. A slug appearing in
// both would be a bug (a legacy vendor that has since gained a profile should
// lose its hardcoded entry) -- importVendorConfigs.test.ts fails on a duplicate
// so that drift cannot ship silently.
export const VENDOR_CONFIGS: VendorConfig[] = [...PROFILE_VENDOR_CONFIGS, ...LEGACY_VENDOR_CONFIGS];
