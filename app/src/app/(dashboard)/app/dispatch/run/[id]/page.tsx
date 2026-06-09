// /app/src/app/(dashboard)/app/dispatch/run/[id]/page.tsx
//
// Delivery run detail (stops, driver assignment, status progression, pick-list
// generation, add-stop) -- App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors
// the legacy withAuth roles). Reads the shared /api/dispatch/* + /api/staff REST
// endpoints, which stay REST. In Next 16 `params` is a Promise, so it must be
// awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { RunDetailView } from "./RunDetailView";

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <RunDetailView id={id} />;
}
