// /app/src/app/(dashboard)/app/admin/cms/pages/new/page.tsx

import { requirePage } from "@/lib/auth/requirePage";
import { PageEditorView } from "../PageEditorView";

export default async function NewCmsPage() {
  await requirePage(["ADMIN"], { feature: "cms" });
  return <PageEditorView pageId={null} />;
}
