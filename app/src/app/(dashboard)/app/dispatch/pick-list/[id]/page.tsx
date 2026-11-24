// /app/src/app/(dashboard)/app/dispatch/pick-list/[id]/page.tsx
//
// Pick list detail (warehouse pick view, items grouped by location, printable) --
// App Router port. "Operate warehouse" (warehouse.operate), the key of the
// pick-list routes it reads and ticks, as Pick on a handheld (/app/scan/pick)
// is. Reads the shared /api/dispatch/pick-lists/* REST endpoints, which stay
// REST. In Next 16 `params` is a Promise, so it must be awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { PickListView } from "./PickListView";

export default async function PickListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(undefined, { permission: "warehouse.operate" });
  return <PickListView id={id} />;
}
