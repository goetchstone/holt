// /app/src/app/(dashboard)/app/reports/dormant-customers/page.tsx
//
// Dormant Customer Winback — App Router + tRPC port. "View management reports"
// (customers' contact details and spend), filter-driven (data fetches via tRPC
// on "Run Report"), so this server page just gates and renders the client
// view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DormantCustomersView } from "./DormantCustomersView";

export default async function DormantCustomersPage() {
  await requirePage(undefined, { permission: "reporting.management" });
  return <DormantCustomersView />;
}
