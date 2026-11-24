// /app/src/app/(dashboard)/app/inventory/products/new/page.tsx
//
// "Choose product type" hub — App Router port of the legacy
// inventory/products/new, on Edit catalog. A card shows only to a viewer
// holding the key of the page it opens (lib/auth/hubCards.ts). Chrome from the
// (dashboard) layout.
//
// The legacy hub also offered "Create Complex Configurable Product" at
// /app/inventory/products/configure. No such page exists: that URL opened the
// product detail page for a product with the id "configure", so the card is gone.

import { requirePage } from "@/lib/auth/requirePage";
import { hubCardKeys, visibleHubCards } from "@/lib/auth/hubCards";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Create Basic Product",
    description: "For simple, non-configurable items with standard attributes.",
    href: "/app/inventory/products/create-basic",
  },
  {
    title: "Create Simple Variant Product",
    description: "For products with a limited set of pre-defined variations.",
    href: "/app/inventory/products/create-variant",
  },
];

export default async function NewProductOptionsPage() {
  const { holds } = await requirePage(undefined, {
    permission: "catalog.write",
    also: hubCardKeys(ITEMS),
  });
  return <CardGrid title="Choose Product Type" items={visibleHubCards(ITEMS, holds)} />;
}
