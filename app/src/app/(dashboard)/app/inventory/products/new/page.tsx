// /app/src/app/(dashboard)/app/inventory/products/new/page.tsx
//
// "Choose product type" hub — App Router port of the legacy
// inventory/products/new. Any signed-in user (legacy bare withAuth, no
// roles/feature). Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
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
  {
    title: "Create Complex Configurable Product",
    description: "For highly customizable items with multiple options and upcharges.",
    href: "/app/inventory/products/configure",
  },
];

export default async function NewProductOptionsPage() {
  await requirePage();
  return <CardGrid title="Choose Product Type" items={ITEMS} />;
}
