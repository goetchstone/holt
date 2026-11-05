// /app/src/app/(dashboard)/app/reports/inventory-value/page.tsx
//
// Inventory Value: what was on the books at the end of a past day
// (lib/reports/inventoryValue.ts). MANAGER/ADMIN, like Inventory Health. The
// server page loads the stores for the picker and the store's day, which is the
// latest date the report can be run for; the view reads the report over tRPC.

import { prisma } from "@/lib/prisma";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { requirePage } from "@/lib/auth/requirePage";
import { businessDayKey } from "@/lib/reports/businessDay";
import { InventoryValueView } from "./InventoryValueView";

export default async function InventoryValuePage() {
  await requirePage(["MANAGER", "ADMIN"]);
  const [stores, timeZone] = await Promise.all([
    prisma.storeLocation.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getBusinessTimeZone(),
  ]);
  return <InventoryValueView stores={stores} today={businessDayKey(new Date(), timeZone)} />;
}
