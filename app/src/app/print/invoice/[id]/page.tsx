// /app/src/app/print/invoice/[id]/page.tsx
//
// Full-page invoice/quote print target (Letter) -- App Router port. Authed
// (mirrors the legacy withAuth(), any signed-in user) but rendered bare: it
// lives OUTSIDE the (dashboard) group so it gets the root layout only (no staff
// nav -- this page is meant to be printed). In Next 16 `params` is a Promise, so
// it must be awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { InvoicePrintView } from "./InvoicePrintView";

export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <InvoicePrintView id={id} />;
}
