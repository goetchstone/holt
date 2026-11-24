// /app/src/app/(dashboard)/app/purchasing/import-order/page.tsx
//
// Import Wholesale Order (CSV or PDF) -- App Router port. Opens on "Receive
// stock" (purchasing.receive), the key of its PDF preview step, as Import
// Apparel PO does. The page shows no data of its own, and each step keeps its
// own gate: the /api/purchasing/preview-* routes (purchasing.receive), the
// NuORDER import (purchasing.write), the Z Supply and wholesale CSV imports
// (admin.data), and /api/departments and /api/categories (catalog.write).

import { requirePage } from "@/lib/auth/requirePage";
import { ImportOrderView } from "./ImportOrderView";

export default async function ImportOrderPage() {
  await requirePage(undefined, { permission: "purchasing.receive" });
  return <ImportOrderView />;
}
