// /app/src/app/(dashboard)/app/warehouse/transfers/new/page.tsx
//
// New transfer (create an inventory transfer between locations) -- App Router
// port. "Transfer stock" (inventory.transfer), the key of the create route.
// Reads the shared /api/store-locations/stock-locations +
// /api/warehouse/transfers REST endpoints, which stay REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { NewTransferView } from "./NewTransferView";

export default async function NewTransferPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <NewTransferView />;
}
