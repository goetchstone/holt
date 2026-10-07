// /app/src/app/portal/order/page.tsx
//
// Public, no-login customer order portal. Token-gated via ?token= (read in the
// client view). Lives OUTSIDE the (dashboard) route group so it gets the root
// layout only (Providers + branding) -- no staff nav, no auth gate. Wraps the
// view in Suspense because it reads useSearchParams.

import { Suspense } from "react";
import { PortalOrderView } from "./PortalOrderView";

export default function PortalOrderPage() {
  return (
    <Suspense fallback={null}>
      <PortalOrderView />
    </Suspense>
  );
}
