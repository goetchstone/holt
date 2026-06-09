// /app/src/app/(dashboard)/app/sales/proposals/page.tsx
//
// B2B Proposals list — App Router port of the legacy sales/proposals/index.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/proposals REST endpoint, which stays REST. Chrome from the (dashboard)
// layout. The proposal detail route (/sales/proposals/[id]) is a distinct nested
// path — no collision with this list path.

import { requirePage } from "@/lib/auth/requirePage";
import { ProposalsListView } from "./ProposalsListView";

export default async function ProposalsListPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <ProposalsListView />;
}
