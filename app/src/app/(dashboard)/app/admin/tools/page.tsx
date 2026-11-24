// /app/src/app/(dashboard)/app/admin/tools/page.tsx
//
// System Tools hub -- App Router port of the legacy admin/tools/index, on
// Change settings. A card shows only to a viewer holding the key of the page it
// opens (lib/auth/hubCards.ts); hrefs are unchanged so existing links keep
// working. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { hubCardKeys, visibleHubCards } from "@/lib/auth/hubCards";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "UPC / Barcode Viewer",
    description: "Diagnose import issues by viewing all imported barcodes.",
    href: "/app/admin/diagnostics/upcs",
  },
  {
    title: "Diagnostic Lookup Tool",
    description: "Test the barcode and SKU lookup API directly.",
    href: "/app/admin/diagnostics/lookup-test",
  },
  {
    title: "Merge Customers",
    description: "Find and merge duplicate customer records.",
    href: "/app/admin/tools/merge-customers",
  },
  {
    title: "Relink Order Line Items",
    description:
      "Match unlinked line items to products by part number. Fixes Uncategorized rows on reports.",
    href: "/app/admin/diagnostics/relink-line-items",
  },
  {
    title: "Categorize Products",
    description: "Assign department, category, vendor, and type to uncategorized products in bulk.",
    href: "/app/admin/tools/categorize-products",
  },
  {
    title: "Customer Ledger Backfill",
    description:
      "Phase 0.5.3 one-time job: walk every customer's order/payment history and write CustomerLedgerEntry rows. Idempotent. ADMIN only.",
    href: "/app/admin/tools/customer-ledger-backfill",
  },
  {
    title: "Buyer Drafts",
    description:
      "Pre-the POS item + PO workbench. Buyer creates drafts here while specs are still in flight, then exports to the POS-format CSVs. ADMIN only.",
    href: "/app/admin/buyer-drafts",
  },
];

export default async function AdminToolsHubPage() {
  const { holds } = await requirePage(undefined, {
    permission: "admin.settings",
    also: hubCardKeys(ITEMS),
  });
  return <CardGrid title="System Tools" items={visibleHubCards(ITEMS, holds)} />;
}
