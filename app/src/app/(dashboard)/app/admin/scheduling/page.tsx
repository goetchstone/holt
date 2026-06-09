// /app/src/app/(dashboard)/app/admin/scheduling/page.tsx
//
// Scheduling admin (ADMIN, gated behind the "booking" feature): manage the
// bookable Service catalog, weekly availability windows, and time-off blocks
// that drive the public /book slot picker.

import { requirePage } from "@/lib/auth/requirePage";
import { SchedulingView } from "./SchedulingView";

export default async function SchedulingPage() {
  await requirePage(["SUPER_ADMIN", "ADMIN"], { feature: "booking" });
  return <SchedulingView />;
}
