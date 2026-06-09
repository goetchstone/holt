// /app/src/app/(dashboard)/app/inventory/physical-count/page.tsx
//
// Physical Count scanner — App Router port of the legacy
// inventory/physical-count. Any signed-in user (legacy bare withAuth, no
// roles/feature). The legacy page used ScannerLayout (next/router + next/head),
// which is App-Router-incompatible; the focused register feel is preserved by a
// small local header band inside the client view, with the dashboard nav still
// supplied by the (dashboard) layout. Reads the shared /api/inventory/* +
// /api/products REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { PhysicalCountView } from "./PhysicalCountView";

export default async function PhysicalCountPage() {
  await requirePage();
  return <PhysicalCountView />;
}
