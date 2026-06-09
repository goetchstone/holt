// /app/src/app/(dashboard)/app/sales/quotes/new/page.tsx
//
// New Quote builder — App Router port of the legacy sales/quotes/new. Any
// signed-in user (mirrors the legacy withAuth() with no roles). Reads + writes
// the shared sales/customer/warehouse REST endpoints, which stay REST. The view
// reads ?customerId= / ?interactionId= via useSearchParams, so it renders inside
// a Suspense boundary.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { NewQuoteView } from "./NewQuoteView";

export default async function NewQuotePage() {
  await requirePage();
  return (
    <Suspense fallback={null}>
      <NewQuoteView />
    </Suspense>
  );
}
