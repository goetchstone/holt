// /app/src/app/(dashboard)/app/interactions/[id]/page.tsx
//
// Customer interaction detail -- App Router port. Any signed-in user (matches the
// legacy bare withAuth() gate). Reads the shared /api/interactions/[id] +
// /api/customers REST endpoints; those stay REST. In Next 16 `params` is a
// Promise, so it must be awaited before reading the dynamic id.

import { requirePage } from "@/lib/auth/requirePage";
import { InteractionDetailView } from "./InteractionDetailView";

export default async function InteractionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePage();
  return <InteractionDetailView id={id} />;
}
