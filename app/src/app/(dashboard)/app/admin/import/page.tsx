// /app/src/app/(dashboard)/app/admin/import/page.tsx
//
// Import Tools hub -- App Router port of the legacy admin/import/index, on
// Destructive data operations. A card shows only to a viewer holding the key of
// the page it opens (lib/auth/hubCards.ts); hrefs are unchanged so existing
// links keep working. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { hubCardKeys, visibleHubCards } from "@/lib/auth/hubCards";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Import Data (CSV)",
    description:
      "Upload a customer list or product catalog exported from any system, map its columns to the right fields, and import. The configurable, source-agnostic importer.",
    href: "/app/admin/import/data",
  },
  {
    title: "Inventory Snapshot (Historical)",
    description:
      "Import a point-in-time inventory snapshot for audit/history. Writes to InventorySnapshot, a historical record kept separate from live inventory positions.",
    href: "/app/admin/import/inventory-snapshot",
  },
  {
    title: "Windfall Enrichment",
    description: "Import wealth and lifestyle data from Windfall-enriched customer CSVs.",
    href: "/app/admin/import/windfall",
  },
  {
    title: "Customer Service Sheet",
    description:
      "Sync the Excel-based Customer Service Sheet (active + completed cases + threaded comments) into the ERP's ServiceCase + ServiceCaseNote tables. Idempotent -- re-uploading the same file only applies deltas.",
    href: "/app/admin/import/service-cases",
  },
  {
    title: "Consignment Import",
    description: "Import consignment data from CSV exports (items, sales history, payments).",
    href: "/app/admin/import/consignment",
  },
];

export default async function ImportToolsHubPage() {
  const { holds } = await requirePage(undefined, {
    permission: "admin.data",
    also: hubCardKeys(ITEMS),
  });
  return <CardGrid title="Import Tools" items={visibleHubCards(ITEMS, holds)} />;
}
