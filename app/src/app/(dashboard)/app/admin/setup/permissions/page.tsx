// /app/src/app/(dashboard)/app/admin/setup/permissions/page.tsx
//
// Nav Permissions -- App Router port of the legacy admin/setup/permissions.
// ADMIN only (mirrors the legacy withAuth roles). Reads the shared
// /api/admin/permissions REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { PermissionsView } from "./PermissionsView";

export default async function PermissionsPage() {
  await requirePage(["ADMIN"]);
  return <PermissionsView />;
}
