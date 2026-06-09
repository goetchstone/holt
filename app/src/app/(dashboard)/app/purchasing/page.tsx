// /app/src/app/(dashboard)/app/purchasing/page.tsx
//
// Purchasing hub -- App Router port of the legacy purchasing/index.
// MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles) and the
// "purchasing" feature module must be enabled. Cards self-filter by role via
// CardGrid; hrefs are unchanged so existing links keep working. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Needs Ordering",
    description: "Sales orders that need purchase orders created",
    href: "/app/purchasing/needs-ordering",
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
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"], { feature: "purchasing" });
  return <CardGrid title="Purchasing" items={ITEMS} />;
}
