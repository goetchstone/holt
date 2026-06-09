// /app/src/app/(dashboard)/app/admin/pricing/page.tsx
//
// Vendor Pricing hub -- App Router port of the legacy admin/pricing/index.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Cards link to the import
// wizard, fabric catalog, configurator, options, and style editor. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const sections: CardGridItem[] = [
  {
    title: "Import Price Books",
    description: "Upload wholesale price lists for Wesley Hall, C R Laine, and other vendors.",
    href: "/app/admin/pricing/import",
  },
  {
    title: "Fabric Catalog",
    description:
      "Browse, search, and import fabric catalogs. Each fabric maps to a vendor grade tier for pricing.",
    href: "/app/admin/pricing/fabrics",
  },
  {
    title: "Price Configurator",
    description:
      "Select a product, pick a grade, toggle options, and see prices build up in real time.",
    href: "/app/admin/pricing/configurator",
  },
  {
    title: "Manage Options",
    description:
      "Add, edit, or remove vendor-level option groups and surcharges (trims, cushions, finishes).",
    href: "/app/admin/pricing/options",
  },
  {
    title: "Style Editor",
    description:
      "View and correct imported style data: images, dimensions, construction, yardage, and options.",
    href: "/app/admin/pricing/style-editor",
  },
];

export default async function PricingHubPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CardGrid title="Vendor Pricing" items={sections} />;
}
