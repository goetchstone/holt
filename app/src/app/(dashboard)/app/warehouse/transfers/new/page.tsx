// /app/src/app/(dashboard)/app/warehouse/transfers/new/page.tsx
//
// New transfer (create an inventory transfer between locations) -- App Router
// port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads
// the shared /api/warehouse/locations + /api/warehouse/transfers REST endpoints,
// which stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { NewTransferView } from "./NewTransferView";

export default async function NewTransferPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <NewTransferView />;
}
