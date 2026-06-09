// /app/src/app/(dashboard)/app/admin/setup/gift-cards/page.tsx
//
// Gift Card Presets -- App Router port of the legacy admin/setup/gift-cards.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/gift-cards/presets REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { GiftCardPresetsView } from "./GiftCardPresetsView";

export default async function GiftCardPresetsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <GiftCardPresetsView />;
}
