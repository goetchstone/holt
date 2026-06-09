// /app/src/app/(dashboard)/app/admin/setup/trade-tiers/page.tsx
//
// Trade Tiers -- App Router port of the legacy admin/setup/trade-tiers.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/admin/trade-tiers REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TradeTiersView } from "./TradeTiersView";

export default async function TradeTiersPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <TradeTiersView />;
}
