// /app/src/app/(dashboard)/app/admin/settings/integrations/page.tsx
//
// Integrations -- ADMIN only (mirrors Settings' own gate). Moved out of the
// single Settings page into its own route; behavior and the
// /api/admin/settings/integrations{,/test} contract are unchanged.

import { requirePage } from "@/lib/auth/requirePage";
import { isPracticeCopy, PRACTICE_COPY_NO_CONNECTIONS } from "@/lib/practiceCopy";
import { IntegrationsView } from "./IntegrationsView";

export default async function IntegrationsPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  if (isPracticeCopy()) return <p className="text-sm">{PRACTICE_COPY_NO_CONNECTIONS}</p>;
  return <IntegrationsView />;
}
