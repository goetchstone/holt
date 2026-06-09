// /app/src/app/(dashboard)/app/admin/tools/page.tsx
//
// System Tools hub -- App Router port of the legacy admin/tools/index. MANAGER /
// ADMIN (mirrors the legacy withAuth roles). Cards self-filter by role via
// CardGrid; hrefs are unchanged so existing links keep working. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
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
    roles: ["ADMIN"],
  },
  {
    title: "Buyer Drafts",
    description:
      "Pre-the POS item + PO workbench. Buyer creates drafts here while specs are still in flight, then exports to the POS-format CSVs. ADMIN only.",
    href: "/app/admin/buyer-drafts",
    roles: ["ADMIN"],
  },
];

export default async function AdminToolsHubPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CardGrid title="System Tools" items={ITEMS} />;
}
