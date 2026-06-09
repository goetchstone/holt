// /app/src/app/(dashboard)/app/admin/gift-cards/page.tsx
//
// Gift Cards lookup -- App Router page-only port of the legacy
// admin/gift-cards/index. MANAGER / ADMIN (mirrors the legacy withAuth roles).
// Reads the shared /api/gift-cards/lookup REST endpoint. Chrome from the
// (dashboard) layout. Coexists with the [id] detail + import sub-routes.

import { requirePage } from "@/lib/auth/requirePage";
import { GiftCardsView } from "./GiftCardsView";

export default async function GiftCardsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <GiftCardsView />;
}
