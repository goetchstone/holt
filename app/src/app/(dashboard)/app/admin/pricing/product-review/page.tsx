// /app/src/app/(dashboard)/app/admin/pricing/product-review/page.tsx
//
// Product Review -- App Router port of the legacy admin/pricing/product-review.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Visual card/list review
// of imported product data for spotting bad image assignments and style names,
// with inline name edits + image upload against the shared /api/pricing/* and
// /api/vendors REST endpoints, which stay REST. Chrome from the (dashboard)
// layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ProductReviewView } from "./ProductReviewView";

export default async function PricingProductReviewPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <ProductReviewView />;
}
