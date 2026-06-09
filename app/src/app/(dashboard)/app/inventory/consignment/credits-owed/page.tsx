// /app/src/app/(dashboard)/app/inventory/consignment/credits-owed/page.tsx
//
// Credits Owed — App Router port of the legacy
// inventory/consignment/credits-owed. MANAGER + ADMIN only (mirrors the legacy
// withAuth(undefined, { roles: ["MANAGER", "ADMIN"] })). Reads the shared
// /api/consignment/credits-owed REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { CreditsOwedView } from "./CreditsOwedView";

export default async function CreditsOwedPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CreditsOwedView />;
}
