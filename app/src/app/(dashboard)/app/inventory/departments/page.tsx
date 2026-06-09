// /app/src/app/(dashboard)/app/inventory/departments/page.tsx
//
// Departments taxonomy list — App Router port of the legacy
// inventory/departments/index. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). Reads the shared /api/departments REST
// endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DepartmentsView } from "./DepartmentsView";

export default async function DepartmentsPage() {
  await requirePage();
  return <DepartmentsView />;
}
