// /app/src/app/(dashboard)/app/sales/returns/[id]/page.tsx
//
// Return detail — App Router port of the legacy sales/returns/[id]. Any signed-in
// user (mirrors the legacy withAuth() with no roles). Reads + writes the shared
// /api/returns/:id REST endpoints, which stay REST. In Next 16 `params` is a
// Promise, so it must be awaited before reading id. Nested under the batch-A
// /sales/returns list — distinct path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { ReturnDetailView } from "./ReturnDetailView";

export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <ReturnDetailView id={id} />;
}
