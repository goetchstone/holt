// /app/src/app/(dashboard)/app/admin/staff/page.tsx
//
// Staff Management -- App Router page-only port of the legacy admin/staff.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). View, add, edit,
// deactivate, and set local passwords for staff members via the shared /api/staff
// + /api/admin/staff REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { StaffView } from "./StaffView";

export default async function StaffManagementPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <StaffView />;
}
