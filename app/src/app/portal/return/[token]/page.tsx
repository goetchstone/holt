// /app/src/app/portal/return/[token]/page.tsx
//
// Public, no-login return-request portal. Token-gated via the [token] route
// segment. Lives OUTSIDE the (dashboard) group so it gets the root layout only
// (Providers + branding) -- no staff nav, no auth gate. In Next 16 `params` is a
// Promise, so it must be awaited before reading token.

import { ReturnRequestView } from "./ReturnRequestView";

export default async function ReturnRequestPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ReturnRequestView token={token} />;
}
