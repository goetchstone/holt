// /app/src/app/(dashboard)/app/admin/cms/pages/page.tsx

import { requirePage } from "@/lib/auth/requirePage";
import { PagesListView } from "./PagesListView";

export default async function CmsPagesPage() {
  await requirePage(undefined, { permission: "admin.settings", feature: "cms" });
  return <PagesListView />;
}
