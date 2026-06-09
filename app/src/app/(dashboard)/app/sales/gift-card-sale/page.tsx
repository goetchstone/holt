// /app/src/app/(dashboard)/app/sales/gift-card-sale/page.tsx
//
// Gift card sale / activation register flow (quick code -> amount -> scan card
// barcode -> activate) -- App Router port of the legacy pages/sales/gift-card-sale.tsx.
// Any signed-in user (mirrors the legacy bare withAuth() with no roles/feature).
// Reads + writes the shared /api/gift-cards/* REST endpoints, which stay REST.
// The view reads the ?code= redirect param via useSearchParams, so it renders
// inside a Suspense boundary.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { GiftCardSaleView } from "./GiftCardSaleView";

export default async function GiftCardSalePage() {
  await requirePage(undefined, { feature: "giftCards" });
  return (
    <Suspense fallback={null}>
      <GiftCardSaleView />
    </Suspense>
  );
}
