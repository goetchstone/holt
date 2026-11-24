// /app/src/app/(dashboard)/app/reports/opportunities/page.tsx
//
// Opportunities hub — App Router + tRPC port. "See customer lists", as its
// procedures are. The tiles built from wealth data, and the wealth column, also
// need "See wealth data", which the procedures answer and apply
// (lib/reports/opportunities.ts), so this page asks for nothing more. Tile
// counts + drilldown via tRPC; "mark as sent" stays a REST POST mutation.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { OpportunitiesView } from "./OpportunitiesView";

export default async function OpportunitiesPage() {
  await requirePage(undefined, { permission: "marketing.lists" });
  return <OpportunitiesView />;
}
