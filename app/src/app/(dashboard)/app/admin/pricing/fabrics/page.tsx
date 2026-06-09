// /app/src/app/(dashboard)/app/admin/pricing/fabrics/page.tsx
//
// Fabric Catalog -- App Router port of the legacy admin/pricing/fabrics.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Browse, search, and
// import vendor fabric catalogs that map to grade tiers, against the shared
// /api/pricing/* and /api/vendors REST endpoints, which stay REST. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { FabricsView } from "./FabricsView";

export default async function PricingFabricsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <FabricsView />;
}
