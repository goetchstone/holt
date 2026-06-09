// /app/src/app/(dashboard)/app/tools/query-builder/page.tsx
//
// Query Builder — App Router port. ADMIN only (matches the legacy
// withAuth roles). Reads the shared /api/tools/query-builder REST endpoint.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { QueryBuilderView } from "./QueryBuilderView";

export default async function QueryBuilderPage() {
  await requirePage(["ADMIN"]);
  return <QueryBuilderView />;
}
