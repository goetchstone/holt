// /app/src/app/(dashboard)/app/inventory/categories/page.tsx
//
// Product Categories taxonomy list — App Router port of the legacy
// inventory/categories/index. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). Reads the shared /api/categories REST
// endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CategoriesView } from "./CategoriesView";

export default async function CategoriesPage() {
  await requirePage();
  return <CategoriesView />;
}
