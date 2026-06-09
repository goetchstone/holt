// /app/src/app/(dashboard)/app/admin/buyer-drafts/archive/page.tsx
//
// Buyer-drafts archive (Past Buys) -- App Router page-only port of the legacy
// admin/buyer-drafts/archive. ADMIN only (mirrors the legacy withAuth roles +
// the CLAUDE.md ADMIN-only buyer-drafts gate). Reads the shared
// /api/admin/buyer-drafts/buys/archive REST endpoint, which stays REST. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { BuyerDraftsArchiveView } from "./BuyerDraftsArchiveView";

export default async function BuyerDraftsArchivePage() {
  await requirePage(["ADMIN"]);
  return <BuyerDraftsArchiveView />;
}
