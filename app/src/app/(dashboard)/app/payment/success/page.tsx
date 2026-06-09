// /app/src/app/(dashboard)/app/payment/success/page.tsx
//
// Stripe-redirect success screen -- App Router port. Authed via requirePage
// (mirrors the legacy withAuth(), any signed-in user). Reads ?session_id= via
// useSearchParams in the client view, so the view is wrapped in Suspense.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { PaymentSuccessView } from "./PaymentSuccessView";

export default async function PaymentSuccessPage() {
  await requirePage();
  return (
    <Suspense fallback={null}>
      <PaymentSuccessView />
    </Suspense>
  );
}
