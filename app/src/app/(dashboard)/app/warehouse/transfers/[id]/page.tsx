// /app/src/app/(dashboard)/app/warehouse/transfers/[id]/page.tsx
//
// Transfer detail (summary + status transitions) -- App Router port. "Transfer
// stock" (inventory.transfer), the key of its routes, as Send and receive on a
// handheld (/app/scan/transfer) is. Reads the shared
// /api/warehouse/transfers/[id] REST endpoint, which stays REST. In Next 16
// `params` is a Promise, so it must be awaited before reading id. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TransferDetailView } from "./TransferDetailView";

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <TransferDetailView id={id} />;
}
