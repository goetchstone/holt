// /app/src/app/(dashboard)/app/payment/cancel/page.tsx
//
// Stripe-redirect cancel screen -- App Router port. Authed via requirePage
// (mirrors the legacy withAuth(), any signed-in user). The view is static (no
// query params), so no Suspense is needed.

import { requirePage } from "@/lib/auth/requirePage";
import { PaymentCancelView } from "./PaymentCancelView";

export default async function PaymentCancelPage() {
  await requirePage();
  return <PaymentCancelView />;
}
