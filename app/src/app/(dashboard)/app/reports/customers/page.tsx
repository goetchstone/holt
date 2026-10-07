// /app/src/app/(dashboard)/app/reports/customers/page.tsx
//
// Customer Report — App Router + tRPC port. ADMIN/MARKETING. Filter-driven
// (search/group/pagination fetch via tRPC), so this server page just gates and
// renders the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CustomersReportView } from "./CustomersReportView";

export default async function CustomersReportPage() {
  await requirePage(["ADMIN", "MARKETING"]);
  return <CustomersReportView />;
}
