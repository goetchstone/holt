// /app/src/app/(dashboard)/app/dispatch/run/[id]/page.tsx
//
// Delivery run detail (stops, driver assignment, status progression, pick-list
// generation, add-stop) -- App Router port. "Operate warehouse"
// (warehouse.operate), the key of every /api/dispatch route it calls. Reads the
// shared /api/dispatch/* REST endpoints, and /api/staff for the driver picker,
// which stay REST. In Next 16 `params` is a Promise, so it must be awaited
// before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { RunDetailView } from "./RunDetailView";

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(undefined, { permission: "warehouse.operate" });
  return <RunDetailView id={id} />;
}
