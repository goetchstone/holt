// /app/src/app/portal/return/status/[token]/page.tsx
//
// Public, no-login return-status tracker. Token-gated via the [token] route
// segment. Lives OUTSIDE the (dashboard) group so it gets the root layout only
// (Providers + branding) -- no staff nav, no auth gate. In Next 16 `params` is a
// Promise, so it must be awaited before reading token.

import { ReturnStatusView } from "./ReturnStatusView";

export default async function ReturnStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ReturnStatusView token={token} />;
}
