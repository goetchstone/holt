// /app/src/app/(dashboard)/app/sales/customers/email-list/page.tsx
//
// Customer email list (GAP-08): the customers who match a filter, as a CSV of
// emails (lib/customers/emailList.ts). A list of customers' emails leaves the
// building, so it needs "Run marketing", like the API behind it.

import { requirePage } from "@/lib/auth/requirePage";
import { EmailListView } from "./EmailListView";

export default async function EmailListPage() {
  await requirePage(undefined, { permission: "marketing.write" });
  return <EmailListView />;
}
