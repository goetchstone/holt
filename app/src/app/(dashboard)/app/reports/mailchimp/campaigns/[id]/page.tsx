// /app/src/app/(dashboard)/app/reports/mailchimp/campaigns/[id]/page.tsx
//
// Mailchimp campaign detail — App Router port. Any signed-in user (matches the
// legacy bare withAuth() gate). Reads shared /api/mailchimp/* REST endpoints
// (also used by the admin mailchimp-sync surface). In Next 16 `params` is a
// Promise, so it must be awaited before reading the dynamic id.

import { requirePage } from "@/lib/auth/requirePage";
import { CampaignDetailView } from "./CampaignDetailView";

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <CampaignDetailView id={id} />;
}
