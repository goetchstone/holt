// /app/src/app/(dashboard)/app/inventory/products/[id]/page.tsx
//
// Product detail (pricing, classification, other vendors, physical
// attributes, barcodes, audit) — App Router port of the legacy
// inventory/products/[id]. Reads the shared /api/products/:id REST endpoint,
// which stays REST. Whoever reads the catalog sees it; whoever edits it
// (catalog.write) also changes the item's other vendors (GAP-22). In Next 16
// `params` is a Promise, so it must be awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { ProductDetailView } from "./ProductDetailView";

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { holds } = await requirePage(undefined, {
    permission: "catalog.read",
    also: ["catalog.write"],
  });
  return <ProductDetailView id={id} canEdit={holds["catalog.write"]} />;
}
