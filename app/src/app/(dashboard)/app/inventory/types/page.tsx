// /app/src/app/(dashboard)/app/inventory/types/page.tsx
//
// Product Types taxonomy list — App Router port of the legacy
// inventory/types/index. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). Reads the shared /api/types REST endpoint.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TypesView } from "./TypesView";

export default async function TypesPage() {
  await requirePage();
  return <TypesView />;
}
