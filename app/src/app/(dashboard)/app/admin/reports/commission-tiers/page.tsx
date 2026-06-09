// /app/src/app/(dashboard)/app/admin/reports/commission-tiers/page.tsx
//
// Commission tier report -- SUPER_ADMIN ONLY. App Router page-only port of the
// legacy admin/reports/commission-tiers. Owner-confidential; not surfaced in
// any hub page (direct-URL access only). Reads the shared
// /api/admin/reports/commission-tiers REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { CommissionTiersView } from "./CommissionTiersView";

export default async function CommissionTiersPage() {
  await requirePage(["SUPER_ADMIN"]);
  return <CommissionTiersView />;
}
