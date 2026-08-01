// /app/src/app/(dashboard)/app/tools/apparel-order/page.tsx
//
// Apparel Order Import -- App Router tool that parses a vendor apparel
// order (PDF or CSV) and creates a BuyerDraftPurchaseOrder + BuyerDraftItem
// rows for the buyer to curate in the existing Buyer Drafts workbench.
// ADMIN-only, mirroring the buyer-drafts domain gate
// (docs/domains/buyer-drafts.md: "ADMIN-only — designers and managers
// don't see it") since this tool writes directly into that domain.

import { requirePage } from "@/lib/auth/requirePage";
import { ApparelOrderView } from "./ApparelOrderView";

export default async function ApparelOrderPage() {
  await requirePage(["ADMIN"]);
  return <ApparelOrderView />;
}
