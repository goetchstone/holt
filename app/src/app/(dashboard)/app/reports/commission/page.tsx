// /app/src/app/(dashboard)/app/reports/commission/page.tsx
//
// Team Commission — App Router + tRPC port. SUPER_ADMIN-only (tabled per owner
// direction 2026-05-29 until management adopts it). View-only locked payouts.

import { requirePage } from "@/lib/auth/requirePage";
import { CommissionView } from "./CommissionView";

export default async function CommissionPage() {
  await requirePage(["SUPER_ADMIN"]);
  return <CommissionView />;
}
