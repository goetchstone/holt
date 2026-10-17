// /app/src/app/(dashboard)/app/reports/commission/page.tsx
//
// The old Team Commission report, folded into Commission on 2026-10-17.
//
// It was a read-only, owner-only copy of Commission -> Locked: designers only,
// no date range, no drafts, no paid-date editing. Everything it showed, the
// Locked tab shows with more. The URL is kept so a bookmark lands there.

import { redirect } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";

export default async function CommissionPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  redirect("/app/admin/reports/commission-tiers?tab=locked");
}
