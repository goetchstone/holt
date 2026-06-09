// /app/src/app/(dashboard)/app/tools/page.tsx
//
// Tools hub — App Router port of the legacy tools/index. Any signed-in user
// (cards self-filter by role via CardGrid; Query Builder is ADMIN-only). Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Query Builder",
    description:
      "Explore data across sales, purchasing, products, and consignment. Filter, join, and export.",
    href: "/app/tools/query-builder",
    roles: ["ADMIN"],
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
];

export default async function ToolsHubPage() {
  await requirePage();
  return <CardGrid title="Tools" items={ITEMS} />;
}
