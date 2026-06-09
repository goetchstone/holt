// /app/src/app/(dashboard)/app/sales/till/[id]/page.tsx
//
// Till detail (staff/timing, financials, denomination counts, payments,
// manager reconcile) -- App Router port of the legacy sales/till/[id]. Any
// signed-in user (mirrors the legacy withAuth() with no roles); the reconcile
// action is gated client-side to MANAGER/ADMIN/SUPER_ADMIN exactly as before.
// Reads + writes the shared /api/tills/:id REST endpoints, which stay REST. In
// Next 16 `params` is a Promise, so it must be awaited before reading id.
// Nested under the /sales/till list -- distinct path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { TillDetailView } from "./TillDetailView";

export default async function TillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <TillDetailView id={id} />;
}
