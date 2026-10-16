// /app/src/app/(dashboard)/app/admin/inventory-exceptions/page.tsx
//
// Oversell queue: InventoryException rows, sales that went through with less
// free stock than requested, to resolve by hand. Gated on the same key as the
// API it reads (/api/admin/inventory-exceptions, inventory.adjust); it was on
// admin.settings, so a role could reach one without the other. The grouped
// view with suggested fixes is Reports > Oversold.

import { requirePage } from "@/lib/auth/requirePage";
import { InventoryExceptionsView } from "./InventoryExceptionsView";

export default async function InventoryExceptionsPage() {
  await requirePage(undefined, { permission: "inventory.adjust" });
  return <InventoryExceptionsView />;
}
