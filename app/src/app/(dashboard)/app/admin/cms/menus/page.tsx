// /app/src/app/(dashboard)/app/admin/cms/menus/page.tsx

import { requirePage } from "@/lib/auth/requirePage";
import { MenusEditorView } from "./MenusEditorView";

export default async function CmsMenusPage() {
  await requirePage(undefined, { permission: "admin.settings", feature: "cms" });
  return <MenusEditorView />;
}
