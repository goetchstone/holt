// /app/src/app/(dashboard)/app/reports/mailchimp/page.tsx
//
// Mailchimp Campaign Impact — App Router port. Any signed-in user (matches the
// legacy bare withAuth() gate). Reads shared /api/mailchimp/* REST endpoints
// (also used by the admin mailchimp-sync surface), so those stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { MailchimpView } from "./MailchimpView";

export default async function MailchimpReportPage() {
  await requirePage();
  return <MailchimpView />;
}
