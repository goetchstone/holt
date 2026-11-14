// /app/src/app/(dashboard)/app/inventory/sales/page.tsx
//
// Scheduled sales (GAP-06 part B, DECISIONS 60): give products a sale price over a
// run of the store's days, see which tags change today and print them. Gated on
// "Change pricing", like every /api/pricing/sales route it calls; printing the
// tags is the batch print route's own permission. Chrome from the (dashboard)
// layout.

import { requirePage } from "@/lib/auth/requirePage";
import { SalesView } from "./SalesView";

export default async function SalesPage() {
  await requirePage(undefined, { permission: "catalog.pricing" });
  return <SalesView />;
}
