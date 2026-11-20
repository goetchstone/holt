// /app/src/app/(dashboard)/app/admin/staff/page.tsx
//
// Staff Management -- App Router page-only port of the legacy admin/staff.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). View, add, edit,
// deactivate, and set local passwords for staff members via the shared /api/staff
// + /api/admin/staff REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { COMMISSION_PAY } from "@/lib/auth/commissionPay";
import { StaffView } from "./StaffView";

export default async function StaffManagementPage() {
  const access = await requirePage(undefined, {
    permission: "staff.manage",
    also: [COMMISSION_PAY],
  });
  // The plan pickers need the commission-plans API, which needs this key; asking
  // it of a caller without the key would only be refused.
  return <StaffView canAssignCommissionPlans={access.holds[COMMISSION_PAY]} />;
}
