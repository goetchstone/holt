// /app/src/app/(dashboard)/app/inventory/page.tsx
//
// Inventory hub — App Router port of the legacy inventory/index. Any signed-in
// user (cards self-filter by role via CardGrid; legacy had none). Gated on the
// "warehousing" feature module, matching the legacy withAuth feature option.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Consignment Rugs",
    description: "Track consignment inventory, sales, approvals, and vendor payments.",
    href: "/app/inventory/consignment",
  },
  {
    title: "Physical Inventory Hub",
    description: "Start a count, run reports, and manage inventory data.",
    href: "/app/inventory/hub",
  },
  {
    title: "Create New Product",
    description: "Start creating a new basic, variant, or configurable product.",
    href: "/app/inventory/products/new",
  },
  {
    title: "Products",
    description: "View and manage product catalog",
    href: "/app/inventory/products",
  },
  {
    title: "Vendors",
    description: "Manage product vendors",
    href: "/app/inventory/vendors",
  },
  {
    title: "Categories",
    description: "Manage product categories",
    href: "/app/inventory/categories",
  },
  {
    title: "Types",
    description: "Manage product types",
    href: "/app/inventory/types",
  },
  {
    title: "Departments",
    description: "Manage product departments",
    href: "/app/inventory/departments",
  },
];

export default async function InventoryIndexPage() {
  await requirePage(undefined, { feature: "warehousing" });
  return <CardGrid title="Inventory" items={ITEMS} />;
}
