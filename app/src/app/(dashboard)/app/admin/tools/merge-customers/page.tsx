// /app/src/app/(dashboard)/app/admin/tools/merge-customers/page.tsx
//
// Merge Duplicate Customers -- App Router port. MANAGER / ADMIN (mirrors the
// legacy withAuth roles). Reads the shared /api/customers/merge-duplicates REST
// endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { MergeCustomersView } from "./MergeCustomersView";

export default async function MergeCustomersPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <MergeCustomersView />;
}
