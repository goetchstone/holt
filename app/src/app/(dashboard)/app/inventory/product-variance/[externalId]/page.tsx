// /app/src/app/(dashboard)/app/inventory/product-variance/[externalId]/page.tsx
//
// Product Variance Details — App Router page. Any signed-in user (bare withAuth,
// no roles/feature). The view also reads ?location= / ?returnUrl= via
// useSearchParams, so it renders inside a Suspense boundary. Reads the shared
// /api/inventory/product-variance/[externalId] REST endpoint, which stays REST.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { ProductVarianceView } from "./ProductVarianceView";

export default async function ProductVariancePage({
  params,
}: {
  params: Promise<{ externalId: string }>;
}) {
  await requirePage();
  const { externalId } = await params;
  return (
    <Suspense fallback={null}>
      <ProductVarianceView externalId={externalId} />
    </Suspense>
  );
}
