// /app/src/app/(dashboard)/app/admin/pricing/options/page.tsx
//
// Manage Vendor Options -- App Router port of the legacy admin/pricing/options.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Add, edit, and delete
// vendor-level option groups and their surcharges against the shared
// /api/pricing/options REST endpoint, which stays REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { OptionsView } from "./OptionsView";

export default async function PricingOptionsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <OptionsView />;
}
