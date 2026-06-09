// /app/src/app/(dashboard)/app/inventory/consignment/[id]/page.tsx
//
// Consignment item detail — App Router port of the legacy
// inventory/consignment/[id]. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). Reads + mutates the shared
// /api/consignment/items/:id REST endpoints, which stay REST. In Next 16
// `params` is a Promise, so it must be awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { ConsignmentDetailView } from "./ConsignmentDetailView";

export default async function ConsignmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePage();
  return <ConsignmentDetailView id={id} />;
}
