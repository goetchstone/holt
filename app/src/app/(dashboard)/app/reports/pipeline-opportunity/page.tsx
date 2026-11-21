// /app/src/app/(dashboard)/app/reports/pipeline-opportunity/page.tsx
//
// Pipeline Opportunity report — App Router + tRPC port. "View management
// reports", as its procedures are. List + per-salesperson drilldown via tRPC; the
// reassign action + interaction logging stay REST POST mutations. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { PipelineOpportunityView } from "./PipelineOpportunityView";

export default async function PipelineOpportunityPage() {
  await requirePage(undefined, { permission: "reporting.management" });
  return <PipelineOpportunityView />;
}
