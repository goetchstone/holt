// /app/src/app/(dashboard)/app/admin/sales/goals/page.tsx
//
// Per-salesperson yearly goals + bonus rate -- App Router page-only port of the
// legacy admin/sales/goals. MANAGER / ADMIN (mirrors the legacy withAuth roles).
// Reads + writes the shared /api/admin/sales/goals + /api/staff REST endpoints,
// which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { SalesGoalsView } from "./SalesGoalsView";

export default async function SalesGoalsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <SalesGoalsView />;
}
