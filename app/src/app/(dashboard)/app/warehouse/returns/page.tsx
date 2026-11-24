// /app/src/app/(dashboard)/app/warehouse/returns/page.tsx
//
// Returns queue (pickup / inspection / decision tabs) and returned stock (put
// back or write off) -- App Router port. "Take returns" (sales.return), the key
// of the queue and its status actions; the returned-stock routes also admit
// "Transfer stock". Reads the shared /api/warehouse/returns/* +
// /api/returns/[id]/* REST endpoints, which stay REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ReturnsQueueView } from "./ReturnsQueueView";

export default async function ReturnsQueuePage() {
  await requirePage(undefined, { permission: "sales.return" });
  return <ReturnsQueueView />;
}
