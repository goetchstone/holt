// /app/src/app/(dashboard)/app/inventory/products/create-basic/page.tsx
//
// Create Basic Item — App Router port of the legacy
// inventory/products/create-basic. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). Reads the shared /api/vendors, /api/departments,
// /api/categories, /api/types/by-category + writes /api/products/basic REST
// endpoints, which stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CreateBasicView } from "./CreateBasicView";

export default async function CreateBasicPage() {
  await requirePage();
  return <CreateBasicView />;
}
