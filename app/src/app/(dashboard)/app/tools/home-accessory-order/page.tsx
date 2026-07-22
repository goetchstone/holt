// /app/src/app/(dashboard)/app/tools/home-accessory-order/page.tsx
//
// Home Accessory Order Import — App Router page. ADMIN-only, matching the
// Buyer Drafts domain this tool feeds (docs/domains/buyer-drafts.md:
// "ADMIN-only — designers and managers don't see it").

import { requirePage } from "@/lib/auth/requirePage";
import { HomeAccessoryOrderView } from "./HomeAccessoryOrderView";

export default async function HomeAccessoryOrderPage() {
  await requirePage(["ADMIN"]);
  return <HomeAccessoryOrderView />;
}
