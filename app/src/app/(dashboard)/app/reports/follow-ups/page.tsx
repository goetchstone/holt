// /app/src/app/(dashboard)/app/reports/follow-ups/page.tsx
//
// Follow-Ups (GAP-36): every client's next follow-up across the team
// (lib/followUpReportQuery.ts). For whoever manages client books; the view reads it over tRPC.

import { requirePage } from "@/lib/auth/requirePage";
import { FollowUpsView } from "./FollowUpsView";

export default async function FollowUpsPage() {
  await requirePage(undefined, { permission: "sales.clients.manage" });
  return <FollowUpsView />;
}
