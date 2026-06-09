// /app/src/app/(dashboard)/app/time/page.tsx
//
// Time-tracking page. Gated behind the "timeTracking" feature. Any of the
// listed roles can log + see their own time; ADMIN/MANAGER/SUPER_ADMIN also get
// the team view. The privileged flag is resolved server-side and passed down.

import { requirePage } from "@/lib/auth/requirePage";
import { TimeTrackingView } from "./TimeTrackingView";

export default async function TimePage() {
  const { role } = await requirePage(["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER"], {
    feature: "timeTracking",
  });
  const canSeeAll = ["SUPER_ADMIN", "ADMIN", "MANAGER"].includes(role);
  return <TimeTrackingView canSeeAll={canSeeAll} />;
}
