// /app/src/app/(dashboard)/app/admin/setup/referral-sources/page.tsx
//
// Settings -> Referral sources (GAP-08): how customers hear of the store, a
// list the store sets up for itself. Gated on admin.settings, the key
// /api/referral-sources writes with. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ReferralSourcesView } from "./ReferralSourcesView";

export default async function ReferralSourcesPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  return <ReferralSourcesView />;
}
