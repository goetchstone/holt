// /app/src/app/(dashboard)/app/inventory/products/create-variant/page.tsx
//
// Simple Variant Product Entry — App Router port of the legacy
// inventory/products/create-variant. Any signed-in user (mirrors the legacy
// bare withAuth(), no roles/feature). Reads + writes the shared
// /api/products/:id/variants REST endpoints, which stay REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CreateVariantView } from "./CreateVariantView";

export default async function CreateVariantPage() {
  await requirePage();
  return <CreateVariantView />;
}
