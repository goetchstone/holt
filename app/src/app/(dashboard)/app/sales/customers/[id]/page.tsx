// /app/src/app/(dashboard)/app/sales/customers/[id]/page.tsx
//
// Customer detail (summary, lifetime stats, lead score, wealth profile, trade
// program, addresses, orders, email activity) -- App Router port. Any signed-in
// user (mirrors the legacy withAuth() with no roles); wealth UI stays role-gated
// client-side via useEffectiveRole. Reads + writes the shared /api/customers/:id
// REST endpoints, which stay REST. In Next 16 `params` is a Promise, so it must
// be awaited before reading id. Nested under the batch-A /sales/customers list --
// distinct path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { CustomerDetailView } from "./CustomerDetailView";

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const { holds } = await requirePage(undefined, {
    permission: "sales.read",
    also: ["sales.lead", "customer.write"],
  });
  const canSeeClientNotes = holds["sales.lead"] || holds["customer.write"];
  return (
    <CustomerDetailView
      id={id}
      canWorkClient={holds["sales.lead"]}
      canSeeClientNotes={canSeeClientNotes}
      openOnNotes={canSeeClientNotes && tab === "notes"}
    />
  );
}
