// /app/src/app/(dashboard)/app/sales/clients/page.tsx
//
// My Clients (GAP-36): the client book. Everyone who works the pipeline has one. The
// API decides whose it shows (lib/clientBookQuery.ts); the pipeline's All Staff page
// links here with ?staff=unassigned for the clients no one owns.

import { requirePage } from "@/lib/auth/requirePage";
import { UNASSIGNED_STAFF_ID } from "@/lib/clientBook";
import { ClientsView } from "./ClientsView";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ staff?: string }>;
}) {
  await requirePage(undefined, { permission: "sales.lead" });
  const { staff } = await searchParams;
  return <ClientsView linkedBook={staff === UNASSIGNED_STAFF_ID ? UNASSIGNED_STAFF_ID : null} />;
}
