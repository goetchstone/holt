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

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <CustomerDetailView id={id} />;
}
