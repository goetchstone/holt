// /app/src/app/(dashboard)/app/admin/setup/roles/page.tsx
//
// Roles -- the custom-role admin GUI (docs/domains/staff-auth.md). ADMIN only,
// matching its neighbour admin/setup/trade-tiers; SUPER_ADMIN satisfies that
// through decideRoleAccess. The page gate is the coarse one: the REST routes it
// talks to are each gated on the `staff.manage` permission, which is the check
// that actually decides whether a write lands.
//
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { RolesView } from "./RolesView";

export default async function RolesPage() {
  await requirePage(undefined, { permission: "admin.config" });
  return <RolesView />;
}
