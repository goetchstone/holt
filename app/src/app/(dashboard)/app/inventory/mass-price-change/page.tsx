// /app/src/app/(dashboard)/app/inventory/mass-price-change/page.tsx
//
// Mass price change (GAP-06, DECISIONS 58): pick products by vendor,
// department, category, text or lock, then reprice them from cost x markup, by
// a percent or to an amount, set or clear their was price, or lock and unlock
// them. Gated on "Change pricing", like every route it calls
// (/api/pricing/mass-change/*). Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { MassPriceChangeView } from "./MassPriceChangeView";

export default async function MassPriceChangePage() {
  await requirePage(undefined, { permission: "catalog.pricing" });
  return <MassPriceChangeView />;
}
