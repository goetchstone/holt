// /app/src/app/(dashboard)/app/admin/goals/page.tsx
//
// Sales goals (company / department / category) -- App Router page-only port of
// the legacy admin/goals. MANAGER / ADMIN (mirrors the legacy withAuth roles).
// Reads + writes the shared /api/goals REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { GoalsView } from "./GoalsView";

export default async function GoalsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <GoalsView />;
}
