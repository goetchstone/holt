// /app/src/app/(dashboard)/app/admin/setup/labels/page.tsx
//
// Label Templates -- App Router port of the legacy admin/setup/labels/index. Any
// signed-in user (mirrors the legacy bare withAuth(), no roles/feature). Reads
// the shared /api/labels REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { LabelTemplatesView } from "./LabelTemplatesView";

export default async function LabelTemplatesPage() {
  await requirePage();
  return <LabelTemplatesView />;
}
