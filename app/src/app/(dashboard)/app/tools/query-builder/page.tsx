// /app/src/app/(dashboard)/app/tools/query-builder/page.tsx
//
// Query Builder (ad-hoc reporting, GAP-34). Behind its own key, which a store can
// grant in Roles. Reads the shared /api/tools/query-builder REST endpoint. Chrome
// from the (dashboard) layout.

import { VIEW_COST, canViewCost } from "@/lib/auth/costVisibility";
import { requirePage } from "@/lib/auth/requirePage";
import { QueryBuilderView } from "./QueryBuilderView";

const EXPORT = "reporting.export";

export default async function QueryBuilderPage() {
  const access = await requirePage(undefined, {
    permission: "reporting.adhoc",
    also: [VIEW_COST, EXPORT],
  });
  return <QueryBuilderView canSeeCost={canViewCost(access)} canExport={access.holds[EXPORT]} />;
}
