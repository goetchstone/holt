// /app/src/app/(dashboard)/app/purchasing/import-apparel/page.tsx
//
// Import Apparel PO -- App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors the
// legacy withAuth roles). Reads the shared /api/purchasing/preview-* +
// /api/purchasing/import-* + /api/departments + /api/categories REST endpoints,
// which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ImportApparelView } from "./ImportApparelView";

export default async function ImportApparelPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <ImportApparelView />;
}
