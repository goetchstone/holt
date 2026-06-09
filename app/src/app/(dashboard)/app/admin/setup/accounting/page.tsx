// /app/src/app/(dashboard)/app/admin/setup/accounting/page.tsx
//
// Chart of Accounts -- App Router port of the legacy admin/setup/accounting.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/accounting/{gl-accounts,account-groups,system-gl-mappings} REST
// endpoints. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { AccountingView } from "./AccountingView";

export default async function AccountingAdminPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <AccountingView />;
}
