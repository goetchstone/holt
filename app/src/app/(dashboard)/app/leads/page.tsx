// /app/src/app/(dashboard)/app/leads/page.tsx
//
// Leads board -- App Router port. Opens on "Work leads" (sales.lead), the key of
// /api/leads. Reads the shared /api/leads, /api/leads/from-campaign,
// /api/leads/needs-attention, /api/mailchimp/campaigns, and /api/staff REST
// endpoints; those stay REST. The page is gated server-side, and answers two
// more keys for the board: "View marketing" (marketing.read) shows the
// needs-attention strip, whose route requires it, and "Run marketing"
// (marketing.write) shows pin, assign and delete, which the delete route
// requires.

import { requirePage } from "@/lib/auth/requirePage";
import { LeadsView } from "./LeadsView";

export default async function LeadsPage() {
  const { holds } = await requirePage(undefined, {
    permission: "sales.lead",
    also: ["marketing.read", "marketing.write"],
  });
  return (
    <LeadsView
      canSeeAttention={holds["marketing.read"]}
      canManageLeads={holds["marketing.write"]}
    />
  );
}
