// /app/src/app/(dashboard)/app/admin/import/inventory-snapshot/page.tsx
//
// Import Inventory Snapshot -- App Router port of the legacy
// admin/import/inventory-snapshot. Authenticated users only (the legacy
// withAuth() had no roles list). Reads the shared /api/inventory/clear-snapshot
// + /api/import/inventory-snapshot REST endpoints, which stay REST. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { InventorySnapshotImportView } from "./InventorySnapshotImportView";

export default async function InventorySnapshotImportPage() {
  await requirePage();
  return <InventorySnapshotImportView />;
}
