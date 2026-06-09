// /app/src/app/(dashboard)/app/admin/pricing/import/wesley-hall/page.tsx
//
// Backward-compat redirect -- App Router port of the legacy
// admin/pricing/import/wesley-hall. MANAGER / ADMIN (mirrors the legacy withAuth
// roles). Sends visitors to the generic import page with Wesley Hall
// pre-selected. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { WesleyHallImportRedirect } from "./WesleyHallImportRedirect";

export default async function WesleyHallImportRedirectPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <WesleyHallImportRedirect />;
}
