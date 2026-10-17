// /app/src/app/(dashboard)/app/admin/reports/commission-tiers/page.tsx
//
// Commission -- SUPER_ADMIN ONLY. App Router page-only port of the legacy
// admin/reports/commission-tiers. Owner-confidential: reached from Reports ->
// Commission, which is shown to the owner alone and opens the Locked tab
// (?tab=locked). Reads the shared /api/admin/reports/commission-tiers REST
// endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { CommissionTiersView } from "./CommissionTiersView";
import { commissionTabFrom } from "./tabs";

export default async function CommissionTiersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  await requirePage(undefined, { permission: "admin.settings" });
  const { tab } = await searchParams;
  return <CommissionTiersView initialTab={commissionTabFrom(tab)} />;
}
