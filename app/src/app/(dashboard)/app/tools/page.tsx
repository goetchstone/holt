// /app/src/app/(dashboard)/app/tools/page.tsx
//
// Tools hub — App Router port of the legacy tools/index, on Change settings. A
// card shows only to a viewer holding the key of the page it opens
// (lib/auth/hubCards.ts). Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { hubCardKeys, visibleHubCards } from "@/lib/auth/hubCards";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Query Builder",
    description:
      "Explore data across sales, purchasing, products, and consignment. Filter, join, and export.",
    href: "/app/tools/query-builder",
  },
  {
    title: "Home Accessory Order Import",
    description:
      "Parse a home accessory vendor order (K&K, Wendover, MarketTime, Zodax, and others) and create draft POs and items in Buyer Drafts.",
    href: "/app/tools/home-accessory-order",
  },
  {
    title: "Product Configurator",
    description: "Browse products, select grades and options, and view retail pricing.",
    href: "/app/tools/configurator",
  },
  {
    title: "Create Project",
    description: "Set up a new customer project with Google Drive folders.",
    href: "/app/tools/create-project",
  },
  {
    title: "Legacy Archive",
    description:
      "Look up historical sales imported from a previous system by customer name, phone, address, or order number. Read-only archive.",
    href: "/app/tools/legacy-archive",
    feature: "legacyArchive",
  },
  {
    title: "Apparel Order Import",
    description:
      "Parse a vendor apparel order (PDF or CSV) into a draft Purchase Order + items in Buyer Drafts. ADMIN only.",
    href: "/app/tools/apparel-order",
  },
];

export default async function ToolsHubPage() {
  const { holds } = await requirePage(undefined, {
    permission: "admin.settings",
    also: hubCardKeys(ITEMS),
  });
  return <CardGrid title="Tools" items={visibleHubCards(ITEMS, holds)} />;
}
