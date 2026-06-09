// /app/src/app/(dashboard)/app/admin/cms/pages/page.tsx

import { requirePage } from "@/lib/auth/requirePage";
import { PagesListView } from "./PagesListView";

export default async function CmsPagesPage() {
  await requirePage(["ADMIN"], { feature: "cms" });
  return <PagesListView />;
}
