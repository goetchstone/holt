// /app/src/app/(dashboard)/app/admin/automations/mailchimp-sync/page.tsx
//
// Mailchimp Sync Automation -- App Router port of the legacy
// admin/automations/mailchimp-sync. MANAGER / ADMIN (mirrors the legacy
// withAuth roles). The "Run All" + per-phase + backfill + customer-sync
// buttons POST to the shared /api/automations/* and /api/mailchimp/* REST
// endpoints, which stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { MailchimpSyncView } from "./MailchimpSyncView";

export default async function MailchimpSyncAdminPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <MailchimpSyncView />;
}
