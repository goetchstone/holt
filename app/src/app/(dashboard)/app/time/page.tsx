// /app/src/app/(dashboard)/app/time/page.tsx
//
// Time-tracking page. Gated behind the "timeTracking" feature.
//
// Everyone who can hold a shift can reach this: it logs YOUR OWN time, which is
// what the staff.self baseline exists for, and gating it on a role list left it
// dead for REGISTER, WAREHOUSE, INSTALLER and MARKETING -- the people most
// likely to be clocking in. The nav entry is derived from the same permission,
// so the link and the page agree.
//
// Seeing everyone else's time is a separate capability, and staff.time is
// literally "Edit time entries and shifts". Resolved server-side through the
// same resolver the API guards use, so the team view cannot be turned on by a
// stale token.

import { requirePage } from "@/lib/auth/requirePage";
import { resolvePermissionAccess } from "@/lib/auth/permissionResolver";
import { cookies } from "next/headers";
import { TimeTrackingView } from "./TimeTrackingView";

export default async function TimePage() {
  const { userId } = await requirePage(undefined, {
    permission: "staff.self",
    feature: "timeTracking",
  });
  const impersonate = (await cookies()).get("sh-impersonate")?.value ?? null;
  const { allowed: canSeeAll } = await resolvePermissionAccess({
    userId,
    permission: "staff.time",
    impersonate,
  });
  return <TimeTrackingView canSeeAll={canSeeAll} />;
}
