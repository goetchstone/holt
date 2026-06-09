// /app/src/app/(dashboard)/app/sales/returns/page.tsx
//
// Returns list — App Router port of the legacy sales/returns/index. Any signed-in
// user (mirrors the legacy withAuth() with no roles). Reads the shared
// /api/returns REST endpoint, which stays REST. Chrome from the (dashboard)
// layout. The return detail + new-return routes stay in Pages Router
// (/sales/returns/[id], /sales/returns/new) — no collision with this list path.

import { requirePage } from "@/lib/auth/requirePage";
import { ReturnsListView } from "./ReturnsListView";

export default async function ReturnsListPage() {
  await requirePage();
  return <ReturnsListView />;
}
