// /app/src/app/(dashboard)/app/admin/cms/pages/[id]/page.tsx

import { requirePage } from "@/lib/auth/requirePage";
import { PageEditorView } from "../PageEditorView";

export default async function EditCmsPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage(undefined, { permission: "admin.settings", feature: "cms" });
  const { id } = await params;
  return <PageEditorView pageId={Number(id)} />;
}
