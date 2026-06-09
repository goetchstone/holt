// /app/src/app/(dashboard)/app/sales/returns/new/page.tsx
//
// Initiate Return wizard — App Router port of the legacy sales/returns/new. Any
// signed-in user (mirrors the legacy withAuth() with no roles). Reads + writes
// the shared /api/sales/orders + /api/returns REST endpoints, which stay REST.
// The view reads ?orderId= via useSearchParams, so it renders inside a Suspense
// boundary. Nested under the batch-A /sales/returns list — distinct path, no
// collision.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { NewReturnView } from "./NewReturnView";

export default async function NewReturnPage() {
  await requirePage();
  return (
    <Suspense fallback={null}>
      <NewReturnView />
    </Suspense>
  );
}
