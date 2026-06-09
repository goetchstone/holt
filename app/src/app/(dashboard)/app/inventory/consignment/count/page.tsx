// /app/src/app/(dashboard)/app/inventory/consignment/count/page.tsx
//
// Consignment Count scanner — App Router port of the legacy
// inventory/consignment/count. Any signed-in user (legacy bare withAuth, no
// roles/feature). The legacy page used ScannerLayout (next/router + next/head),
// which is App-Router-incompatible; the focused scanner feel is preserved by a
// small local header band inside the client view, with the dashboard nav still
// supplied by the (dashboard) layout. Reads the shared /api/consignment/* REST
// endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ConsignmentCountView } from "./ConsignmentCountView";

export default async function ConsignmentCountPage() {
  await requirePage();
  return <ConsignmentCountView />;
}
