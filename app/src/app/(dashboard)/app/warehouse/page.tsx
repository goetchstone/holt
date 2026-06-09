// /app/src/app/(dashboard)/app/warehouse/page.tsx
//
// Warehouse hub -- App Router port of the legacy warehouse/index. MANAGER /
// ADMIN / WAREHOUSE, gated on the "warehousing" feature module (mirrors the
// legacy withAuth roles + feature). Cards self-filter by role via CardGrid;
// hrefs are unchanged so existing links keep working. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Inbound",
    description: "Purchase orders by expected delivery date. Flag missing ESDs and overdue items.",
    href: "/app/warehouse/inbound",
  },
  {
    title: "Outbound",
    description: "Upcoming deliveries, items needing scheduling, and stock transfers.",
    href: "/app/warehouse/outbound",
  },
  {
    title: "Awaiting Delivery",
    description: "Orders not yet delivered (no invoice). Shows linked PO status and age.",
    href: "/app/warehouse/awaiting-delivery",
  },
  {
    title: "Overview",
    description: "Inventory counts by store and stock location at a glance.",
    href: "/app/warehouse/overview",
    roles: ["ADMIN", "WAREHOUSE"],
  },
  {
    title: "Receiving",
    description: "Confirm received items against purchase orders.",
    href: "/app/purchasing/receiving",
    roles: ["ADMIN", "WAREHOUSE"],
  },
  {
    title: "Transfers",
    description: "Create and track inventory transfers between locations.",
    href: "/app/warehouse/transfers",
    roles: ["ADMIN", "WAREHOUSE"],
  },
  {
    title: "Consignment Rugs",
    description: "Track consignment inventory, sales, and vendor payments.",
    href: "/app/inventory/consignment",
  },
  {
    title: "Delivery Dispatch",
    description: "Plan routes, assign stops to trucks, and manage deliveries.",
    href: "/app/dispatch",
  },
  {
    title: "Returns Queue",
    description: "Inspect and restock returned items.",
    href: "/app/warehouse/returns",
    roles: ["ADMIN", "WAREHOUSE"],
  },
  {
    title: "Locations",
    description: "Manage store locations, zones, and stock positions.",
    href: "/app/warehouse/locations",
  },
];

export default async function WarehouseHubPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"], { feature: "warehousing" });
  return <CardGrid title="Warehouse" items={ITEMS} />;
}
