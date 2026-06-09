// /app/src/app/(dashboard)/app/admin/email/page.tsx
//
// Admin email viewer (ADMIN). Email is infrastructure, not a toggleable module,
// so there's no feature gate -- sending simply no-ops until SMTP is configured
// in Settings -> Integrations.

import { requirePage } from "@/lib/auth/requirePage";
import { EmailQueueView } from "./EmailQueueView";

export default async function EmailPage() {
  await requirePage(["SUPER_ADMIN", "ADMIN"]);
  return <EmailQueueView />;
}
