// /app/src/app/(dashboard)/app/helpdesk/[id]/page.tsx
//
// Single-ticket workspace (staff). In Next 16 `params` is a Promise, so the
// dynamic id is awaited before rendering the client view. Opens on "View
// service" (service.read), the key of the Helpdesk nav entry and of the queue
// page that links here; replying, attaching a file and triage are "Work
// service" (service.write) at their routes.

import { requirePage } from "@/lib/auth/requirePage";
import { TicketDetailView } from "./TicketDetailView";

export default async function TicketPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  await requirePage(undefined, { permission: "service.read", feature: "helpdesk" });
  const { id } = await params;
  return <TicketDetailView ticketId={Number(id)} />;
}
