// /app/src/app/(dashboard)/app/sales/proposals/[id]/page.tsx
//
// B2B Proposal editor — App Router port of the legacy sales/proposals/[id].
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads + writes the shared
// /api/proposals/:id REST endpoints, which stay REST. In Next 16 `params` is a
// Promise, so it must be awaited before reading id. Nested under the batch-A
// /sales/proposals list — distinct path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { ProposalDetailView } from "./ProposalDetailView";

export default async function ProposalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(["MANAGER", "ADMIN"]);
  return <ProposalDetailView id={id} />;
}
