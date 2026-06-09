// /app/src/app/(dashboard)/app/admin/gift-cards/[id]/page.tsx
//
// Gift Card detail -- App Router page-only port of the legacy
// admin/gift-cards/[id]. MANAGER / ADMIN (mirrors the legacy withAuth roles).
// Reads + writes the shared /api/gift-cards/[id] REST endpoints (reload, adjust,
// void), which stay REST. In Next 16 `params` is a Promise, so it must be awaited
// before reading id. Nested under the gift-cards list -- distinct path.

import { requirePage } from "@/lib/auth/requirePage";
import { GiftCardDetailView } from "./GiftCardDetailView";

export default async function GiftCardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(["MANAGER", "ADMIN"]);
  return <GiftCardDetailView id={id} />;
}
