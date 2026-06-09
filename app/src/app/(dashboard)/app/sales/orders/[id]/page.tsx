// /app/src/app/(dashboard)/app/sales/orders/[id]/page.tsx
//
// Sales order detail (summary, status transitions, line-item management,
// invoices, payments, payment links, salesperson reassignment) -- App Router
// port. Any signed-in user (mirrors the legacy withAuth() with no roles). Reads
// + writes the shared /api/sales/orders/[id] REST endpoints, which stay REST. In
// Next 16 `params` is a Promise, so it must be awaited before reading id. Nested
// under the batch-A /sales/orders list -- distinct path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { OrderDetailView } from "./OrderDetailView";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <OrderDetailView id={id} />;
}
