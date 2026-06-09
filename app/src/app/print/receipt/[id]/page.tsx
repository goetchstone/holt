// /app/src/app/print/receipt/[id]/page.tsx
//
// Thermal receipt print target -- App Router port. Authed (mirrors the legacy
// withAuth(), any signed-in user) but rendered bare: it lives OUTSIDE the
// (dashboard) group so it gets the root layout only (no staff nav -- this page
// is meant to be printed). In Next 16 `params` is a Promise, so it must be
// awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { ReceiptPrintView } from "./ReceiptPrintView";

export default async function ReceiptPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <ReceiptPrintView id={id} />;
}
