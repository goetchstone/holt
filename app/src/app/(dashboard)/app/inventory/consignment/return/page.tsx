// /app/src/app/(dashboard)/app/inventory/consignment/return/page.tsx
//
// Consignment Return-to-Vendor scanner — App Router port of the legacy
// inventory/consignment/return. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). The legacy page used ScannerLayout (next/router
// + next/head), which is App-Router-incompatible; the focused scanner feel is
// preserved by a small local header band inside the client view, with the
// dashboard nav still supplied by the (dashboard) layout. Reads + mutates the
// shared /api/consignment/scan + /api/consignment/return-items REST endpoints,
// which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ConsignmentReturnView } from "./ConsignmentReturnView";

export default async function ConsignmentReturnPage() {
  await requirePage();
  return <ConsignmentReturnView />;
}
