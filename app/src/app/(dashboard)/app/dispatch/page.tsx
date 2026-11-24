// /app/src/app/(dashboard)/app/dispatch/page.tsx
//
// Delivery dispatch board (drag-and-drop assignment of orders to truck runs) --
// App Router port. "Operate warehouse" (warehouse.operate), the key of every
// /api/dispatch route it calls. Reads the shared /api/dispatch/* REST
// endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { DispatchBoardView } from "./DispatchBoardView";

export default async function DispatchBoardPage() {
  await requirePage(undefined, { permission: "warehouse.operate" });
  return <DispatchBoardView />;
}
