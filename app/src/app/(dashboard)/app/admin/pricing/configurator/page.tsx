// /app/src/app/(dashboard)/app/admin/pricing/configurator/page.tsx
//
// Price Configurator -- App Router port of the legacy admin/pricing/configurator.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Select a vendor, pick a
// grade, toggle options, and watch the price build up in real time against the
// shared /api/pricing/* and /api/vendors/* REST endpoints, which stay REST.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ConfiguratorView } from "./ConfiguratorView";

export default async function PricingConfiguratorPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <ConfiguratorView />;
}
