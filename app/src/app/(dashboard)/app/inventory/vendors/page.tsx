// /app/src/app/(dashboard)/app/inventory/vendors/page.tsx
//
// Vendors list — App Router port of the legacy inventory/vendors/index. Any
// signed-in user (mirrors the legacy bare withAuth(), no roles/feature). Reads
// the shared /api/vendors REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { VendorsView } from "./VendorsView";

export default async function VendorsPage() {
  await requirePage();
  return <VendorsView />;
}
