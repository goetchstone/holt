// /app/src/app/(dashboard)/app/admin/inventory-exceptions/page.tsx
//
// Oversell queue -- MANAGER / ADMIN (back-office work). Lists InventoryException
// rows: sales that went through with less free stock than requested. Reads
// the shared /api/admin/inventory-exceptions REST endpoint.

import { requirePage } from "@/lib/auth/requirePage";
import { InventoryExceptionsView } from "./InventoryExceptionsView";

export default async function InventoryExceptionsPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  return <InventoryExceptionsView />;
}
