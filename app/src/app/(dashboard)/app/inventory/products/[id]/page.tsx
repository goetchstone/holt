// /app/src/app/(dashboard)/app/inventory/products/[id]/page.tsx
//
// Product detail (pricing, classification, physical attributes, barcodes,
// audit) — App Router port of the legacy inventory/products/[id]. Any signed-in
// user (mirrors the legacy bare withAuth(), no roles/feature). Reads the shared
// /api/products/:id REST endpoint, which stays REST. In Next 16 `params` is a
// Promise, so it must be awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { ProductDetailView } from "./ProductDetailView";

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <ProductDetailView id={id} />;
}
