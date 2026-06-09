// /app/src/app/(dashboard)/app/tools/create-project/page.tsx
//
// Create Project — App Router port. Any signed-in user (matches the legacy
// session-only gate). Posts to the shared /api/google/create-project REST
// endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CreateProjectView } from "./CreateProjectView";

export default async function CreateProjectPage() {
  await requirePage();
  return <CreateProjectView />;
}
