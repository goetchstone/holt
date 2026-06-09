// /app/src/app/(dashboard)/app/leads/page.tsx
//
// Leads board -- App Router port. MANAGER/ADMIN/DESIGNER (matches the legacy
// withAuth roles). Reads the shared /api/leads, /api/leads/from-campaign,
// /api/leads/needs-attention, /api/mailchimp/campaigns, and /api/staff REST
// endpoints; those stay REST. The page is gated server-side.

import { requirePage } from "@/lib/auth/requirePage";
import { LeadsView } from "./LeadsView";

export default async function LeadsPage() {
  await requirePage(["MANAGER", "ADMIN", "DESIGNER"]);
  return <LeadsView />;
}
