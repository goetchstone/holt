// /app/src/app/(dashboard)/app/admin/buyer-drafts/page.tsx
//
// Buyer's drafts workbench -- App Router page-only port of the legacy
// admin/buyer-drafts/index.tsx. ADMIN only (mirrors the legacy
// withAuth(undefined, { roles: ["ADMIN"] }) + the CLAUDE.md ADMIN-only
// buyer-drafts gate). Reads the shared /api/admin/buyer-drafts/* REST endpoints,
// which stay REST. Chrome from the (dashboard) layout. Suspense wraps the view
// because it reads useSearchParams (?buyId deep-link from the archive page).

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { BuyerDraftsView } from "./BuyerDraftsView";

export default async function BuyerDraftsPage() {
  await requirePage(["ADMIN"]);
  return (
    <Suspense>
      <BuyerDraftsView />
    </Suspense>
  );
}
