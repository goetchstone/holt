// /app/src/app/(dashboard)/app/helpdesk/[id]/page.tsx
//
// Single-ticket workspace (staff). In Next 16 `params` is a Promise, so the
// dynamic id is awaited before rendering the client view.

import { requirePage } from "@/lib/auth/requirePage";
import { TicketDetailView } from "./TicketDetailView";

export default async function TicketPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  await requirePage(["SUPER_ADMIN", "ADMIN", "MANAGER"], { feature: "helpdesk" });
  const { id } = await params;
  return <TicketDetailView ticketId={Number(id)} />;
}
