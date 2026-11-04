// /app/src/app/(dashboard)/app/inventory/vendors/page.tsx
//
// Vendors list — App Router port of the legacy inventory/vendors/index.
// Whoever reads inventory sees it; a holder of admin.data also merges
// duplicate vendors and forgets a merged vendor's old name (GAP-22). Reads the
// shared /api/vendors REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { VendorsView } from "./VendorsView";

export default async function VendorsPage() {
  const { holds } = await requirePage(undefined, {
    permission: "inventory.read",
    also: ["admin.data"],
  });
  return <VendorsView canMerge={holds["admin.data"]} />;
}
