// /app/src/app/(dashboard)/app/sales/pos/page.tsx
//
// Point of Sale register (scan-to-cart, discounts, order creation, tender +
// payment recording) -- App Router port of the legacy pages/sales/pos.tsx. Any
// signed-in user (mirrors the legacy bare withAuth() with no roles/feature).
// Reads + writes the shared /api/* REST endpoints (registers, products,
// warehouse positions, gift-cards, tills, sales/orders cart + payments), which
// all stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { PosView } from "./PosView";

export default async function PosPage() {
  await requirePage(undefined, { feature: "pos" });
  return <PosView />;
}
