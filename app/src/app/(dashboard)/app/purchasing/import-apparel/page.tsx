// /app/src/app/(dashboard)/app/purchasing/import-apparel/page.tsx
//
// Import Apparel PO -- App Router port. Opens on "Receive stock"
// (purchasing.receive), the key of its preview step, as Import Order does. The
// page shows no data of its own, and each step keeps its own gate: the
// /api/purchasing/preview-* routes (purchasing.receive), the NuORDER import
// (purchasing.write), the Z Supply import (admin.data), and /api/departments
// and /api/categories (catalog.write).

import { requirePage } from "@/lib/auth/requirePage";
import { ImportApparelView } from "./ImportApparelView";

export default async function ImportApparelPage() {
  await requirePage(undefined, { permission: "purchasing.receive" });
  return <ImportApparelView />;
}
