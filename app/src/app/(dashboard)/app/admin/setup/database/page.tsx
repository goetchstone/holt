// /app/src/app/(dashboard)/app/admin/setup/database/page.tsx
//
// Database Backup & Restore -- App Router port of the legacy
// admin/setup/database. ADMIN only (mirrors the legacy withAuth roles). Reads
// the shared /api/admin/database/{backup,restore} REST endpoints. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DatabaseBackupView } from "./DatabaseBackupView";

export default async function DatabaseBackupPage() {
  await requirePage(["ADMIN"]);
  return <DatabaseBackupView />;
}
