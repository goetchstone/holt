// /app/src/app/(dashboard)/app/admin/buyer-drafts/buy/[id]/performance/page.tsx
//
// Per-Buy performance + compare-to-last-buy dashboard -- App Router page-only
// port of the legacy admin/buyer-drafts/buy/[id]/performance. ADMIN only
// (mirrors the legacy withAuth roles + the CLAUDE.md ADMIN-only buyer-drafts
// gate). Reads the shared /api/admin/buyer-drafts/buys/[id]/performance +
// /linked-pos REST endpoints, which stay REST. In Next 16 `params` is a Promise,
// so it must be awaited before reading id. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { BuyPerformanceView } from "./BuyPerformanceView";

export default async function BuyPerformancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(["ADMIN"]);
  return <BuyPerformanceView id={id} />;
}
