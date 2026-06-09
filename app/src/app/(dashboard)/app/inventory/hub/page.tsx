// /app/src/app/(dashboard)/app/inventory/hub/page.tsx
//
// Physical Inventory Hub — App Router port of the legacy inventory/hub. Any
// signed-in user (legacy bare withAuth, no roles/feature). The view reads the
// shared /api/inventory/* REST endpoints, which stay REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { InventoryHubView } from "./InventoryHubView";

export default async function InventoryHubPage() {
  await requirePage();
  return <InventoryHubView />;
}
