// /app/src/app/(dashboard)/app/reports/mailchimp/activity/page.tsx
//
// Mailchimp Activity Log — App Router port. Any signed-in user (matches the
// legacy bare withAuth() gate). Reads shared /api/mailchimp/* REST endpoints
// (also used by the admin mailchimp-sync surface).

import { requirePage } from "@/lib/auth/requirePage";
import { MailchimpActivityView } from "./MailchimpActivityView";

export default async function MailchimpActivityPage() {
  await requirePage();
  return <MailchimpActivityView />;
}
