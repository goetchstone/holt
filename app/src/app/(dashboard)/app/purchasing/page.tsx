// /app/src/app/(dashboard)/app/purchasing/page.tsx
//
// Purchasing hub -- App Router port of the legacy purchasing/index, on View
// purchasing, and the "purchasing" feature module must be enabled. A card shows
// only to a viewer holding the key of the page it opens (lib/auth/hubCards.ts);
// hrefs are unchanged so existing links keep working. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { hubCardKeys, visibleHubCards } from "@/lib/auth/hubCards";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Needs Ordering",
    description: "Sales orders that need purchase orders created",
    href: "/app/purchasing/needs-ordering",
  },
  {
    title: "Low Stock",
    description: "What's below the level you keep, store by store, and ordering more of it.",
    href: "/app/purchasing/low-stock",
  },
  {
    title: "Purchase Orders",
    description: "View and track all purchase orders",
    href: "/app/purchasing/orders",
  },
  {
    title: "Receiving",
    description: "View receiving records and deliveries",
    href: "/app/purchasing/receiving",
  },
  {
    title: "Import Order",
    description: "Import wholesale orders from CSV or PDF",
    href: "/app/purchasing/import-order",
  },
  {
    title: "Vendor Returns",
    description: "Track items returned to vendors for credit",
    href: "/app/purchasing/orders?filter=returns",
  },
];

export default async function PurchasingHubPage() {
  const { holds } = await requirePage(undefined, {
    permission: "purchasing.read",
    feature: "purchasing",
    also: hubCardKeys(ITEMS),
  });
  return <CardGrid title="Purchasing" items={visibleHubCards(ITEMS, holds)} />;
}
