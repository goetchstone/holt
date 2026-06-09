// /app/src/app/(dashboard)/app/admin/setup/email-templates/page.tsx
//
// Email Templates -- App Router port of the legacy admin/setup/email-templates.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/service/email-templates REST endpoint. Chrome from the (dashboard)
// layout.

import { requirePage } from "@/lib/auth/requirePage";
import { EmailTemplatesView } from "./EmailTemplatesView";

export default async function EmailTemplatesPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <EmailTemplatesView />;
}
