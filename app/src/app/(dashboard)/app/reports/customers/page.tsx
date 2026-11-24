// /app/src/app/(dashboard)/app/reports/customers/page.tsx
//
// Customer Report — App Router + tRPC port. "See customer lists". Filter-driven
// (search/group/pagination fetch via tRPC), so this server page just gates and
// renders the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CustomersReportView } from "./CustomersReportView";

export default async function CustomersReportPage() {
  await requirePage(undefined, { permission: "marketing.lists" });
  return <CustomersReportView />;
}
