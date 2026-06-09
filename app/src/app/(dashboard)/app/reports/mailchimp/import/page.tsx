// /app/src/app/(dashboard)/app/reports/mailchimp/import/page.tsx
//
// Import Mailchimp Campaigns — App Router port. Any signed-in user (matches the
// legacy bare withAuth() gate). Reads the shared /api/mailchimp/campaigns/db
// REST endpoint (also used by the admin mailchimp-sync surface).

import { requirePage } from "@/lib/auth/requirePage";
import { MailchimpImportView } from "./MailchimpImportView";

export default async function MailchimpImportPage() {
  await requirePage();
  return <MailchimpImportView />;
}
