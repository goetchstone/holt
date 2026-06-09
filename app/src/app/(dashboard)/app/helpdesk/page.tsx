// /app/src/app/(dashboard)/app/helpdesk/page.tsx
//
// Helpdesk queue (staff). Gated behind the "helpdesk" feature; visible to
// ADMIN/MANAGER (SUPER_ADMIN inherits). All data work happens client-side over
// the /api/tickets REST endpoints.

import { requirePage } from "@/lib/auth/requirePage";
import { HelpdeskQueueView } from "./HelpdeskQueueView";

export default async function HelpdeskPage() {
  await requirePage(["SUPER_ADMIN", "ADMIN", "MANAGER"], { feature: "helpdesk" });
  return <HelpdeskQueueView />;
}
