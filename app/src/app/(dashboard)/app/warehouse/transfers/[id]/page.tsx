// /app/src/app/(dashboard)/app/warehouse/transfers/[id]/page.tsx
//
// Transfer detail (summary + status transitions) -- App Router port. MANAGER /
// ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads the shared
// /api/warehouse/transfers/[id] REST endpoint, which stays REST. In Next 16
// `params` is a Promise, so it must be awaited before reading id. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TransferDetailView } from "./TransferDetailView";

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <TransferDetailView id={id} />;
}
